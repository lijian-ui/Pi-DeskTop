/**
 * IM gateway — channel registry + lifecycle + message routing.
 *
 * Channel-independent: session mapping → Pi prompt entry → reply routing via
 * the Pi event stream. Each enabled channel instance is an ImChannelAdapter
 * (DingTalk now; WeChat/QQ/Feishu later) registered here. The same channel
 * type may have MULTIPLE instances (several robots), isolated by instanceId in
 * both status and session keys.
 */
import type { PiDeskSessionManager } from "../pi/session-manager";
import type { ImChannelAdapter, ImInboundMessage, ImStatus } from "./types";
import type { ImConfig, ImChannelInstance } from "./im-config";
import { readImConfig } from "./im-config";
import { ImSessionMap, IM_CHAT_SUBDIR, readSessionCwd } from "./im-session-map";
import { DingtalkAdapter } from "./dingtalk/dingtalk-adapter";
import { WeixinAdapter } from "./weixin/weixin-adapter";
import { QqAdapter } from "./qq/qq-adapter";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Split "/name args" → { name, args }. Multi-slash tolerated. */
function parseCommand(text: string): { name: string; args: string } | null {
  const m = /^\s*\/+([a-z][\w-]*)(?:\s+(.*))?$/i.exec(text.trim());
  if (!m) return null;
  return { name: m[1], args: (m[2] ?? "").trim() };
}

/** Which args field carries the human-relevant payload per tool name. */
const TOOL_ARG_KEY: Record<string, string> = {
  read_file: "path",
  write_file: "path",
  edit_file: "path",
  list_files: "path",
  delete_file: "path",
  bash: "command",
  command: "command",
  run_command: "command",
  run_shell: "command",
  grep: "pattern",
  search: "pattern",
  glob: "pattern",
  find: "pattern",
  web_fetch: "url",
  web_search: "query",
};

/**
 * Human-readable tool call for the card progress line, e.g.
 * `read_file E:/Project/pi-desktop/README.md` or `bash npm run build`.
 * Falls back to the first non-object arg, then the bare tool name.
 */
function formatToolCall(toolName: string, args: unknown): string {
  let argObj: Record<string, unknown> = {};
  if (args && typeof args === "object" && !Array.isArray(args)) {
    argObj = args as Record<string, unknown>;
  } else if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === "object") argObj = parsed;
    } catch {
      /* keep empty */
    }
  }
  const key = TOOL_ARG_KEY[toolName];
  const raw = key ? argObj[key] : undefined;
  if (raw !== undefined && raw !== null && typeof raw !== "object") {
    return `${toolName} ${String(raw)}`;
  }
  for (const v of Object.values(argObj)) {
    if (v !== undefined && v !== null && typeof v !== "object") {
      return `${toolName} ${String(v)}`;
    }
  }
  return toolName;
}

/** /help reply — the command list shown in the IM channel. */
const HELP_TEXT = [
  "🤖 可用命令：",
  "- /model —— 查看可用模型列表",
  "- /model <名称> —— 切换当前会话的模型",
  "- /status —— 查看当前会话的工作目录与模型",
  "- /compact —— 压缩上下文（减少 token 占用）",
  "- /allow <ID> / /deny <ID> —— 允许 / 拒绝命令审批",
  "- /stop —— 停止当前正在运行的任务（含正在执行的命令）",
  "- /reset /clear /new —— 开启新会话",
  "其他内容将直接发送给 AI 处理。",
].join("\n");

/**
 * Minimum interval between streaming card updates. DingTalk's AI-card
 * streaming endpoint caps each frame at ~1K and total content at ~3K, and
 * truncates with "***" when exceeded — so we must NOT push every text_delta.
 * We coalesce deltas and flush at this cadence (mirrors the reference
 * connector's 800ms throttle).
 */
const STREAM_THROTTLE_MS = 800;
/** Hard per-frame cap — flush early when the accumulated text exceeds it. */
const STREAM_FRAME_MAX = 1000;

/** One queued inbound message for a session's serial processing queue. */
interface QueuedInbound {
  adapter: ImChannelAdapter;
  text: string;
  images?: any[];
  peer: string;
  sessionPath: string;
  effectiveCwd: string;
  /** Sender nickname (DingTalk senderNick) — used for the fake @ prefix. */
  senderNick?: string;
  /** True when the message came from a group chat. */
  isGroup?: boolean;
}

/** Extract final assistant text from a message_end payload. */
function extractMessageText(message: any): string {
  if (!message) return "";
  const c = message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((block: any) => (typeof block?.text === "string" ? block.text : ""))
      .join("");
  }
  return "";
}

