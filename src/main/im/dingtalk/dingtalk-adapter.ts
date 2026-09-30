/**
 * DingTalk channel adapter — implements ImChannelAdapter over the stream
 * connection. Converts DingTalk bot messages into ImInboundMessage and routes
 * replies back via the robot REST API. One instance per configured robot.
 *
 * Inbound coverage: text (+quote replies), picture, richText (image+text),
 * audio (server-side recognition), file (downloaded + text-extracted).
 * Outbound: group replies are plain text with @ (markdown cannot carry
 * plaintext @); single-chat replies use markdown so code blocks render.
 */
import type {
  ImChannelAdapter,
  ImInboundMessage,
  ImImage,
  ImStatus,
} from "../types";
import type { ImChannelInstance } from "../im-config";
import { writeFileSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { DingtalkConnection } from "./dingtalk-connection";
import {
  sendDingtalkText,
  sendDingtalkMarkdown,
  sendDingtalkImage,
  sendDingtalkFile,
  sendDingtalkVoice,
  sendDingtalkWebhook,
} from "./dingtalk-reply";
import { wavToAmr, isFfmpegAvailable, getAudioDurationMs } from "../audio-convert";
import { getActiveTtsConfig, synthesizeSpeech } from "../../tts/tts-service";
import {
  uploadDingtalkMedia,
  downloadDingtalkMedia,
  parseDingtalkFile,
  type DingtalkCredentials,
} from "./dingtalk-media";
import {
  createDingtalkCard,
  streamDingtalkCard,
  finishDingtalkCard,
  type AICardInstance,
  type AICardTarget,
} from "./dingtalk-card";
import { extractMediaRefs, toLocalPath } from "../media-shared";

interface DingtalkMessageData {
  senderStaffId?: string;
  senderId?: string;
  conversationId?: string;
  conversationType?: string; // "1" single, "2" group
  msgtype?: string;
  text?: Record<string, any>; // may embed isReplyMsg/repliedMsg
  picture?: { downloadCode?: string };
  content?: unknown; // JSON string or object — payload for picture/richText etc.
  msgId?: string;
  isInAtList?: boolean;
  senderNick?: string;
  /** Group chats carry the group title on every message. */
  conversationTitle?: string;
  /** Per-session reply webhook — group-only channel that honors `at`. */
  sessionWebhook?: string;
}

/** Parse a JSON-string-or-object payload into an object (null otherwise). */
function parseJsonish(raw: unknown): any | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* non-JSON — ignore */
    }
  }
  return null;
}

/**
 * DingTalk stream messages carry the message payload in `content` — a JSON
 * STRING (e.g. "{\"downloadCode\":\"...\",...}") for picture/richText, not in
 * top-level `picture`/`richText` fields.
 */
function resolveDingtalkContent(data: DingtalkMessageData): any | null {
  return parseJsonish(data?.content);
}

/** Text of a quoted (replied-to) message, "引用"-prefixed for the LLM. */
function extractQuotedText(container: any): string {
  const content = parseJsonish(container?.repliedMsg?.content);
  switch (container?.repliedMsg?.msgType) {
    case "text":
      return content?.text ?? "";
    case "picture":
      return "[图片]";
    case "audio":
      return content?.recognition ?? "[语音消息]";
    case "file":
      return `[文件: ${content?.fileName ?? "?"}]`;
    case "richText":
      return (content?.richText ?? []).map((i: any) => i?.text ?? "").join("");
    default:
      return "";
  }
}

/** Image downloadCodes referenced by a quoted (replied-to) message. */
function extractQuotedMedia(container: any): string[] {
  const content = parseJsonish(container?.repliedMsg?.content);
  if (container?.repliedMsg?.msgType === "picture") {
    return content?.downloadCode ? [content.downloadCode] : [];
  }
  if (container?.repliedMsg?.msgType === "richText") {
    return (content?.richText ?? [])
      .map((i: any) => i?.downloadCode ?? "")
      .filter(Boolean);
  }
  return [];
}

