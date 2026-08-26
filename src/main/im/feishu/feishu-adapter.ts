/**
 * Feishu/Lark channel adapter — implements ImChannelAdapter over the
 * @larksuiteoapi/node-sdk WebSocket long-connection. Converts Feishu bot
 * messages into ImInboundMessage and routes replies back via the IM API.
 *
 * Inbound coverage: text, post (rich text), image. Group messages require
 * @-mentioning the bot (same as DingTalk's isInAtList).
 * Outbound: post format with a single `md` element (native Markdown render).
 */
import type {
  ImChannelAdapter,
  ImInboundMessage,
  ImImage,
  ImStatus,
} from "../types";
import type { ImChannelInstance } from "../im-config";
import { FeishuConnection, type FeishuCredentials } from "./feishu-connection";
import {
  sendFeishuText,
  downloadFeishuResource,
  buildPostContent,
  CHUNK_LIMIT,
  type FeishuSendTarget,
} from "./feishu-reply";
import { getActiveTtsConfig, synthesizeSpeech } from "../../tts/tts-service";
import { wavToOpus, isFfmpegAvailable } from "../audio-convert";

/** Parse a JSON string safely (null on failure). */
function safeJson(raw: unknown): any | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === "object") return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Extract plain text from a Feishu post (rich text) content structure. */
function extractPostText(postObj: any): string {
  // Post is locale-wrapped: { zh_cn: { title, content: [[{tag,text},...]] } }
  const locale = postObj?.zh_cn ?? postObj?.en_us ?? postObj?.ja_jp ?? postObj;
  const content: any[][] = locale?.content ?? [];
  const lines: string[] = [];
  for (const line of content) {
    if (!Array.isArray(line)) continue;
    const parts: string[] = [];
    for (const el of line) {
      if (!el?.tag) continue;
      switch (el.tag) {
        case "text":
        case "md":
          parts.push(el.text ?? "");
          break;
        case "a":
          parts.push(el.text ?? el.href ?? "");
          break;
        case "at":
          parts.push(el.user_id === "all" ? "@all" : `@${el.name ?? "user"}`);
          break;
        case "img":
        case "media":
          parts.push("[图片]");
          break;
        case "code_block":
          parts.push(`\n\`\`\`${el.language ?? ""}\n${el.text ?? ""}\n\`\`\`\n`);
          break;
        default:
          if (el.text) parts.push(el.text);
      }
    }
    lines.push(parts.join(""));
  }
  return lines.join("\n").trim();
}

export class FeishuAdapter implements ImChannelAdapter {
  readonly channel = "feishu";
  readonly instanceId: string;
  readonly name: string;
  private conn: FeishuConnection | null = null;
  private status: ImStatus = "off";
  /** peer → conversation info for reply routing. */
  private peerInfo = new Map<
    string,
    { isGroup: boolean; receiveIdType: "chat_id" | "open_id"; replyToMessageId?: string }
  >();

  /** peer → message_id of the placeholder post used for streaming updates. */
  private streamMsgId = new Map<string, string>();

  /** open_id → resolved display name (avoids repeated contact API calls). */
  private userNameCache = new Map<string, string>();

  onMessage?: (msg: ImInboundMessage) => void;
  onStatusChange?: (status: ImStatus) => void;

  constructor(private readonly inst: ImChannelInstance) {
    this.instanceId = inst.id;
    this.name = inst.name;
  }

  private get credentials(): FeishuCredentials {
    return {
      appId: this.inst.config?.appId ?? "",
      appSecret: this.inst.config?.appSecret ?? "",
      encryptKey: this.inst.config?.encryptKey || undefined,
      verificationToken: this.inst.config?.verificationToken || undefined,
      brand: (this.inst.config?.brand as "feishu" | "lark") || "feishu",
    };
  }

  private setStatus(s: ImStatus) {
    this.status = s;
    this.onStatusChange?.(s);
  }

  async start(): Promise<void> {
    if (this.conn) await this.stop();
    this.setStatus("connecting");
    const abort = new AbortController();
    this.conn = new FeishuConnection({
      credentials: this.credentials,
      onMessage: (data) => this.handleMessage(data),
      onStatusChange: (connected) =>
        this.setStatus(connected ? "connected" : "connecting"),
      abortSignal: abort.signal,
    });
    try {
      await this.conn.start();
      this.setStatus("connected");
    } catch (err) {
      this.setStatus("error");
      throw err;
    }
  }

  async stop(): Promise<void> {
    await this.conn?.stop();
    this.conn = null;
    this.streamMsgId.clear();
    this.userNameCache.clear();
    this.setStatus("off");
  }

  getStatus(): ImStatus {
    return this.status;
  }