/**
 * Friendly provider name for the /model list — mirrors the desktop Models
 * page (LOCAL_PROVIDER_NAMES). Also guards against dirty configs where the
 * provider's `name` accidentally equals one of its own model ids (the model
 * name was typed into the provider-name slot): such a name is meaningless
 * as a brand, so fall back to the provider id.
 */
function providerDisplayName(p: {
  id: string;
  name: string;
  models: { id: string }[];
}): string {
  const brand: Record<string, string> = {
    "lm-studio": "LM Studio",
    ollama: "Ollama",
  };
  if (brand[p.id]) return brand[p.id];
  if (p.models.some((m) => m.id === p.name)) return p.id;
  return p.name;
}

/** sessionKey = `${channel}:${instanceId}:${peer}` */
function parseSessionKey(
  sessionKey: string,
): { channel: string; instanceId: string; peer: string } {
  const [channel = "", instanceId = "", ...peerParts] = sessionKey.split(":");
  return { channel, instanceId, peer: peerParts.join(":") };
}

export class ImGateway {
  private adapters: ImChannelAdapter[] = [];
  private statusMap: Record<string, ImStatus> = {};
  private statusListeners: Array<(s: Record<string, ImStatus>) => void> = [];
  private pending = new Map<
    string,
    {
      adapter: ImChannelAdapter;
      target: string;
      accumulated?: string;
      /** last time streamText was actually sent (for throttling). */
      lastStreamAt?: number;
      /** beginStream already called for this reply cycle. */
      streamStarted?: boolean;
      /** Sender nickname — fake @ prefix on the final reply (groups only). */
      senderNick?: string;
      isGroup?: boolean;
    }
  >();
  /**
   * Serial FIFO queue per session. Group chats share one session, so
   * concurrent messages must be answered in arrival order (A → B → C) —
   * never interleaved. A queue with exactly one item is the one currently
   * being processed (drained by drainQueue).
   */
  private queues = new Map<string, QueuedInbound[]>();
  private sessionMap: ImSessionMap;
  private channels: ImChannelInstance[] = [];
  /** cwd → most recent peer (target) for channel approval messages. */
  private lastPeerByCwd = new Map<string, string>();
  /** cwd → instanceId for approval channels (to find the adapter). */
  private approvalCwdInfo = new Map<string, { channel: string; instanceId: string }>();
  /** instanceId → most recent peer — used for task-completion pushes. */
  private lastPeerByInstanceId = new Map<string, string>();

  constructor(private piManager: PiDeskSessionManager) {
    this.sessionMap = new ImSessionMap(piManager);
    // Channel-level bash approval: the session-manager asks us to surface the
    // confirmation on the channel; the user replies /allow /deny.
    this.piManager.onChannelApprovalRequest = (cwd, requestId, command) => {
      this.sendApprovalRequest(cwd, requestId, command);
    };
    // Scheduled-task completion push: session-manager asks us to deliver the
    // run result to an IM channel's most recent active peer.
    this.piManager.onImPushRequest = (instanceId, text) => {
      const adapter = this.adapterFor(instanceId);
      const peer = this.lastPeerByInstanceId.get(instanceId);
      if (!adapter || !peer) {
        console.warn(
          `[im] push skipped: instance=${instanceId} adapter=${!!adapter} peer=${peer ?? "✗"}`,
        );
        return;
      }
      void adapter.sendText(peer, text).catch((err) => {
        console.warn(`[im] push failed:`, err);
      });
    };
  }

  /** Load persisted session map + bind the event forwarder hook. */
  async init(): Promise<void> {
    await this.sessionMap.load();
    // session-manager forwards IM-session events here (returns true = consumed,
    // do NOT broadcast to the desktop UI).
    this.piManager.imForwarder = (sessionPath, event) => {
      return this.handlePiEvent(sessionPath, event as any);
    };
  }

  /** Unregister every channel-approval cwd from the session manager. */
  private clearApprovalRegistrations(): void {
    for (const cwd of this.approvalCwdInfo.keys()) {
      this.piManager.setApprovalChannel(cwd, null);
    }
    this.approvalCwdInfo.clear();
    this.lastPeerByCwd.clear();
  }