export class DingtalkAdapter implements ImChannelAdapter {
  readonly channel = "dingtalk";
  readonly instanceId: string;
  readonly name: string;
  private conn: DingtalkConnection | null = null;
  private status: ImStatus = "off";
  /**
   * peer → conversation info learned from inbound messages. The userId
   * (senderStaffId) drives group replies: we @ the last user who talked to the
   * bot in that conversation. encryptedId (senderId) is the encrypted form —
   * some @ channels need it (atDingtalkIds) while others need the plaintext
   * staffId (at.userIds). The webhook is the group reply channel that
   * actually honors `at` (the v1.0 robot API does not).
   */
  private peerInfo = new Map<
    string,
    { isGroup: boolean; userId: string; encryptedId?: string; webhook?: string }
  >();

  onMessage?: (msg: ImInboundMessage) => void;
  onStatusChange?: (status: ImStatus) => void;

  constructor(private readonly inst: ImChannelInstance) {
    this.instanceId = inst.id;
    this.name = inst.name;
  }

  private get clientId(): string {
    return this.inst.config?.clientId ?? "";
  }
  private get clientSecret(): string {
    return this.inst.config?.clientSecret ?? "";
  }
  private get credentials(): DingtalkCredentials {
    return { clientId: this.clientId, clientSecret: this.clientSecret };
  }

  private setStatus(s: ImStatus) {
    this.status = s;
    this.onStatusChange?.(s);
  }

  async start(): Promise<void> {
    if (this.conn) await this.stop();
    this.setStatus("connecting");
    this.conn = new DingtalkConnection({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      onMessage: (rawData) => this.handleRaw(rawData),
      onStatusChange: (connected) =>
        this.setStatus(connected ? "connected" : "connecting"),
    });
    try {
      await this.conn.connect();
      this.setStatus("connected");
    } catch (err) {
      this.setStatus("error");
      throw err;
    }
  }

  async stop(): Promise<void> {
    await this.conn?.stop();
    this.conn = null;
    this.setStatus("off");
  }

  getStatus(): ImStatus {
    return this.status;
  }

  private async handleRaw(rawData: string) {
    let data: DingtalkMessageData;
    try {
      data = JSON.parse(rawData);
    } catch {
      return; // ignore non-JSON frames
    }
    const msgtype = data.msgtype;
    const supported =
      msgtype === "text" ||
      msgtype === "picture" ||
      msgtype === "richText" ||
      msgtype === "audio" ||
      msgtype === "file";
    if (!supported) return;
    if (data.conversationType !== "1" && data.conversationType !== "2") return;

    const isGroup = data.conversationType === "2";
    const peer = isGroup
      ? data.conversationId ?? ""
      : data.senderStaffId ?? data.senderId ?? "";
    const userId = data.senderStaffId ?? data.senderId ?? "";
    if (!peer) return;

    // Group messages must @ the bot; ignore otherwise (avoids noise).
    if (isGroup && !data.isInAtList) return;

    this.peerInfo.set(peer, {
      isGroup,
      userId,
      encryptedId: data.senderId,
      webhook: data.sessionWebhook,
    });

    const content = resolveDingtalkContent(data);
    const downloadCodes: string[] = [];
    let text = "";

    if (msgtype === "text") {
      text = data.text?.content ?? "";
      const quoted = extractQuotedText(data.text);
      if (quoted) text = `[引用] ${quoted}\n\n${text}`;
      downloadCodes.push(...extractQuotedMedia(data.text));
    } else if (msgtype === "picture") {
      text = "[图片]";
      const code = content?.downloadCode ?? data.picture?.downloadCode ?? "";
      if (code) downloadCodes.push(code);
    } else if (msgtype === "richText") {
      const richList: any[] =
        content?.richText ?? (data as any)?.richText?.richTextList ?? [];
      const parts: string[] = [];
      for (const item of richList) {
        if (typeof item?.text === "string") parts.push(item.text);
        if (item?.downloadCode) downloadCodes.push(item.downloadCode);
      }
      const quoted = extractQuotedText(content);
      if (quoted) parts.unshift(`[引用] ${quoted}`);
      downloadCodes.push(...extractQuotedMedia(content));
      text = parts.join("\n");
      if (!text) text = downloadCodes.length ? "[图片]" : "[富文本消息]";
    } else if (msgtype === "audio") {
      text = content?.recognition || "[语音消息]";
    } else if (msgtype === "file") {
      const fileName = content?.fileName || "文件";
      const code = content?.downloadCode ?? "";
      if (code) {
        const file = await downloadDingtalkMedia(this.credentials, code);
        if (file) {
          const parsed = await parseDingtalkFile(file.data, fileName);
          text = parsed
            ? `[文件: ${fileName}]\n\n${parsed}`
            : `[文件: ${fileName}]（无法解析内容）`;
        } else {
          text = `[文件: ${fileName}]（下载失败）`;
        }
      } else {
        text = `[文件: ${fileName}]`;
      }
    }
    if (!text && downloadCodes.length === 0) return;

    // Image payloads → base64 for the Pi vision pipeline. Failures degrade
    // to text-only (the reply still goes through).
    let images: ImImage[] | undefined;
    for (const code of downloadCodes) {
      const img = await downloadDingtalkMedia(this.credentials, code);
      if (img && img.mimeType.startsWith("image/")) {
        (images ??= []).push({
          type: "image",
          data: img.data.toString("base64"),
          mimeType: img.mimeType,
        });
      }
    }

    this.onMessage?.({
      channel: "dingtalk",
      // instanceId isolates conversations between multiple robots on the same
      // platform: `${channel}:${instanceId}:${peer}`
      sessionKey: `dingtalk:${this.instanceId}:${peer}`,
      text,
      images,
      raw: {
        isGroup,
        senderNick: data.senderNick,
        conversationTitle: data.conversationTitle,
        msgId: data.msgId,
      },
    });
  }

