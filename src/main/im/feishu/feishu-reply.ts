/**
 * Feishu/Lark reply dispatch — send text/markdown/image messages via the SDK.
 *
 * Uses post format with a single `md` element so Markdown renders natively
 * (code blocks, lists, tables). For long replies, splits into chunks ≤ 30kb
 * (Feishu's content limit) and sends back-to-back.
 */
import type * as Lark from "@larksuiteoapi/node-sdk";

const CHUNK_LIMIT = 28_000;

/** Build a post-format content payload with a single markdown block. */
function buildPostContent(text: string): string {
  return JSON.stringify({
    zh_cn: { content: [[{ tag: "md", text }]] },
  });
}

/** Split markdown into chunks ≤ limit (paragraph-boundary aware). */
function chunkMarkdown(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  const parts = text.split(/\n\s*\n/);
  let cur = "";
  for (const p of parts) {
    const sep = cur ? "\n\n" : "";
    if (cur && cur.length + sep.length + p.length > limit) {
      chunks.push(cur);
      cur = "";
    }
    if (p.length <= limit) {
      cur = cur ? `${cur}${sep}${p}` : p;
    } else {
      if (cur) {
        chunks.push(cur);
        cur = "";
      }
      for (let i = 0; i < p.length; i += limit) {
        chunks.push(p.slice(i, i + limit));
      }
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export interface FeishuSendTarget {
  /** "chat_id" for groups, "open_id" for direct messages. */
  receiveIdType: "chat_id" | "open_id";
  /** The actual id. */
  receiveId: string;
  /** Optional message_id to reply to (threaded). */
  replyToMessageId?: string;
}

/**
 * Send a text/markdown message. Long content is split into multiple messages.
 */
export async function sendFeishuText(
  client: Lark.Client,
  target: FeishuSendTarget,
  text: string,
): Promise<void> {
  for (const chunk of chunkMarkdown(text, CHUNK_LIMIT)) {
    const content = buildPostContent(chunk);
    if (target.replyToMessageId) {
      await client.im.message.reply({
        path: { message_id: target.replyToMessageId },
        data: { content, msg_type: "post" },
      });
    } else {
      await client.im.message.create({
        params: { receive_id_type: target.receiveIdType },
        data: {
          receive_id: target.receiveId,
          msg_type: "post",
          content,
        },
      });
    }
  }
}

/**
 * Send an image message by image_key (previously uploaded).
 */
export async function sendFeishuImage(
  client: Lark.Client,
  target: FeishuSendTarget,
  imageKey: string,
): Promise<void> {
  const content = JSON.stringify({ image_key: imageKey });
  if (target.replyToMessageId) {
    await client.im.message.reply({
      path: { message_id: target.replyToMessageId },
      data: { content, msg_type: "image" },
    });
  } else {
    await client.im.message.create({
      params: { receive_id_type: target.receiveIdType },
      data: {
        receive_id: target.receiveId,
        msg_type: "image",
        content,
      },
    });
  }
}

/**
 * Upload an image (Buffer or ReadableStream) and return the image_key.
 */
export async function uploadFeishuImage(
  client: Lark.Client,
  image: Buffer,
): Promise<string | null> {
  const res = await client.im.image.create({
    data: { image_type: "message", image },
  });
  return res?.data?.image_key ?? null;
}

/**
 * Download a message resource (image/file) by message_id + file_key.
 * Returns a Buffer and content-type.
 */
export async function downloadFeishuResource(
  client: Lark.Client,
  messageId: string,
  fileKey: string,
  type: "image" | "file",
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const res: any = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  });

  // The SDK may return the payload in several shapes; normalize to Buffer.
  let buffer: Buffer | null = null;
  let contentType = "application/octet-stream";

  if (Buffer.isBuffer(res)) {
    buffer = res;
  } else if (res instanceof ArrayBuffer) {
    buffer = Buffer.from(res);
  } else if (res?.data) {
    if (Buffer.isBuffer(res.data)) {
      buffer = res.data;
    } else if (res.data instanceof ArrayBuffer) {
      buffer = Buffer.from(res.data);
    } else if (typeof res.data === "string") {
      buffer = Buffer.from(res.data, "base64");
    }
  }

  // Content-type from response headers if available.
  const ct =
    res?.headers?.["content-type"] ??
    res?.headers?.["Content-Type"] ??
    res?.contentType;
  if (typeof ct === "string") contentType = ct;

  if (!buffer) return null;
  return { buffer, contentType };
}