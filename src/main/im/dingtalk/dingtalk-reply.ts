/**
 * DingTalk reply dispatch (P0: plain text). Ported from from
 * dingtalk-openclaw-connector (MIT) — access-token caching + REST endpoints.
 */
import axios from "axios";

/** DingTalk robot credentials (extracted from ImChannelInstance.config). */
interface DingtalkCredentials {
  clientId: string;
  clientSecret: string;
}

const DINGTALK_API = "https://api.dingtalk.com";
const TOKEN_CACHE_TTL_MS = 1000 * 60 * 55; // slightly under 1h expiry

interface TokenCacheEntry {
  token: string;
  expiryMs: number;
}

const tokenCache = new Map<string, TokenCacheEntry>();

async function getAccessToken(cfg: DingtalkCredentials): Promise<string> {
  const key = cfg.clientId;
  const cached = tokenCache.get(key);
  if (cached && cached.expiryMs > Date.now() + 60_000) return cached.token;

  const res = await axios.post(`${DINGTALK_API}/v1.0/oauth2/accessToken`, {
    appKey: cfg.clientId,
    appSecret: cfg.clientSecret,
  });
  const token = res.data?.accessToken as string;
  const expireInSec = Number(res.data?.expireIn ?? 0) || 7200;
  tokenCache.set(key, {
    token,
    expiryMs: Date.now() + expireInSec * 1000 + TOKEN_CACHE_TTL_MS,
  });
  return token;
}

/**
 * Send a plain-text message.
 * @param target conversationId (group) or userId (single chat)
 * @param isGroup routes to groupMessages/send vs oToMessages/batchSend
 * @param atUserIds when replying in a GROUP, @ these users (DingTalk staffIds —
 *   the plaintext user id must go through msgParam.at.atUserIds; appending
 *   "@id" to the content only works for the encrypted chatbotUserId form).
 */
export async function sendDingtalkText(
  cfg: DingtalkCredentials,
  target: string,
  text: string,
  isGroup: boolean,
  atUserIds?: string[],
): Promise<void> {
  const token = await getAccessToken(cfg);

  if (isGroup) {
    const msgParam: Record<string, any> = { content: text };
    const ids = (atUserIds ?? []).filter(Boolean);
    if (ids.length) msgParam.at = { atUserIds: ids };
    await axios.post(
      `${DINGTALK_API}/v1.0/robot/groupMessages/send`,
      {
        robotCode: cfg.clientId,
        openConversationId: target,
        msgParam: JSON.stringify(msgParam),
        msgKey: "sampleText",
      },
      { headers: { "x-acs-dingtalk-access-token": token } },
    );
  } else {
    const content = JSON.stringify({ content: text });
    await axios.post(
      `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`,
      {
        robotCode: cfg.clientId,
        userIds: [target],
        msgParam: content,
        msgKey: "sampleText",
      },
      { headers: { "x-acs-dingtalk-access-token": token } },
    );
  }
}

/**
 * Send a markdown message. SampleMarkdown renders code blocks with syntax
 * highlighting — the reply format for single chats where readability of
 * code/lists matters. Group replies stay on sampleText so @ works.
 */
export async function sendDingtalkMarkdown(
  cfg: DingtalkCredentials,
  target: string,
  title: string,
  markdown: string,
  isGroup: boolean,
): Promise<void> {
  const token = await getAccessToken(cfg);
  const msgParam = JSON.stringify({ title, text: markdown });

  if (isGroup) {
    await axios.post(
      `${DINGTALK_API}/v1.0/robot/groupMessages/send`,
      {
        robotCode: cfg.clientId,
        openConversationId: target,
        msgParam,
        msgKey: "sampleMarkdown",
      },
      { headers: { "x-acs-dingtalk-access-token": token } },
    );
  } else {
    await axios.post(
      `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`,
      {
        robotCode: cfg.clientId,
        userIds: [target],
        msgParam,
        msgKey: "sampleMarkdown",
      },
      { headers: { "x-acs-dingtalk-access-token": token } },
    );
  }
}

/**
 * Send an image message referencing a media_id previously uploaded via
 * uploadDingtalkMedia.
 */
export async function sendDingtalkImage(
  cfg: DingtalkCredentials,
  target: string,
  mediaId: string,
  isGroup: boolean,
): Promise<void> {
  const token = await getAccessToken(cfg);
  const msgParam = JSON.stringify({ photoURL: mediaId });

  if (isGroup) {
    await axios.post(
      `${DINGTALK_API}/v1.0/robot/groupMessages/send`,
      {
        robotCode: cfg.clientId,
        openConversationId: target,
        msgParam,
        msgKey: "sampleImageMsg",
      },
      { headers: { "x-acs-dingtalk-access-token": token } },
    );
  } else {
    await axios.post(
      `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`,
      {
        robotCode: cfg.clientId,
        userIds: [target],
        msgParam,
        msgKey: "sampleImageMsg",
      },
      { headers: { "x-acs-dingtalk-access-token": token } },
    );
  }
}

/**
 * Send a file message referencing a media_id previously uploaded via
 * uploadDingtalkMedia.
 */
export async function sendDingtalkFile(
  cfg: DingtalkCredentials,
  target: string,
  mediaId: string,
  fileName: string,
  isGroup: boolean,
): Promise<void> {
  const token = await getAccessToken(cfg);
  const msgParam = JSON.stringify({ mediaId, fileName });

  if (isGroup) {
    await axios.post(
      `${DINGTALK_API}/v1.0/robot/groupMessages/send`,
      {
        robotCode: cfg.clientId,
        openConversationId: target,
        msgParam,
        msgKey: "sampleFile",
      },
      { headers: { "x-acs-dingtalk-access-token": token } },
    );
  } else {
    await axios.post(
      `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`,
      {
        robotCode: cfg.clientId,
        userIds: [target],
        msgParam,
        msgKey: "sampleFile",
      },
      { headers: { "x-acs-dingtalk-access-token": token } },
    );
  }
}

/**
 * Reply through the per-session webhook that DingTalk ships on every inbound
 * message (sessionWebhook). Group-only channel: unlike the v1.0 robot API
 * (whose sampleText msgParam has NO at support), the webhook endpoint honors
 * `at.atUserIds` — this is the only path that can actually @ members.
 */
export async function sendDingtalkWebhook(
  webhook: string,
  text: string,
  atUserIds?: string[],
  title: string = "Pi Desktop",
): Promise<void> {
  const at = (atUserIds ?? []).filter(Boolean);
  await axios.post(
    webhook,
    {
      msgtype: "markdown",
      markdown: { title, text },
      ...(at.length ? { at: { atUserIds: at, isAtAll: false } } : {}),
    },
    { headers: { "Content-Type": "application/json" } },
  );
}
