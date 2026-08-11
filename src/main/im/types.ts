/**
 * IM gateway — channel-agnostic types.
 *
 * Every channel (DingTalk, WeChat, future QQ/Feishu) implements ImChannelAdapter
 * and registers itself with ImGateway. The gateway owns everything channel-
 * independent: session mapping, Pi prompt entry and reply routing.
 */

export type ImStatus = "off" | "connecting" | "connected" | "error" | "expired";

/** Image payload passed to Pi prompts (mirrors SDK ImageContent). */
export interface ImImage {
  type: "image";
  data: string; // base64
  mimeType: string;
}

/** Normalized inbound message handed to the gateway by a channel adapter. */
export interface ImInboundMessage {
  /** Channel id, e.g. "dingtalk". */
  channel: string;
  /**
   * Session key — the granularity at which a Pi conversation is persisted.
   * Convention: `${channel}:${peer}` where peer is channel-specific
   * (DingTalk: conversationId; WeChat: from_user_id; …). The gateway hashes
   * this into a per-channel session directory under chat/im/.
   */
  sessionKey: string;
  /** Text payload (media stripped by the adapter into images). */
  text: string;
  images?: ImImage[];
  /** Raw channel payload, for debugging / future fields. */
  raw?: unknown;
}

/** One channel's connection + send capability. */
export interface ImChannelAdapter {
  /** Channel protocol type, e.g. "dingtalk" (drives the session dir). */
  readonly channel: string;
  /** Unique instance id — one per configured robot (isolates conversations). */
  readonly instanceId: string;
  /** User-facing name shown in the UI. */
  readonly name: string;
  /** Connect (stream / long-poll / scan-login). Resolves when ready. */
  start(): Promise<void>;
  /** Disconnect and release resources. */
  stop(): Promise<void>;
  getStatus(): ImStatus;
  /** Injected by the gateway once registered. */
  onMessage?: (msg: ImInboundMessage) => void;
  /** Injected by the gateway; fires on any status transition. */
  onStatusChange?: (status: ImStatus) => void;
  /** Send a text reply to a peer (target = the raw peer id from sessionKey). */
  sendText(target: string, text: string): Promise<void>;
  /** Optional "typing…" indicator. */
  sendTyping?(target: string): Promise<void>;
  /**
   * Optional STREAMING reply (e.g. DingTalk AI Cards). The gateway forwards
   * assistant events here when available; a plain-text fallback (sendText)
   * is used otherwise. `text` is the FULL accumulated content so far.
   */
  beginStream?(target: string): Promise<void>;
  streamText?(target: string, text: string, finished?: boolean): Promise<void>;
  endStream?(target: string, text: string): Promise<void>;
}
