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
 * @param atUserIds retained for signature parity only — the v1.0 robot API's
 *   sampleText msgParam has NO at support (verified against DingTalk docs),
 *   so group fallback text can't @. Use the session webhook for @.
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
 *
 * DingTalk's markdown message endpoint caps a single message; over-long
 * replies are silently truncated or downgraded to plain text by the
 * client. We split by paragraph (double-newline) and fall back to a hard
 * character cut when a single block exceeds the limit, sending multiple
 * markdown messages back-to-back so the user gets the full reply.
 */
export async function sendDingtalkMarkdown(
  cfg: DingtalkCredentials,
  target: string,
  title: string,
  markdown: string,
  isGroup: boolean,
  chunkLimit: number = 2000,
): Promise<void> {
  for (const chunk of chunkMarkdown(markdown, chunkLimit)) {
    await sendOneDingtalkMarkdown(cfg, target, title, chunk, isGroup);
  }
}

async function sendOneDingtalkMarkdown(
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

/** Split markdown into chunks ≤ limit; never breaks inside a paragraph
 *  unless the paragraph itself is too big. */
function chunkMarkdown(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  const parts = text.split(/\n\s*\n/);
  let cur = "";
  for (const p of parts) {
    const sep = cur ? "\n\n" : "";
    if (cur && (cur.length + sep.length + p.length) > limit) {
      chunks.push(cur);
      cur = "";
    }
    if (p.length <= limit) {
      cur = cur ? `${cur}${sep}${p}` : p;
    } else {
      // Single paragraph exceeds the limit — flush current and hard-cut.
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
 * (which has NO @ support), the webhook endpoint can render mentions. The
 * exact at field/ID form is not well documented for enterprise robots — send
 * BOTH the plaintext staffId (at.userIds) and the encrypted senderId
 * (at.atDingtalkIds) so whichever one the client honors actually renders.
 */
export async function sendDingtalkWebhook(
  webhook: string,
  text: string,
  atUserIds?: string[],
  title: string = "Pi Desktop",
  atDingtalkIds?: string[],
): Promise<void> {
  const userIds = (atUserIds ?? []).filter(Boolean);
  const dingtalkIds = (atDingtalkIds ?? []).filter(Boolean);
  if (!userIds.length && !dingtalkIds.length) {
    await axios.post(
      webhook,
      { msgtype: "markdown", markdown: { title, text } },
      { headers: { "Content-Type": "application/json" } },
    );
    return;
  }
  await axios.post(
    webhook,
    {
      msgtype: "markdown",
      markdown: { title, text },
      at: {
        ...(userIds.length ? { userIds } : {}),
        ...(dingtalkIds.length ? { atDingtalkIds: dingtalkIds } : {}),
        isAtAll: false,
      },
    },
    { headers: { "Content-Type": "application/json" } },
  );
}