  async sendText(target: string, text: string): Promise<void> {
    const info = this.peerInfo.get(target) ?? { isGroup: true, userId: "" };
    const enriched = await this.collectAndSendMedia(target, text, info.isGroup);
    if (info.isGroup) {
      if (info.webhook) {
        // Group replies go through the session webhook — the only channel that
        // honors `at` (markdown also renders, unlike sampleText). Pass both
        // the plaintext staffId and the encrypted senderId so whichever @
        // field DingTalk's webhook accepts is populated.
        await sendDingtalkWebhook(
          info.webhook,
          enriched,
          info.userId ? [info.userId] : undefined,
          this.name,
          info.encryptedId ? [info.encryptedId] : undefined,
        );
      } else {
        // No webhook — send as a markdown message so code blocks / lists /
        // tables render (sampleText would show as plain text).
        await sendDingtalkMarkdown(this.credentials, target, this.name, enriched, true);
      }
    } else {
      await sendDingtalkMarkdown(this.credentials, target, this.name, enriched, false);
    }
  }

  /**
 * Send a command-approval message. DingTalk's v1.0 robot API has NO
 * multi-button ActionCard template (`sampleActionCard` is single-button only;
 * `sampleActionCard_2` / `sampleCard` are rejected with
 * invalidParameter.msgKey.invalid), so we fall back to a plain text message —
 * the user replies /allow /deny (or allow:N / ✅ 允许 N), which the gateway's
 * approval-response recognizer handles.
 */
async sendKeyboard(
  target: string,
  text: string,
  buttons: { id: string; label: string; style?: 1 | 2 }[],
): Promise<void> {
  // Use \n\n (paragraph break) — a single \n is rendered as a space in
  // DingTalk's sampleMarkdown template, which crammed every option onto one
  // line in the earlier preview.
  const codes = buttons.map((b) => `${b.label} → \`${b.id}\``).join("\n\n");
  await this.sendText(target, `${text}\n\n${codes}`);
}

  /** Explicit `send_file` tool path — upload + deliver a local file directly
   *  (no text scanning); the optional caption goes out as a separate text. */
  async sendFile(target: string, filePath: string, caption?: string): Promise<boolean> {
    const info = this.peerInfo.get(target) ?? { isGroup: true, userId: "" };
    const fileName = basename(filePath);
    const up = await uploadDingtalkMedia(this.credentials, filePath, "file");
    if (!up) return false;
    await sendDingtalkFile(this.credentials, target, up.mediaId, fileName, info.isGroup).catch(() => {});
    if (caption && caption.trim()) {
      void this.sendText(target, caption).catch(() => {});
    }
    return true;
  }