  /**
   * Resolve a Feishu open_id to a display name. The receive_v1 event only
   * carries the open_id, so we look up the contact API (cached). Falls back to
   * the open_id when the app lacks contact scope or the lookup fails.
   */
  private async resolveSenderName(openId: string): Promise<string> {
    if (!openId) return openId;
    const cached = this.userNameCache.get(openId);
    if (cached) return cached;
    if (!this.conn) {
      this.userNameCache.set(openId, openId);
      return openId;
    }
    try {
      const res = await this.conn.client.contact.user.get({
        path: { user_id: openId },
        params: { user_id_type: "open_id" },
      });
      const name =
        res?.data?.user?.name ??
        res?.data?.user?.nickname ??
        res?.data?.user?.en_name ??
        openId;
      this.userNameCache.set(openId, name);
      return name;
    } catch (err) {
      console.warn(
        "[im:feishu] resolve sender name failed (contact scope required?):",
        err,
      );
      this.userNameCache.set(openId, openId);
      return openId;
    }
  }

  /** Handle an im.message.receive_v1 event (already deduped + self-echo filtered). */
  private async handleMessage(data: any) {
    const msg = data?.message;
    if (!msg) return;

    const chatType = msg.chat_type; // "p2p" | "group"
    if (chatType !== "p2p" && chatType !== "group") return;

    const isGroup = chatType === "group";
    const senderOpenId = data?.sender?.sender_id?.open_id ?? "";
    const chatId = msg.chat_id ?? "";
    const peer = isGroup ? chatId : senderOpenId;
    if (!peer) return;

    // Group messages must @-mention the bot; ignore otherwise.
    if (isGroup) {
      const mentions: any[] = msg.mentions ?? [];
      const botOpenId = this.conn?.botOpenIdValue;
      const mentioned = mentions.some(
        (m) => m?.id?.open_id && m.id.open_id === botOpenId,
      );
      if (!mentioned) return;
    }

    const msgType = msg.message_type;
    const contentRaw = safeJson(msg.content);
    let text = "";
    let images: ImImage[] | undefined;

    if (msgType === "text") {
      text = contentRaw?.text ?? "";
    } else if (msgType === "post") {
      text = extractPostText(contentRaw);
    } else if (msgType === "image") {
      const imageKey = contentRaw?.image_key;
      if (imageKey && this.conn) {
        const downloaded = await downloadFeishuResource(
          this.conn.client,
          msg.message_id,
          imageKey,
          "image",
        ).catch(() => null);
        if (downloaded) {
          (images ??= []).push({
            type: "image",
            data: downloaded.buffer.toString("base64"),
            mimeType: downloaded.contentType || "image/png",
          });
        }
      }
      text = images?.length ? "[图片]" : "[图片]";
    } else if (msgType === "file") {
      const fileName = contentRaw?.file_name ?? "文件";
      text = `[文件: ${fileName}]`;
    } else if (msgType === "audio") {
      text = contentRaw?.recognition ?? "[语音消息]";
    } else {
      // Unsupported type — send a placeholder so the user knows something came in.
      text = `[不支持的消息类型: ${msgType}]`;
    }

    if (!text && !images?.length) return;

    // Strip @-mention of the bot from the text (the bot doesn't need to see it).
    const botOpenId = this.conn?.botOpenIdValue;
    if (botOpenId && text) {
      const mentions: any[] = msg.mentions ?? [];
      for (const m of mentions) {
        if (m?.id?.open_id === botOpenId && m?.key) {
          text = text.replace(m.key, "").trim();
        }
      }
    }

    // Remember reply routing info for this peer.
    this.peerInfo.set(peer, {
      isGroup,
      receiveIdType: isGroup ? "chat_id" : "open_id",
      replyToMessageId: msg.message_id,
    });

    this.onMessage?.({
      channel: "feishu",
      sessionKey: `feishu:${this.instanceId}:${peer}`,
      text,
      images,
      raw: {
        isGroup,
        senderNick: await this.resolveSenderName(senderOpenId),
        msgId: msg.message_id,
      },
    });
  }

  /** Build a Feishu send target for a peer from stored reply routing info. */
  private targetFor(target: string): FeishuSendTarget {
    const info = this.peerInfo.get(target);
    return {
      receiveIdType: info?.receiveIdType ?? "chat_id",
      receiveId: target,
      replyToMessageId: info?.replyToMessageId,
    };
  }

  /**
   * Streaming — begin: create a placeholder post message so subsequent
   * streamText updates grow the same message in place.
   */
  async beginStream(target: string): Promise<void> {
    if (!this.conn) return;
    const t = this.targetFor(target);
    try {
      const content = buildPostContent("💭 思考中…");
      let messageId: string | undefined;
      if (t.replyToMessageId) {
        const res = await this.conn.client.im.message.reply({
          path: { message_id: t.replyToMessageId },
          data: { content, msg_type: "post" },
        });
        messageId = (res as any)?.data?.message_id;
      } else {
        const res = await this.conn.client.im.message.create({
          params: { receive_id_type: t.receiveIdType },
          data: {
            receive_id: t.receiveId,
            msg_type: "post",
            content,
          },
        });
        messageId = (res as any)?.data?.message_id;
      }
      if (messageId) this.streamMsgId.set(target, messageId);
    } catch (err) {
      console.warn("[im:feishu] beginStream failed:", err);
      this.streamMsgId.delete(target);
    }
  }

