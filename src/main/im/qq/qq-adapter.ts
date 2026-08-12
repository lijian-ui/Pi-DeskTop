/**
 * QQ Bot channel adapter — implements ImChannelAdapter over
 * `@tencent-connect/qqbot-nodejs` (QQ Open Platform, websocket transport).
 *
 * - Private chats: every message maps to a c2c conversation keyed by the
 *   sender's openid.
 * - Group chats: only messages that @ the bot are processed (avoids spam);
 *   the group shares one conversation keyed by the group openid.
 * - Media: inbound images are downloaded (attachments carry a plain URL)
 *   and handed to the agent as base64; voice messages use the server-side
 *   ASR text. Outbound local image/file paths in replies are uploaded via
 *   the SDK's sendImage / sendMedia (no CDN/AES dance like WeChat).
 *
 * Outbound: `bot.sendText({ scope, targetId }, text)`. QQ renders markdown
 * natively when the bot has markdown permission, so no filtering is needed.
 */
import { statSync } from "node:fs";
import { basename } from "node:path";
import type {
  MediaFileType,
  QQBot,
  QQBotInboundMessage,
  StreamSession,
} from "@tencent-connect/qqbot-nodejs";

import type { ImChannelAdapter, ImImage, ImInboundMessage, ImStatus } from "../types";
import type { ImChannelInstance } from "../im-config";

const BASE_BACKOFF_DELAY = 2_000;
const MAX_BACKOFF_DELAY = 30_000;

/** True when a path points at a local file (drive letter, /, ~, file://). */
function isLocalPath(raw: string): boolean {
  return (
    raw.startsWith("file://") ||
    /^[A-Za-z]:[\\/]/.test(raw) ||
    raw.startsWith("/") ||
    raw.startsWith("~")
  );
}

/** True when the path exists AND is a regular file (directories are skipped
 *  so a `pwd`-style output never gets uploaded as media). */
function isRegularFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Strip file:// / URL-encoding to get the on-disk absolute path. */
function toLocalPath(raw: string): string {
  let p = raw.startsWith("file://") ? raw.slice("file://".length) : raw;
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep as-is */
  }
  return p;
}

/** Guess a MIME type from a download URL (QQ attachments expose content_type). */
function mimeFromContentType(ct: string | undefined): string {
  if (!ct) return "image/jpeg";
  const base = ct.split(";")[0].trim().toLowerCase();
  if (base.startsWith("image/")) return base;
  return "image/jpeg";
}

export class QqAdapter implements ImChannelAdapter {
  readonly channel = "qq";
  readonly instanceId: string;
  readonly name: string;

  private appId: string;
  private appSecret: string;
  private bot: QQBot | null = null;
  private stopped = true;
  private status: ImStatus = "off";
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** Per-peer (target string) last inbound msgId — anchors stream replies. */
  private lastMsgIds = new Map<string, string>();
  /** Active StreamSession per peer (C2C only). */
  private streamSessions = new Map<string, { session: StreamSession; enabled: boolean }>();

  onMessage?: (msg: ImInboundMessage) => void;
  onStatusChange?: (status: ImStatus) => void;
  onInteraction?: (buttonId: string, userId?: string) => void;

  constructor(inst: ImChannelInstance) {
    this.instanceId = inst.id;
    this.name = inst.name;
    this.appId = inst.config?.appId ?? "";
    this.appSecret = inst.config?.appSecret ?? "";
  }

  private setStatus(s: ImStatus) {
    if (this.status !== s) {
      this.status = s;
      this.onStatusChange?.(s);
    }
  }

