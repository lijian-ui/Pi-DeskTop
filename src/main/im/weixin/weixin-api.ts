/**
 * Weixin iLink CGI API — all calls are plain `fetch`, zero HTTP deps.
 * Ported from the official tencent-weixin connector (src/api/api.ts),
 * with the package.json discovery / openclaw-specific bits removed:
 *  - iLink-App-Id is the fixed upstream value "bot"
 *  - bot_agent is a fixed self-identity string
 *  - logging goes through console (no redaction framework needed — we never
 *    log tokens / bodies).
 */
import crypto from "node:crypto";

import type {
  BaseInfo,
  GetConfigResp,
  GetUpdatesReq,
  GetUpdatesResp,
  NotifyStartResp,
  NotifyStopResp,
  SendMessageReq,
  SendTypingReq,
} from "./weixin-types";

export type WeixinApiOptions = {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  longPollTimeoutMs?: number;
};

/** iLink-App-Id — fixed upstream value used by the official connector. */
const ILINK_APP_ID = "bot";

/** iLink-App-ClientVersion: uint32 encoded as 0x00MMNNPP. */
const ILINK_APP_CLIENT_VERSION = 0x00020003; // 2.0.3

/** Self-identity reported in base_info.bot_agent. */
const BOT_AGENT = "Pi Desktop";

/** Default timeout for long-poll getUpdates requests. */
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
/** Default timeout for regular API requests. */
const DEFAULT_API_TIMEOUT_MS = 15_000;
/** Default timeout for lightweight API requests. */
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/** X-WECHAT-UIN header: random uint32 -> decimal string -> base64. */
function randomWechatUin(): string {
  const bytes = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(bytes), "utf-8").toString("base64");
}

/** Build the `base_info` payload included in every API request. */
export function buildBaseInfo(): BaseInfo {
  return {
    channel_version: "2.4.3",
    bot_agent: BOT_AGENT,
  };
}

function buildHeaders(opts: { token?: string }): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
  };
  if (opts.token?.trim()) {
    headers.Authorization = `Bearer ${opts.token.trim()}`;
  }
  return headers;
}

function buildCommonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
  };
}

/** GET fetch wrapper. Returns raw response text; throws on HTTP error/timeout. */
export async function apiGetFetch(params: {
  baseUrl: string;
  endpoint: string;
  timeoutMs?: number;
  label: string;
}): Promise<string> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const controller =
    params.timeoutMs != null && params.timeoutMs > 0
      ? new AbortController()
      : undefined;
  const t =
    controller != null
      ? setTimeout(() => controller.abort(), params.timeoutMs!)
      : undefined;
  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: buildCommonHeaders(),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (t !== undefined) clearTimeout(t);
    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`${params.label} ${res.status}: ${rawText.slice(0, 300)}`);
    }
    return rawText;
  } catch (err) {
    if (t !== undefined) clearTimeout(t);
    throw err;
  }
}

/** POST JSON fetch wrapper. Returns raw response text; throws on error/timeout. */
export async function apiPostFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs?: number;
  label: string;
}): Promise<string> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const controller =
    params.timeoutMs !== undefined ? new AbortController() : undefined;
  const t =
    controller != null
      ? setTimeout(() => controller.abort(), params.timeoutMs!)
      : undefined;
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: buildHeaders({ token: params.token }),
      body: params.body,
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (t !== undefined) clearTimeout(t);
    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`${params.label} ${res.status}: ${rawText.slice(0, 300)}`);
    }
    return rawText;
  } catch (err) {
    if (t !== undefined) clearTimeout(t);
    throw err;
  }
}

/**
 * Long-poll getUpdates. Server holds the request until new messages or
 * timeout. Client-side timeout returns an empty response so the caller can
 * simply retry — this is normal for long-poll.
 */
export async function getUpdates(
  params: GetUpdatesReq & { baseUrl: string; token?: string; timeoutMs?: number },
): Promise<GetUpdatesResp> {
  const timeout = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    const rawText = await apiPostFetch({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: params.get_updates_buf ?? "",
        base_info: buildBaseInfo(),
      }),
      token: params.token,
      timeoutMs: timeout,
      label: "getUpdates",
    });
    return JSON.parse(rawText) as GetUpdatesResp;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf };
    }
    throw err;
  }
}

/** Send a single message downstream. */
export async function sendMessage(
  params: WeixinApiOptions & { body: SendMessageReq },
): Promise<void> {
  await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: "sendMessage",
  });
}

/** Fetch bot config (includes typing_ticket) for a given user. */
export async function getConfig(
  params: WeixinApiOptions & { ilinkUserId: string; contextToken?: string },
): Promise<GetConfigResp> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      context_token: params.contextToken,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: "getConfig",
  });
  return JSON.parse(rawText) as GetConfigResp;
}

/** Send a typing indicator to a user. */
export async function sendTyping(
  params: WeixinApiOptions & { body: SendTypingReq },
): Promise<void> {
  await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: "sendTyping",
  });
}

/** Notify Weixin that the channel client is stopping. */
export async function notifyStop(params: WeixinApiOptions): Promise<NotifyStopResp> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/msg/notifystop",
    body: JSON.stringify({ base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: "notifyStop",
  });
  return JSON.parse(rawText) as NotifyStopResp;
}

/** Notify Weixin that the channel client is starting. */
export async function notifyStart(params: WeixinApiOptions): Promise<NotifyStartResp> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/msg/notifystart",
    body: JSON.stringify({ base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: "notifyStart",
  });
  return JSON.parse(rawText) as NotifyStartResp;
}