  /**
   * Streaming — update: patch the placeholder message with the accumulated
   * text. Gateway already throttles/accumulates, so this grows smoothly.
   */
  async streamText(target: string, text: string): Promise<void> {
    const id = this.streamMsgId.get(target);
    if (!id || !this.conn) return;
    if (text.length > CHUNK_LIMIT) return; // too long; endStream handles it
    try {
      await this.conn.client.im.message.update({
        path: { message_id: id },
        data: { content: buildPostContent(text), msg_type: "post" },
      });
    } catch (err) {
      console.warn("[im:feishu] streamText update failed:", err);
    }
  }

  /**
   * Streaming — end: finalize the placeholder message (patch if within
   * limit, else delete placeholder + fall back to chunked sendText).
   */
  async endStream(target: string, text: string): Promise<void> {
    const id = this.streamMsgId.get(target);
    this.streamMsgId.delete(target);
    if (!this.conn) return;
    if (!id) {
      await this.sendText(target, text);
      return;
    }
    if (text.length <= CHUNK_LIMIT) {
      try {
        await this.conn.client.im.message.update({
          path: { message_id: id },
          data: { content: buildPostContent(text), msg_type: "post" },
        });
        return;
      } catch (err) {
        console.warn(
          "[im:feishu] endStream update failed, fallback to sendText:",
          err,
        );
      }
    }
    // Long reply: remove placeholder, then send the full text as chunks.
    try {
      await this.conn.client.im.message.delete({ path: { message_id: id } });
    } catch {
      /* placeholder already gone — ignore */
    }
    await this.sendText(target, text);
  }

  async sendText(target: string, text: string): Promise<void> {
    if (!this.conn) return;
    const info = this.peerInfo.get(target);
    if (!info) {
      // Unknown peer — best effort: assume group chat.
      const t: FeishuSendTarget = {
        receiveIdType: "chat_id",
        receiveId: target,
      };
      await sendFeishuText(this.conn.client, t, text);
      return;
    }
    const t: FeishuSendTarget = {
      receiveIdType: info.receiveIdType,
      receiveId: target,
      replyToMessageId: info.replyToMessageId,
    };
    await sendFeishuText(this.conn.client, t, text);
  }

  /**
   * Voice reply: text → MiMo TTS → WAV → Opus → Feishu audio message.
   * Returns true on success, false on any failure.
   */
  async sendVoice(target: string, text: string): Promise<boolean> {
    if (!this.conn) return false;
    if (!isFfmpegAvailable()) {
      console.warn("[im:feishu] sendVoice: ffmpeg not available");
      return false;
    }
    const info = this.peerInfo.get(target);
    if (!info) return false;
    try {
      const ttsConfig = await getActiveTtsConfig();
      if (!ttsConfig) {
        console.warn("[im:feishu] sendVoice: no active TTS config");
        return false;
      }
      const { audioBase64 } = await synthesizeSpeech(ttsConfig, text);
      const wavBuffer = Buffer.from(audioBase64, "base64");
      const opusBuffer = wavToOpus(wavBuffer);
      if (!opusBuffer) {
        console.warn("[im:feishu] sendVoice: WAV→Opus conversion failed");
        return false;
      }
      const client = this.conn.client;
      const fileName = `voice-${Date.now()}.opus`;
      const uploadRes = await client.im.file.create({
        data: {
          file_type: "opus",
          file_name: fileName,
          file: opusBuffer,
        },
      });
      const fileKey = (uploadRes as any)?.file_key;
      if (!fileKey) {
        console.warn("[im:feishu] sendVoice: upload failed, no file_key");
        return false;
      }
      const content = JSON.stringify({ file_key: fileKey });
      const t: FeishuSendTarget = {
        receiveIdType: info.receiveIdType,
        receiveId: target,
        replyToMessageId: info.replyToMessageId,
      };
      if (t.replyToMessageId) {
        await client.im.message.reply({
          path: { message_id: t.replyToMessageId },
          data: { content, msg_type: "audio" },
        });
      } else {
        await client.im.message.create({
          params: { receive_id_type: t.receiveIdType },
          data: {
            receive_id: t.receiveId,
            msg_type: "audio",
            content,
          },
        });
      }
      console.log("[im:feishu] voice reply sent OK");
      return true;
    } catch (err) {
      console.warn("[im:feishu] sendVoice failed:", err);
      return false;
    }
  }
}