  /**
   * Send a channel-approval confirm request to the peer that owns the cwd.
   * QQ gets inline buttons (click to allow/deny); other channels fall back
   * to a plain-text /allow /deny message. Auto-denies via the session
   * manager's timeout if no peer is known yet.
   */
  private sendApprovalRequest(cwd: string, requestId: number, command: string): void {
    const info = this.approvalCwdInfo.get(cwd);
    const peer = this.lastPeerByCwd.get(cwd);
    console.warn(
      `[im] approval request id=${requestId} cwd=${cwd} info=${info ? "✓" : "✗"} peer=${peer ?? "✗"}`,
    );
    if (!info || !peer) return;
    const adapter = this.adapterFor(info.instanceId);
    if (!adapter) return;
    const shortCmd = command.length > 200 ? `${command.slice(0, 200)}…` : command;
    const text = `🔐 需要您确认执行 bash 命令（ID: ${requestId}）：\n\`\`\`\n${shortCmd}\n\`\`\``;
    if (adapter.sendKeyboard) {
      void adapter
        .sendKeyboard(peer, text, [
          { id: `allow:${requestId}`, label: "✅ 允许", style: 1 },
          { id: `allow_whitelist:${requestId}`, label: "🔁 允许并记住", style: 1 },
          { id: `deny:${requestId}`, label: "⛔ 拒绝", style: 2 },
          { id: `allow_session:${requestId}`, label: "本次会话允许", style: 1 },
        ])
        .catch((err) => console.warn(`[im] approval keyboard failed:`, err));
      return;
    }
    void adapter
      .sendText(
        peer,
        `${text}\n回复 \`/allow\`（或 \`/allow ${requestId}\`）允许 ｜ \`/deny\` 拒绝 ｜ \`/allow_session\` 本次会话始终允许`,
      )
      .catch((err) => console.warn(`[im] approval notify failed:`, err));
  }

  /** Button-click approval (QQ inline keyboard). Button id = "decision:id". */
  private handleApprovalInteraction(adapter: ImChannelAdapter, buttonId: string, userId?: string): void {
    const m = /^(allow|allow_whitelist|deny|allow_session):(\d+)$/.exec(buttonId);
    if (!m) return;
    const decision =
      m[1] === "allow_whitelist"
        ? "allow-whitelist"
        : (m[1] as "allow" | "deny" | "allow-session");
    const requestId = Number(m[2]);
    const ok = this.piManager.handleBashApprovalResponse({ requestId, decision });
    // Notify the clicker (QQ c2c openid) about the outcome.
    if (userId) {
      void adapter
        .sendText(
          `c2c:${userId}`,
          ok
            ? decision === "deny"
              ? "❌ 已拒绝"
              : decision === "allow-whitelist"
                ? "✅ 已允许并加入白名单"
                : "✅ 已允许"
            : "❌ 审批已过期或不存在",
        )
        .catch(() => {});
    }
  }

  /** (Re)build adapters from config: stop all, then start enabled channels. */
  async applyConfig(cfg: ImConfig): Promise<void> {
    await this.stopAll();
    this.channels = cfg.channels ?? [];
    this.pending.clear();
    this.clearApprovalRegistrations();

    for (const inst of this.channels) {
      if (!inst.enabled) continue;
      if (!this.hasValidConfig(inst)) {
        console.warn(`[im] instance ${inst.name} (${inst.id}) missing credentials — skipped`);
        continue;
      }
      // Channel opted into command approval → register its default cwd
      // (per-message dynamic registration below also covers migrated
      // sessions whose cwd differs).
      if (inst.config?.approval === "on") {
        const cwd = inst.cwd ?? join(getAgentDir(), "chat", IM_CHAT_SUBDIR, inst.type);
        this.approvalCwdInfo.set(cwd, { channel: inst.type, instanceId: inst.id });
        this.piManager.setApprovalChannel(cwd, { channel: inst.type, instanceId: inst.id });
      }
      const adapter = this.createAdapter(inst);
      if (!adapter) continue;
      this.register(adapter);
      await adapter.start().catch((err) => {
        console.error(`[im:${inst.type}] start failed:`, err?.message);
        this.setChannelStatus(adapter.instanceId, "error");
      });
    }
    this.broadcastStatus();
  }

  private hasValidConfig(inst: ImChannelInstance): boolean {
    if (inst.type === "dingtalk") {
      return Boolean(inst.config?.clientId && inst.config?.clientSecret);
    }
    if (inst.type === "weixin") {
      // WeChat is QR-login bound: token + botId are written by the login flow.
      return Boolean(inst.config?.token && inst.config?.botId);
    }
    if (inst.type === "qq") {
      // QQ is QR-login bound: appId + appSecret come from the scan.
      return Boolean(inst.config?.appId && inst.config?.appSecret);
    }
    return false;
  }

  private createAdapter(inst: ImChannelInstance): ImChannelAdapter | null {
    switch (inst.type) {
      case "dingtalk":
        return new DingtalkAdapter(inst);
      case "weixin":
        return new WeixinAdapter(inst);
      case "qq":
        return new QqAdapter(inst);
      default:
        console.warn(`[im] channel type "${inst.type}" not implemented`);
        return null;
    }
  }

