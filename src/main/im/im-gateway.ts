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
  "/model —— 查看可用模型列表",
  "/model <名称> —— 切换当前会话的模型",
  "/status —— 查看当前会话的工作目录与模型",
  "/compact —— 压缩上下文（减少 token 占用）",
  "/reset / /clear / /new —— 开启新会话",
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

  constructor(private piManager: PiDeskSessionManager) {
    this.sessionMap = new ImSessionMap(piManager);
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

  /** (Re)build adapters from config: stop all, then start enabled channels. */
  async applyConfig(cfg: ImConfig): Promise<void> {
    await this.stopAll();
    this.channels = cfg.channels ?? [];
    this.pending.clear();

    for (const inst of this.channels) {
      if (!inst.enabled) continue;
      if (!this.hasValidConfig(inst)) {
        console.warn(`[im] instance ${inst.name} (${inst.id}) missing credentials — skipped`);
        continue;
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
    return false; // future channels (weixin/qq) not implemented yet
  }

  private createAdapter(inst: ImChannelInstance): ImChannelAdapter | null {
    switch (inst.type) {
      case "dingtalk":
        return new DingtalkAdapter(inst);
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

    // 2. Ensure Pi session, then process through the per-session FIFO queue:
    //    group chats share one session, so concurrent messages are answered
    //    in arrival order (A → B → C) instead of interleaving/losing turns.
    const sessionPath = await this.sessionMap.ensureSession(
      msg.sessionKey,
      effectiveCwd,
    );
    const q = this.queues.get(sessionPath) ?? [];
    q.push({ adapter, text: msg.text, images: msg.images, peer, sessionPath, effectiveCwd });
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
    this.pending.set(sessionPath, { adapter: item.adapter, target: item.peer });
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
    if (lower === "reset" || lower === "clear" || lower === "new") {
      await this.sessionMap.delete(ctx.sessionKey);
      await ctx.adapter.sendText(ctx.peer, "✅ 已开启新会话");
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
      await ctx.adapter.sendText(
        ctx.peer,
        [
          "📊 当前会话状态：",
          `📁 工作目录：${ctx.cwd}`,
          `🤖 模型：${modelLabel}`,
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
          lines.push(`🔷 ${p.name}`);
          for (const m of p.models) {
            idx += 1;
            lines.push(`  ${idx}. ${m.id}`);
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
        const finalText = text || "✅ 已完成（无文本输出）";
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
