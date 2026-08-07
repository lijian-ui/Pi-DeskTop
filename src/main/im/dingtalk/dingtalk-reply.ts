/**
 * DingTalk reply dispatch (P0: plain text). Ported from
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
 */
export async function sendDingtalkText(
  cfg: DingtalkCredentials,
  target: string,
  text: string,
  isGroup: boolean,
): Promise<void> {
  const token = await getAccessToken(cfg);
  const content = JSON.stringify({ content: text });

  if (isGroup) {
    await axios.post(
      `${DINGTALK_API}/v1.0/robot/groupMessages/send`,
      {
        robotCode: cfg.clientId,
        openConversationId: target,
        msgParam: content,
        msgKey: "sampleText",
      },
      { headers: { "x-acs-dingtalk-access-token": token } },
    );
  } else {
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