  private register(adapter: ImChannelAdapter) {
    adapter.onMessage = (m) => {
      this.handleInbound(m).catch((err) => console.error("[im] handleInbound:", err));
    };
    adapter.onStatusChange = (s) => {
      this.setChannelStatus(adapter.instanceId, s);
    };
    adapter.onInteraction = (buttonId, userId) => {
      this.handleApprovalInteraction(adapter, buttonId, userId);
    };
    this.adapters.push(adapter);
  }

  private setChannelStatus(instanceId: string, status: ImStatus) {
    this.statusMap[instanceId] = status;
    this.broadcastStatus();
  }

  private broadcastStatus() {
    const snapshot = { ...this.statusMap };
    for (const cb of this.statusListeners) cb(snapshot);
  }

  getStatus(): Record<string, ImStatus> {
    return { ...this.statusMap };
  }

  onStatusChange(cb: (s: Record<string, ImStatus>) => void): () => void {
    this.statusListeners.push(cb);
    return () => {
      this.statusListeners = this.statusListeners.filter((x) => x !== cb);
    };
  }

  private adapterFor(instanceId: string): ImChannelAdapter | undefined {
    return this.adapters.find((a) => a.instanceId === instanceId);
  }

  private async handleInbound(msg: ImInboundMessage): Promise<void> {
    const { instanceId, peer } = parseSessionKey(msg.sessionKey);
    if (!instanceId || !peer) return;
    const adapter = this.adapterFor(instanceId);
    if (!adapter) return;

    // The cwd for a NEW conversation comes from the channel instance's
    // configured default workspace (else chat/im/<channel>). An EXISTING
    // conversation uses the cwd stored in its own session file header — that
    // is the source of truth (the user may have migrated the session to a
    // different workspace, and the channel default must NOT override it, or
    // the LLM would keep running in the old directory).
    const instance = this.channels.find((c) => c.id === instanceId);
    const existingPath = this.sessionMap.pathOf(msg.sessionKey);
    let effectiveCwd: string;
    if (existingPath) {
      effectiveCwd = await readSessionCwd(existingPath).catch(
        () => join(getAgentDir(), "chat", IM_CHAT_SUBDIR, msg.channel),
      );
    } else {
      effectiveCwd = instance?.cwd
        ? instance.cwd
        : join(getAgentDir(), "chat", IM_CHAT_SUBDIR, msg.channel);
    }

    // Channel-level approval: track the peer for this cwd (used to send the
    // confirm message) and register the cwd if the channel opted in — this
    // also covers sessions migrated to a non-default workspace.
    this.lastPeerByCwd.set(effectiveCwd, peer);
    this.lastPeerByInstanceId.set(instanceId, peer);
    if (instance?.config?.approval === "on") {
      this.approvalCwdInfo.set(effectiveCwd, {
        channel: msg.channel,
        instanceId,
      });
      this.piManager.setApprovalChannel(effectiveCwd, {
        channel: msg.channel,
        instanceId,
      });
    }

    // 1. Slash commands — handled here, never forwarded to the LLM. Unknown
    // /commands fall through to the normal prompt flow.
    const cmd = parseCommand(msg.text);
    if (cmd) {
      const handled = await this.handleCommand(cmd.name, cmd.args, {
        adapter,
        peer,
        sessionKey: msg.sessionKey,
        cwd: effectiveCwd,
      });
      if (handled) return;
    }

    // 1.5 Approval-response text — typed manually OR bounced back by an
    // ActionCard button click (DingTalk) or other channels. Two formats:
    //   • English code: "allow:3" / "deny:3" / "allow_session:3" / "allow_always:3"
    //   • Chinese label: "✅ 允许 3" / "⛔ 拒绝 3" / "🔁 允许并记住 3" / "本次会话允许 3"
    // Consumed here, never sent to the LLM.
    const trimmed = msg.text.trim();
    const enMatch = /^(allow|deny|allow_session|allow_always):(\d+)$/.exec(trimmed);
    const cnMatch = !enMatch
      ? /^(✅\s*允许|⛔\s*拒绝|🔁\s*允许并记住|本次会话允许)\s+(\d+)$/.exec(trimmed)
      : null;
    if (enMatch || cnMatch) {
      const keyword = enMatch ? enMatch[1] : cnMatch![1];
      const requestId = Number((enMatch ?? cnMatch)![2]);
      const decision =
        keyword === "deny"
          ? "deny"
          : keyword === "allow_session"
            ? "allow-session"
            : keyword === "allow_always"
              ? "allow-whitelist"
              : "allow";
      const ok = this.piManager.handleBashApprovalResponse({
        requestId,
        decision,
      });
      await adapter
        .sendText(
          peer,
          ok
            ? decision === "deny"
              ? "❌ 已拒绝"
              : decision === "allow-whitelist"
                ? "✅ 已允许并加入白名单"
                : "✅ 已允许"
            : "❌ 没有待审批的命令，或审批已过期",
        )
        .catch(() => {});
      return;
    }

    // 2. Ensure Pi session, then process through the per-session FIFO queue:
    //    group chats share one session, so concurrent messages are answered
    //    in arrival order (A → B → C) instead of interleaving/losing turns.
    const sessionPath = await this.sessionMap.ensureSession(
      msg.sessionKey,
      effectiveCwd,
    );
    // DingTalk includes the sender's nickname (senderNick) and — for groups —
    // the conversation title on every message. Prefix both so the agent knows
    // WHO is asking and WHICH group it's in (and can address the user by
    // name), especially in group chats where one session serves everyone.
    const raw = (msg.raw ?? {}) as {
      senderNick?: string;
      conversationTitle?: string;
      isGroup?: boolean;
    };
    const senderNick = raw.senderNick?.trim();
    // DingTalk reports the member-nick list as the "title" for groups that
    // have no custom name (e.g. "李健,孟静静") — treat comma-y titles as
    // anonymous and fall back to a generic label instead of leaking members.
    const title = raw.conversationTitle?.trim();
    const realTitle = title && !/[，,]/.test(title) ? title : null;
    const groupLabel = raw.isGroup ? `[群：${realTitle ?? "群聊"}]` : "";
    const userText = senderNick
      ? `${groupLabel}[用户：${senderNick}] ${msg.text}`
      : groupLabel
        ? `${groupLabel} ${msg.text}`
        : msg.text;
    const q = this.queues.get(sessionPath) ?? [];
    q.push({
      adapter,
      text: userText,
      images: msg.images,
      peer,
      sessionPath,
      effectiveCwd,
      senderNick,
      isGroup: raw.isGroup,
    });
    this.queues.set(sessionPath, q);
    if (q.length === 1) {
      // Queue was empty → this item starts processing immediately.
      void this.drainQueue(sessionPath).catch((err) =>
        console.error("[im] drainQueue:", err),
      );
    }
  }