  async start(): Promise<void> {
    if (!this.appId || !this.appSecret) {
      throw new Error("QQ credentials missing — bind via QR scan first");
    }
    this.stopped = false;
    this.setStatus("connecting");

    const { QQBot } = await import("@tencent-connect/qqbot-nodejs");
    const bot = new QQBot({
      appId: this.appId,
      appSecret: this.appSecret,
      accountId: this.instanceId,
      markdownSupport: true,
      // Fire-and-forget: don't block startup on the token round-trip — a
      // brand-new QR-scanned bot may not yet be approved by QQ and the
      // token endpoint will fail; the SDK's background refresher handles
      // retries without freezing our `start()` (which would otherwise hang
      // gateway.applyConfig → UI "saving…" stuck).
      tokenPrefetch: "async",
    });
    this.bot = bot;

    bot.on("ready", () => {
      this.reconnectAttempts = 0;
      this.setStatus("connected");
    });
    bot.on("resumed", () => {
      this.setStatus("connected");
    });
    bot.on("error", (err: Error) => {
      console.warn(`[im:qq] gateway error:`, err.message);
      if (!this.stopped && this.status === "connected") {
        this.setStatus("connecting");
        this.scheduleReconnect();
      }
    });
    bot.on("message", (_ctx, msg: QQBotInboundMessage) => {
      try {
        this.handleMessage(msg);
      } catch (err) {
        console.warn("[im:qq] handleMessage failed:", err);
      }
    });
    bot.on("interaction", (_ctx, event) => {
      // Button clicks (approval messages). button_data carries the button id.
      const btnId =
        event.data?.resolved?.button_data ?? event.data?.resolved?.button_id;
      if (!btnId) return;
      // Acknowledge so QQ stops retrying the interaction callback.
      void bot.acknowledgeInteraction(event.id).catch(() => {});
      const userId = event.data?.resolved?.user_id;
      this.onInteraction?.(btnId, userId);
    });

    // Don't await bot.start() indefinitely: the SDK's websocket transport
    // may stay in a reconnect loop forever (e.g. new bot not yet approved)
    // and never resolve start(). Bound it so applyConfig returns in time
    // and the UI shows "connecting" instead of hanging on save. The real
    // status will be updated when the bot emits "ready" / "resumed".
    let startResolved = false;
    await Promise.race([
      bot
        .start()
        .then(() => {
          startResolved = true;
        })
        .catch((err) => {
          console.warn(`[im:qq] bot.start rejected:`, err?.message);
          this.setStatus("error");
        }),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          if (!startResolved) {
            console.warn(
              "[im:qq] bot.start did not resolve within 5s — continuing in background",
            );
          }
          resolve();
        }, 5_000),
      ),
    ]);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const bot = this.bot;
    this.bot = null;
    if (bot) {
      try {
        bot.stop();
      } catch (err) {
        console.warn("[im:qq] stop failed:", err);
      }
    }
    this.setStatus("off");
  }

  getStatus(): ImStatus {
    return this.status;
  }

  // ── Reconnect ──

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const attempt = this.reconnectAttempts;
    this.reconnectAttempts += 1;
    const backoff = Math.min(
      MAX_BACKOFF_DELAY,
      BASE_BACKOFF_DELAY * 2 ** Math.min(attempt, 5),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.setStatus("connecting");
      void this.start().catch((err) => {
        console.warn(`[im:qq] reconnect failed (${attempt}):`, err?.message);
        this.scheduleReconnect();
      });
    }, backoff);
  }

  // ── Inbound ──

  private async handleMessage(msg: QQBotInboundMessage): Promise<void> {
    const kind = msg.kind;
    // Guild / dm channels are out of scope (QQ Open Platform c2c + group).
    if (kind !== "c2c" && kind !== "group") return;
    if (msg.senderIsBot) return;

    let text = (msg.content ?? "").trim();
    // Quote resolution: when the user replies to a specific message, QQ
    // pushes the quoted content as msg_elements[0] (refMsgIdx is set).
    // Inject it so the agent knows WHICH message is being replied to.
    if (msg.refMsgIdx && Array.isArray(msg.msgElements) && msg.msgElements.length > 0) {
      const quoted = msg.msgElements[0].content?.trim();
      if (quoted) {
        text = `[用户正在回复以下消息: ${quoted}]\n${text}`;
      }
    }
    // Voice messages: QQ provides server-side ASR text — append it so the
    // agent hears what was said even without a transcript in `content`.
    const voiceText = (msg.attachments ?? [])
      .map((a) => a.asr_refer_text)
      .find((t): t is string => Boolean(t));
    if (voiceText) text = text ? `${text}\n[语音转文字: ${voiceText}]` : `[语音转文字: ${voiceText}]`;

    // Download inbound images (attachments carry a plain URL) → base64.
    const images: ImImage[] = [];
    for (const att of msg.attachments ?? []) {
      if (!att.url) continue;
      if (!att.content_type?.startsWith("image/")) continue;
      try {
        const res = await fetch(att.url);
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        images.push({
          type: "image",
          data: buf.toString("base64"),
          mimeType: mimeFromContentType(att.content_type),
        });
      } catch (err) {
        console.warn("[im:qq] image download failed:", err);
      }
    }

    if (!text && images.length === 0) return;
    const base = {
      channel: "qq",
      text,
      images: images.length ? images : undefined,
    };
    if (kind === "c2c") {
      this.lastMsgIds.set(`c2c:${msg.senderId}`, msg.messageId);
      this.onMessage?.({
        ...base,
        sessionKey: `qq:${this.instanceId}:c2c:${msg.senderId}`,
        raw: {
          senderId: msg.senderId,
          senderName: msg.senderName,
          msgId: msg.messageId,
          scope: "c2c",
        },
      });
      return;
    }

    // Group chat: only process messages that @ this bot (is_you flag is
    // provided by the QQ platform; same check as the SDK's mentionGate).
    const groupOpenid = msg.groupOpenid ?? msg.channelId ?? "";
    if (!groupOpenid) return;
    const mentions = msg.mentions ?? [];
    const atBot = mentions.some((m) => m?.is_you === true);
    if (!atBot) return;
    this.onMessage?.({
      ...base,
      sessionKey: `qq:${this.instanceId}:group:${groupOpenid}`,
      raw: {
        senderId: msg.senderId,
        senderName: msg.senderName,
        msgId: msg.messageId,
        scope: "group",
        groupOpenid,
      },
    });
  }

  // ── Outbound ──

  private parseTarget(target: string): { scope: "c2c" | "group"; targetId: string } | null {
    const sep = target.indexOf(":");
    const scope = target.slice(0, sep) as "c2c" | "group";
    const targetId = target.slice(sep + 1);
    if ((scope !== "c2c" && scope !== "group") || !targetId) return null;
    return { scope, targetId };
  }

  async sendText(target: string, text: string): Promise<void> {
    const bot = this.bot;
    if (!bot) throw new Error("QQ bot not connected");
    const rt = this.parseTarget(target);
    if (!rt) {
      console.warn(`[im:qq] invalid send target: ${target}`);
      return;
    }
    // Local images/files referenced by the reply → upload + send as media
    // messages, replace the reference with a short note.
    const enriched = await this.sendMediaForText(rt, text);
    await bot.sendText(rt, enriched);
  }

  /** Send an inline-keyboard (button) message — used for command approval. */
  async sendKeyboard(
    target: string,
    text: string,
    buttons: { id: string; label: string; style?: 1 | 2 }[],
  ): Promise<void> {
    const bot = this.bot;
    const rt = this.parseTarget(target);
    console.warn(
      `[im:qq] sendKeyboard target=${target} rt=${rt ? `${rt.scope}:${rt.targetId}` : "✗"} buttons=${buttons.map((b) => b.label).join(",")}`,
    );
    if (!bot || !rt) return;
    const keyboard = {
      content: {
        rows: [
          {
            buttons: buttons.map((b) => ({
              id: b.id,
              render_data: {
                label: b.label,
                visited_label: b.label,
                style: b.style ?? 1,
              },
              // type 1 = interactive callback (fires INTERACTION_CREATE to the
              // bot, which we handle in bot.on('interaction')). type 2 would
              // turn the button into a quick-reply that pastes `data` as text.
              action: { type: 1, permission: { type: 2 }, data: b.id, click_limit: 1 },
              group_id: "approval",
            })),
          },
        ],
      },
    };
    await bot.sendTextWithKeyboard(rt, text, keyboard);
  }

  /**
   * Detect local image/file paths in a reply, upload each and send it as a
   * standalone media message (sendImage / sendMedia). Returns the text with
   * the references replaced by short notes.
   */
  private async sendMediaForText(
    rt: { scope: "c2c" | "group"; targetId: string },
    text: string,
  ): Promise<string> {
    const bot = this.bot;
    if (!bot) return text;
    let result = text;
    // 1. markdown image syntax: ![alt](<local path>)
    for (const m of text.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
      const [full, alt, p] = m;
      if (!isLocalPath(p)) continue;
      const filePath = toLocalPath(p);
      console.warn(`[im:qq] md-image ref → ${filePath} file=${isRegularFile(filePath)}`);
      if (!isRegularFile(filePath)) continue;
      await this.sendLocalMedia(rt, filePath);
      result = result.replace(full, alt ? `[${alt}]` : "[图片]");
    }
    // 2. bare absolute paths that exist on disk.
    const bareFile =
      /(?:file:\/\/)?[A-Za-z]:[\\/][^\s"'()<>]+|(?:\/(?:Users|home|tmp|var|private|root)\/[^\s"'()<>]+)/g;
    for (const m of result.matchAll(bareFile)) {
      const filePath = toLocalPath(m[0]);
      if (!isRegularFile(filePath)) continue;
      console.warn(`[im:qq] bare path ref → ${filePath}`);
      const ok = await this.sendLocalMedia(rt, filePath);
      if (ok) {
        const isImg = /\.(png|jpe?g|gif|bmp|webp)$/i.test(filePath);
        result = result.replace(m[0], isImg ? "[图片]" : `[文件已发送：${basename(filePath)}]`);
      }
    }
    return result;
  }

  /** Upload one local file and send it as an IMAGE / FILE media message. */
  private async sendLocalMedia(
    rt: { scope: "c2c" | "group"; targetId: string },
    filePath: string,
  ): Promise<boolean> {
    const bot = this.bot;
    if (!bot) return false;
    try {
      const isImage = /\.(png|jpe?g|gif|bmp|webp)$/i.test(filePath);
      console.warn(`[im:qq] sending media ${filePath} (image=${isImage})`);
      if (isImage) {
        await bot.sendImage(rt, { localPath: filePath });
      } else {
        const { MediaFileType } = await import("@tencent-connect/qqbot-nodejs");
        await bot.sendMedia({
          target: rt,
          fileType: MediaFileType.FILE,
          localPath: filePath,
          fileName: basename(filePath),
        });
      }
      console.warn(`[im:qq] media sent OK: ${basename(filePath)}`);
      return true;
    } catch (err) {
      console.warn(`[im:qq] media send failed (${filePath}):`, String(err));
      return false;
    }
  }

  // ── Streaming (C2C only — QQ stream_messages API is c2c-scoped) ──

  async beginStream(target: string): Promise<void> {
    const rt = this.parseTarget(target);
    const bot = this.bot;
    if (!rt || !bot) return;
    // Group chats don't support stream_messages — mark disabled so
    // streamText is a no-op and endStream falls back to a plain sendText.
    if (rt.scope !== "c2c") {
      this.streamSessions.set(target, { session: null as unknown as StreamSession, enabled: false });
      return;
    }
    const msgId = this.lastMsgIds.get(target);
    if (!msgId) {
      console.warn(`[im:qq] beginStream: no inbound msgId for ${target}`);
      this.streamSessions.set(target, { session: null as unknown as StreamSession, enabled: false });
      return;
    }
    try {
      const { StreamSession: StreamSessionCtor } = await import(
        "@tencent-connect/qqbot-nodejs"
      );
      const session = new StreamSessionCtor(bot.messageApi, {
        openid: rt.targetId,
        msgId,
        creds: { appId: this.appId, clientSecret: this.appSecret },
      });
      this.streamSessions.set(target, { session, enabled: true });
    } catch (err) {
      console.warn(`[im:qq] beginStream failed:`, String(err));
      this.streamSessions.set(target, { session: null as unknown as StreamSession, enabled: false });
    }
  }

  async streamText(target: string, text: string): Promise<void> {
    const s = this.streamSessions.get(target);
    if (!s?.enabled || !s.session) return;
    try {
      await s.session.update(text);
    } catch (err) {
      // QQ stream_messages is REPLACE-mode: it rejects frames whose prefix
      // changed (e.g. the model rewrote earlier content after a tool call).
      // Disable the stream — endStream will fall back to a plain sendText.
      console.warn(`[im:qq] streamText failed — disabling stream for ${target}:`, String(err));
      s.enabled = false;
    }
  }

  async endStream(target: string, text: string): Promise<void> {
    const s = this.streamSessions.get(target);
    this.streamSessions.delete(target);
    if (!s) {
      // No stream was started (e.g. group chat) — plain sendText fallback.
      await this.sendText(target, text);
      return;
    }
    if (s.enabled && s.session) {
      try {
        await s.session.update(text);
        await s.session.complete();
        return;
      } catch (err) {
        console.warn(`[im:qq] endStream failed, falling back to sendText:`, String(err));
      }
    }
    await this.sendText(target, text);
  }
}