  /**
   * Identify local images/files referenced in the reply, upload them, send as
   * dedicated media messages, and replace the reference with a short note.
   * Returns the text to send back to the user (with paths replaced).
   *
   * Three forms, in order of specificity:
   *   ![alt](<local path>)                    — image
   *   [DINGTALK_FILE]{"path":...}[/DINGTALK_FILE] — explicit file
   *   bare absolute path that exists on disk  — image or file (the AI rarely
   *     knows our marker syntax; a real path it wrote out is intent to send).
   *
   * Delivery: images/files always go out as stand-alone messages — DingTalk's
   * markdown renderer (cards and text) does NOT display inline images at all,
   * so the reference in the reply text is scrubbed to a plain-text note.
   *   Images → sampleImageMsg, photoURL = RAW media_id WITH the leading `@`
   *     (the only form that renders; stripped/URL forms show a broken icon).
   *   Files → sampleFile with the stripped media_id.
   */
  private async collectAndSendMedia(
    target: string,
    text: string,
    isGroup: boolean,
  ): Promise<string> {
    let result = text;
    // Shared scan: md-image + bare on-disk paths (image vs file classified).
    for (const ref of extractMediaRefs(text)) {
      if (ref.kind === "image") {
        // The image is delivered as a stand-alone sampleImageMsg (photoURL =
        // RAW media_id WITH the leading `@` — the only form DingTalk renders).
        // Inline markdown images are NOT supported by DingTalk's markdown
        // renderer (cards or messages), so scrub the syntax from the text and
        // leave a plain-text note instead of a broken/raw image tag.
        const up = await uploadDingtalkMedia(this.credentials, ref.path, "image");
        if (up) {
          await sendDingtalkImage(this.credentials, target, up.mediaId, isGroup).catch(() => {});
          result = result.replace(ref.full, "[图片]");
        } else {
          result = result.replace(ref.full, "⚠️ 图片上传失败");
        }
      } else {
        const fileName = basename(ref.path);
        const up = await uploadDingtalkMedia(this.credentials, ref.path, "file");
        if (up) {
          // sampleFile's mediaId field also expects the RAW media_id WITH the
          // leading `@` (novaclaw send_private_file / send_group_file).
          await sendDingtalkFile(this.credentials, target, up.mediaId, fileName, isGroup).catch(() => {});
          result = result.replace(ref.full, `[文件已发送：${fileName}]`);
        } else {
          result = result.replace(ref.full, "⚠️ 文件上传失败");
        }
      }
    }
    const fileMarker = /\[DINGTALK_FILE\](.*?)\[\/DINGTALK_FILE\]/gs;
    for (const m of text.matchAll(fileMarker)) {
      const [full, payload] = m;
      let spec: { path?: string } | null = null;
      try {
        spec = JSON.parse(payload);
      } catch {
        /* malformed marker — drop it */
      }
      const path = spec?.path ?? "";
      if (!path) {
        result = result.replace(full, "");
        continue;
      }
      const fileName = toLocalPath(path).split(/[\\/]/).pop() ?? "file";
      const up = await uploadDingtalkMedia(this.credentials, toLocalPath(path), "file");
      if (up) {
        // sampleFile's mediaId field also expects the RAW media_id WITH the
        // leading `@` (novaclaw send_private_file / send_group_file).
        await sendDingtalkFile(this.credentials, target, up.mediaId, fileName, isGroup).catch(() => {});
        result = result.replace(full, `[文件已发送：${fileName}]`);
      } else {
        result = result.replace(full, "⚠️ 文件上传失败");
      }
    }
    return result;
  }

  // ── AI Card streaming ──
  /** active card per peer — one streaming card at a time per conversation. */
  private cards = new Map<string, AICardInstance | null>();

  private cardTarget(target: string): AICardTarget {
    const isGroup = this.peerInfo.get(target)?.isGroup ?? true;
    return isGroup
      ? { type: "group", targetId: target }
      : { type: "user", targetId: target };
  }

  async beginStream(target: string): Promise<void> {
    // A new turn: drop any previous card for this peer.
    const prev = this.cards.get(target);
    if (prev) {
      this.cards.delete(target);
    }
    const card = await createDingtalkCard(
      this.credentials,
      this.cardTarget(target),
    );
    this.cards.set(target, card ?? null);
    if (!card) {
      // Card creation failed — fall back to a "thinking…" text so the user
      // gets some feedback; streamText will be a no-op until endStream.
      await this.sendText(target, "⏳ 正在思考…").catch(() => {});
    }
  }