  /**
   * Process one queued message for a session, then advance to the next.
   * Serial by construction: only the head of the queue is ever drained, and
   * prompt() resolves after the turn (agent_end) completes, so replies come
   * out in arrival order with no interleaving.
   */
  private async drainQueue(sessionPath: string): Promise<void> {
    const q = this.queues.get(sessionPath);
    const item = q?.[0];
    if (!item) return;
    this.pending.set(sessionPath, {
      adapter: item.adapter,
      target: item.peer,
      senderNick: item.senderNick,
      isGroup: item.isGroup,
    });
    try {
      await this.piManager.prompt(item.text, item.images, item.effectiveCwd, sessionPath);
    } catch (err) {
      await item.adapter
        .sendText(item.peer, `⚠️ 处理失败：${err instanceof Error ? err.message : String(err)}`)
        .catch(() => {});
    } finally {
      q.shift();
      if (q.length > 0) {
        void this.drainQueue(sessionPath).catch((e) =>
          console.error("[im] drainQueue:", e),
        );
      } else {
        this.queues.delete(sessionPath);
      }
    }
  }

  /**
   * Execute a slash command for the IM channel. Returns true when the message
   * was consumed (reply sent), false to fall through to the LLM.
   */
  private async handleCommand(
    name: string,
    args: string,
    ctx: {
      adapter: ImChannelAdapter;
      peer: string;
      sessionKey: string;
      cwd: string;
    },
  ): Promise<boolean> {
    const lower = name.toLowerCase();
    if (lower === "stop") {
      // Abort the running turn for this session's cwd — kills any in-flight
      // bash command too (session-manager.abort → abortBash).
      try {
        await this.piManager.abort(ctx.cwd);
        await ctx.adapter.sendText(ctx.peer, "⏹️ 已停止");
      } catch (err) {
        await ctx.adapter
          .sendText(
            ctx.peer,
            `⚠️ 停止失败：${err instanceof Error ? err.message : String(err)}`,
          )
          .catch(() => {});
      }
      return true;
    }
    if (lower === "reset" || lower === "clear" || lower === "new") {
      await this.sessionMap.delete(ctx.sessionKey);
      await ctx.adapter.sendText(ctx.peer, "✅ 已开启新会话");
      return true;
    }
    if (
      lower === "allow" ||
      lower === "deny" ||
      lower === "allow_session" ||
      lower === "allow_always"
    ) {
      // Channel-level bash approval responses: /allow <id> /deny <id>
      // /allow_session <id> /allow_always <id> (allow + persist whitelist).
      // Without an id, resolve the MOST RECENT pending approval of this
      // session's cwd (the common IM interaction).
      const decision =
        lower === "deny"
          ? "deny"
          : lower === "allow_session"
            ? "allow-session"
            : lower === "allow_always"
              ? "allow-whitelist"
              : "allow";
      const idArg = args.trim();
      const id = Number(idArg);
      const ok =
        idArg && Number.isFinite(id) && id > 0
          ? this.piManager.handleBashApprovalResponse({ requestId: id, decision })
          : this.piManager.resolveLatestApproval(ctx.cwd, decision);
      await ctx.adapter.sendText(
        ctx.peer,
        ok
          ? lower === "deny"
            ? "❌ 已拒绝"
            : lower === "allow_always"
              ? "✅ 已允许并加入白名单"
              : "✅ 已允许"
          : "❌ 没有待审批的命令，或审批已过期",
      );
      return true;
    }
    if (lower === "help") {
      await ctx.adapter.sendText(ctx.peer, HELP_TEXT);
      return true;
    }
    if (lower === "model") {
      return await this.handleModelCommand(args, ctx);
    }
    if (lower === "status") {
      // Report the session's cwd + the model this cwd's unit is running on.
      // unit.defaultModel is set by /model and by the desktop Models page;
      // when null the session uses the global default from settings.json.
      const unit = this.piManager.getUnit(ctx.cwd);
      const model = unit?.defaultModel;
      const modelLabel = model
        ? `${model.provider} / ${model.modelId}`
        : "全局默认（未单独设置）";
      // Markdown list items — a bare "\n" would collapse into one line in
      // DingTalk's markdown renderer (single newline = space per spec).
      await ctx.adapter.sendText(
        ctx.peer,
        [
          "📊 当前会话状态：",
          `- 📁 工作目录：${ctx.cwd}`,
          `- 🤖 模型：${modelLabel}`,
        ].join("\n"),
      );
      return true;
    }
    if (lower === "compact") {
      try {
        const res = await this.piManager.compact(undefined, ctx.cwd);
        if (res.ok) {
          await ctx.adapter.sendText(ctx.peer, "✅ 已压缩上下文");
        } else if (res.reason === "too_small") {
          await ctx.adapter.sendText(ctx.peer, "📄 会话内容太少，无需压缩");
        } else if (res.reason === "already_compacted") {
          await ctx.adapter.sendText(ctx.peer, "🔄 刚刚已经压缩过");
        } else {
          await ctx.adapter.sendText(ctx.peer, `⚠️ 压缩失败：${res.message ?? ""}`);
        }
      } catch (err) {
        await ctx.adapter.sendText(
          ctx.peer,
          `⚠️ 压缩失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return true;
    }
    return false; // not a gateway command — forward to the LLM
  }

  /** /model — list models with no args, or switch to the matching one. */
  private async handleModelCommand(
    args: string,
    ctx: { adapter: ImChannelAdapter; peer: string; cwd: string },
  ): Promise<boolean> {
    try {
      const cat = await this.piManager.getProvidersCatalog();
      // Only providers that are actually usable: built-in providers with an
      // API key configured, plus every custom provider the user added.
      const usable = [
        ...cat.apiKeyProviders.filter((p) => p.configured),
        ...cat.customProviders,
      ];
      const all: { provider: string; pname: string; id: string; name?: string }[] =
        [];
      for (const p of usable) {
        const pname = providerDisplayName(p as any);
        for (const m of p.models) {
          all.push({ provider: p.id, pname, id: m.id, name: m.name });
        }
      }
      const query = args.trim();
      if (!query) {
        // No args → list providers and their models, one model per line with
        // a running index (so `/model <编号>` works too). DingTalk rejects
        // long text messages with HTTP 400, so split across messages.
        const MAX_CHARS = 1400;
        const lines: string[] = ["📋 可用模型："];
        let idx = 0;
        for (const p of usable) {
          lines.push(`- 🔷 ${p.name}`);
          for (const m of p.models) {
            idx += 1;
            lines.push(`- ${idx}. ${m.id}`);
          }
        }
        lines.push("");
        lines.push("💡 发送 /model <名称或编号> 切换当前会话的模型。");
        const chunks: string[] = [];
        let current: string[] = [];
        let len = 0;
        for (const line of lines) {
          if (current.length > 0 && len + line.length + 1 > MAX_CHARS) {
            chunks.push(current.join("\n"));
            current = [];
            len = 0;
          }
          current.push(line);
          len += line.length + 1;
        }
        if (current.length) chunks.push(current.join("\n"));
        for (const c of chunks) {
          await ctx.adapter.sendText(ctx.peer, c).catch(() => {
            /* a failed chunk must not masquerade as a switch error */
          });
        }
        return true;
      }
      const q = query.toLowerCase();
      // A bare number selects by the running index shown in the list (1-based).
      const numMatch = /^\d+$/.test(q);
      const found = numMatch
        ? all[parseInt(q, 10) - 1]
        : all.find((m) => m.id.toLowerCase() === q) ??
          all.find((m) => m.name?.toLowerCase() === q) ??
          all.find((m) => m.id.toLowerCase().includes(q)) ??
          all.find((m) => m.name?.toLowerCase().includes(q));
      if (!found) {
        const sample = all.slice(0, 20).map((m) => m.id).join(" / ");
        await ctx.adapter.sendText(
          ctx.peer,
          `❌ 未找到模型「${query}」。可用：${sample}${all.length > 20 ? " …" : ""}`,
        );
        return true;
      }
      await this.piManager.setModel(found.provider, found.id, ctx.cwd);
      await ctx.adapter.sendText(
        ctx.peer,
        `✅ 已切换到 ${found.pname} / ${found.id}`,
      );
    } catch (err) {
      await ctx.adapter.sendText(
        ctx.peer,
        `⚠️ 切换模型失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return true;
  }

  /** Called by session-manager for IM-session events. Returns consumed. */
  private handlePiEvent(sessionPath: string, event: any): boolean {
    if (!this.sessionMap.hasSessionPath(sessionPath)) return false;

    // Reply routing. NOTE: `message_end` fires once per assistant turn — with
    // tool calls there are MULTIPLE assistant turns (each intermediate message
    // ends), so we must NOT finalize the card on message_end. The real end of
    // the reply cycle is `agent_end` (emitted once after all turns finish).
    // User-message message_end (role=user) must be ignored entirely — it would
    // echo the user's own text back to the channel.
    if (event?.type === "message_start" && event?.message?.role === "assistant") {
      // Assistant turn begins → open a streaming channel if the adapter
      // supports it (DingTalk AI Card). Only the FIRST turn opens the card;
      // tool-call cycles emit additional message_start events and would
      // otherwise re-create the card and discard the accumulated content.
      const pending = this.pending.get(sessionPath);
      if (pending && pending.adapter.beginStream && !pending.streamStarted) {
        pending.streamStarted = true;
        pending.adapter.beginStream(pending.target).catch(() => {});
      }
      // Channels without cards (WeChat) can still show a "typing…" indicator.
      if (pending && !pending.adapter.beginStream && pending.adapter.sendTyping) {
        pending.adapter.sendTyping(pending.target).catch(() => {});
      }
    } else if (event?.type === "message_update" && event?.assistantMessageEvent?.type === "text_delta") {
      // Accumulate deltas; flush to the adapter on a throttle cadence (the
      // SDK emits a delta per token, far too fast for DingTalk's card API
      // which truncates frames over ~1K with "***").
      const pending = this.pending.get(sessionPath);
      if (pending && pending.adapter.streamText) {
        const delta: string = event.assistantMessageEvent?.delta ?? "";
        if (typeof delta === "string" && delta.length > 0) {
          pending.accumulated = (pending.accumulated ?? "") + delta;
          const now = Date.now();
          const sinceLast = now - (pending.lastStreamAt ?? 0);
          if (sinceLast >= STREAM_THROTTLE_MS || (pending.accumulated?.length ?? 0) >= STREAM_FRAME_MAX) {
            pending.lastStreamAt = now;
            // Full accumulated snapshot every frame (novaclaw-style): the card
            // content grows smoothly and never jumps backwards. (The streaming
            // API's ~1K per-frame advice is not enforced; finalize handles
            // very long texts separately.)
            pending.adapter.streamText(pending.target, pending.accumulated).catch(() => {});
          }
        }
      }
    } else if (event?.type === "tool_execution_start") {
      // Show the current tool call ON the streaming card (overwrite) — it
      // stays visible only until the next text_delta arrives, which replaces
      // it with the real reply (smooth full-accumulated growth, no stacking,
      // no scrolling window). Exactly the "show tool, then reply" feel.
      const pending = this.pending.get(sessionPath);
      if (pending && pending.adapter.streamText && event?.toolName) {
        const label = formatToolCall(event.toolName, event?.args);
        pending.adapter.streamText(pending.target, `🔧 正在调用工具：${label}`).catch(() => {});
      }
    } else if (event?.type === "agent_end") {
      // Reply cycle finished (all turns done, including tool calls). Finalize
      // the card with the last assistant message's full text — or with a
      // short "done" note when the model produced no final text (purely tool
      // calls), so the card closes instead of hanging in "inputting".
      const pending = this.pending.get(sessionPath);
      if (pending) {
        const messages: any[] = event?.messages ?? [];
        const last = messages[messages.length - 1];
        const text = extractMessageText(last);
        let finalText = text || "✅ 已完成（无文本输出）";
        // Group chats: prefix a plain "@昵称 " so the user knows this reply
        // answers THEIR message (DingTalk can't render a real @ for
        // enterprise robots, but the text mention is enough to route it).
        if (pending.isGroup && pending.senderNick) {
          finalText = `@${pending.senderNick} ${finalText}`;
        }
        if (pending.adapter.endStream) {
          pending.adapter.endStream(pending.target, finalText).catch(() => {});
        } else {
          pending.adapter.sendText(pending.target, finalText).catch(() => {});
        }
        this.pending.delete(sessionPath);
      }
    }
    return true; // consumed — never broadcast IM sessions to the desktop UI
  }

  private async stopAll(): Promise<void> {
    await Promise.all(this.adapters.map((a) => a.stop().catch(() => {})));
    this.adapters = [];
    this.statusMap = {};
  }

  /**
   * True when the session file belongs to an IM conversation (the desktop
   * UI uses this to render the workspace selector for IM sessions).
   */
  isSession(sessionPath: string): boolean {
    return this.sessionMap.hasSessionPath(sessionPath);
  }

  /**
   * Display prefix for an IM session's title, e.g. "[测试机器人] ". Returns
   * null when the session isn't an IM conversation or the channel instance
   * has no name. The desktop session list prepends this to firstMessage so
   * IM conversations are identifiable at a glance.
   */
  displayPrefix(sessionPath: string): string | null {
    const key = this.sessionMap.keyForSessionPath(sessionPath);
    if (!key) return null;
    const instanceId = key.split(":")[1];
    if (!instanceId) return null;
    const inst = this.channels.find((c) => c.id === instanceId);
    if (!inst?.name) return null;
    return `[${inst.name}] `;
  }

  /**
   * Migrate ONE IM conversation (looked up by its session path) to a new
   * cwd. Used by the desktop chat window's workspace selector. Refuses to
   * move a session that is currently mid-run.
   */
  async migrateSession(
    sessionPath: string,
    newCwd: string,
  ): Promise<{ ok: boolean; newPath?: string; error?: string }> {
    const key = this.sessionMap.keyForSessionPath(sessionPath);
    if (!key) {
      return { ok: false, error: "Not an IM session" };
    }
    if (this.piManager.getRunningSessions().includes(sessionPath)) {
      return { ok: false, error: "Session is currently replying — try again later" };
    }
    try {
      const newPath = await this.sessionMap.migrate(key, newCwd.trim());
      return { ok: true, newPath };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Migrate every existing conversation of a channel instance to the
   * instance's configured default workspace (cwd). Sessions currently
   * mid-run are skipped to avoid moving a file the runtime is appending to.
   */
  async migrateChannelSessions(
    instanceId: string,
  ): Promise<{
    migrated: string[];
    skipped: string[];
    failed: { sessionKey: string; error: string }[];
  }> {
    const inst = this.channels.find((c) => c.id === instanceId);
    if (!inst) return { migrated: [], skipped: [], failed: [] };
    const targetCwd = inst.cwd?.trim();
    if (!targetCwd) {
      // No workspace configured — nothing to migrate to.
      return { migrated: [], skipped: [], failed: [] };
    }
    const keys = this.sessionMap.keysForInstance(inst.type, instanceId);
    const running = new Set(this.piManager.getRunningSessions());
    const migrated: string[] = [];
    const skipped: string[] = [];
    const failed: { sessionKey: string; error: string }[] = [];
    for (const key of keys) {
      const oldPath = this.sessionMap.pathOf(key);
      if (oldPath && running.has(oldPath)) {
        skipped.push(key); // mid-run — don't move the file out from under it
        continue;
      }
      try {
        const newPath = await this.sessionMap.migrate(key, targetCwd);
        if (newPath === oldPath) skipped.push(key); // already in target cwd
        else migrated.push(newPath);
      } catch (err) {
        failed.push({
          sessionKey: key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { migrated, skipped, failed };
  }
}

/** Convenience: full restart from disk config. */
export async function startGatewayFromConfig(
  gateway: ImGateway,
): Promise<void> {
  const cfg = await readImConfig();
  await gateway.applyConfig(cfg);
}