  async streamText(target: string, text: string, finished = false): Promise<void> {
    const card = this.cards.get(target);
    if (!card) return; // no active card — ignore (plain text fallback at end)
    try {
      await streamDingtalkCard(card, text, finished);
    } catch (err) {
      // Streaming failed (network / QPS) — drop the card so endStream won't
      // try to finalize a broken instance.
      this.cards.delete(target);
    }
  }

  async endStream(target: string, text: string): Promise<void> {
    const card = this.cards.get(target);
    this.cards.delete(target);
    if (!card) {
      // No card was created (or it failed) — fall back to plain text so the
      // reply is never lost (sendText @s the asker in groups via webhook).
      await this.sendText(target, text);
      return;
    }
    const info = this.peerInfo.get(target);
    const isGroup = info?.isGroup ?? true;
    // Cards are streamed raw — the AI's text never went through media
    // enrichment. Run it now so images/files mentioned in the reply get sent
    // as dedicated media messages; the card text gets the same path→note
    // replacement so it stays consistent.
    const enriched = await this.collectAndSendMedia(target, text, isGroup);
    try {
      // Single card holds the final answer (novaclaw-style). Long texts skip
      // the streaming finalize frame (the ~1K per-frame advice) and go
      // straight to the FINISHED PUT with the full content. Only on failure
      // do we fall back to a markdown message (auto-chunked).
      const long = enriched.length > CARD_STREAM_FRAME_LIMIT;
      await finishDingtalkCard(card, enriched, undefined, long);
    } catch {
      // Finalize failed — send the full reply as a (chunked) markdown message.
      await this.sendText(target, text).catch(() => {});
    }
  }

  /**
   * Voice reply: text → MiMo TTS → WAV → AMR → DingTalk voice message.
   * Returns true on success, false on any failure (caller falls back to text).
   */
  async sendVoice(target: string, text: string): Promise<boolean> {
    const info = this.peerInfo.get(target);
    if (!info) return false;
    if (!isFfmpegAvailable()) {
      console.warn("[im.voice][dingtalk] sendVoice aborted: ffmpeg not available");
      return false;
    }
    console.log("[im.voice][dingtalk] sendVoice start; textLen=", text.length, "isGroup=", info.isGroup);
    try {
      const ttsConfig = await getActiveTtsConfig();
      if (!ttsConfig) {
        console.warn("[im.voice][dingtalk] sendVoice aborted: no active TTS config (tts-config.json activeConfigId?)");
        return false;
      }
      const { audioBase64 } = await synthesizeSpeech(ttsConfig, text);
      const wavBuffer = Buffer.from(audioBase64, "base64");
      console.log("[im.voice][dingtalk] TTS ok; wavBytes=", wavBuffer.length);
      const amrBuffer = wavToAmr(wavBuffer);
      if (!amrBuffer) {
        console.warn("[im.voice][dingtalk] WAV→AMR conversion failed (ffmpeg amr_nb encoder missing?) wavBytes=", wavBuffer.length);
        return false;
      }
      console.log("[im.voice][dingtalk] amrBytes=", amrBuffer.length);
      // uploadDingtalkMedia streams from a file path, so persist the AMR first.
      const amrPath = join(tmpdir(), `tts-${Date.now()}.amr`);
      writeFileSync(amrPath, amrBuffer);
      try {
        const up = await uploadDingtalkMedia(this.credentials, amrPath, "voice");
        if (!up) {
          console.warn("[im.voice][dingtalk] upload failed (uploadDingtalkMedia returned null)");
          return false;
        }
        const durationMs = getAudioDurationMs(amrPath);
        console.log("[im.voice][dingtalk] uploaded mediaId=", up.mediaId, "durationMs=", durationMs);
        // sampleAudio's mediaId field references the media_id returned by
        // /media/upload (same as sampleImageMsg/sampleFile), NOT a download URL.
        await sendDingtalkVoice(this.credentials, target, up.mediaId, info.isGroup, durationMs);
        console.log("[im:voice][dingtalk] voice reply sent OK; amrBytes=", amrBuffer.length);
        return true;
      } finally {
        try { unlinkSync(amrPath); } catch { /* ignore */ }
      }
    } catch (err) {
      console.warn("[im.voice][dingtalk] sendVoice failed:", err);
      return false;
    }
  }
}

/** DingTalk card streaming API caps a single content frame at ~1K. */
const CARD_STREAM_FRAME_LIMIT = 1000;
