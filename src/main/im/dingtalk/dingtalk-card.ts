/**
 * DingTalk AI Card streaming (ported from dingtalk-openclaw-connector, MIT —
 * protocol code only; OpenClaw framework parts dropped).
 *
 * Lifecycle:
 *   createCard()  → POST /v1.0/card/instances (card instance)
 *                 → POST /v1.0/card/instances/deliver (deliver to user/group)
 *   streamCard()  → PUT /v1.0/card/streaming (incremental content updates)
 *   finishCard()  → final streaming frame + PUT /v1.0/card/instances (FINISHED)
 *
 * The whole path is rate-limited by a global token bucket (DingTalk caps at
 * ~40 req/s; we stay at 20) with a 2s backoff + one retry on QPS errors.
 */
import axios from "axios";

const DINGTALK_API = "https://api.dingtalk.com";
const AI_CARD_TEMPLATE_ID = "02fcf2f4-5e02-4a85-b672-46d1f715543e.schema";
const CARD_API_MAX_QPS = 20;
const QPS_BACKOFF_DURATION_MS = 2_000;
const TOKEN_EXPIRE_MS = 2 * 60 * 60 * 1000; // DingTalk access token TTL

/** Card flow status codes (DingTalk AI Card protocol). */
const AICardStatus = {
  PROCESSING: "1",
  INPUTING: "2",
  FINISHED: "3",
  EXECUTING: "4",
  FAILED: "5",
} as const;

export interface AICardTarget {
  type: "user" | "group";
  /** userId for user DMs, openConversationId for groups. */
  targetId: string;
}

export interface AICardInstance {
  cardInstanceId: string;
  accessToken: string;
  tokenExpireTime: number;
  inputingStarted: boolean;
}

interface DingtalkCredentials {
  clientId: string;
  clientSecret: string;
}

// ── token cache (same pattern as dingtalk-reply.ts) ──
const tokenCache = new Map<string, { token: string; expiryMs: number }>();

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
    expiryMs: Date.now() + expireInSec * 1000,
  });
  return token;
}

// ── global token bucket (QPS guard, shared across all cards) ──
class TokenBucket {
  private tokens = CARD_API_MAX_QPS;
  private lastRefill = Date.now();
  private backoffUntil = 0;

  async waitForToken(): Promise<number> {
    for (;;) {
      const now = Date.now();
      if (now < this.backoffUntil) {
        await sleep(this.backoffUntil - now);
        continue;
      }
      const elapsed = (now - this.lastRefill) / 1000;
      this.tokens = Math.min(CARD_API_MAX_QPS, this.tokens + elapsed * CARD_API_MAX_QPS);
      this.lastRefill = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return 0;
      }
      const waitMs = Math.ceil(((1 - this.tokens) / CARD_API_MAX_QPS) * 1000);
      await sleep(waitMs);
    }
  }

  triggerBackoff() {
    this.backoffUntil = Date.now() + QPS_BACKOFF_DURATION_MS;
    this.tokens = 0;
  }
}

const cardRateLimiter = new TokenBucket();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isQpsLimitError(err: any): boolean {
  const msg = `${err?.message ?? ""} ${err?.response?.data?.message ?? ""}`.toLowerCase();
  return msg.includes("qps") || msg.includes("rate limit") || msg.includes("too many");
}

// ── card API ──

function buildDeliverBody(
  cardInstanceId: string,
  target: AICardTarget,
  robotCode: string,
): any {
  const base = { outTrackId: cardInstanceId, userIdType: 1 };
  if (target.type === "group") {
    return {
      ...base,
      openSpaceId: `dtv1.card//IM_GROUP.${target.targetId}`,
      imGroupOpenDeliverModel: { robotCode },
    };
  }
  return {
    ...base,
    openSpaceId: `dtv1.card//IM_ROBOT.${target.targetId}`,
    imRobotOpenDeliverModel: {
      spaceType: "IM_ROBOT",
      robotCode,
      extension: { dynamicSummary: "true" },
    },
  };
}

/** Create a card instance and deliver it to the target. */
export async function createDingtalkCard(
  cfg: DingtalkCredentials,
  target: AICardTarget,
): Promise<AICardInstance | null> {
  try {
    const token = await getAccessToken(cfg);
    const cardInstanceId = `card_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    const createBody = {
      cardTemplateId: AI_CARD_TEMPLATE_ID,
      outTrackId: cardInstanceId,
      cardData: {
        cardParamMap: {
          config: JSON.stringify({ autoLayout: true }),
        },
      },
      callbackType: "STREAM",
      imGroupOpenSpaceModel: { supportForward: true },
      imRobotOpenSpaceModel: { supportForward: true },
    };
    await axios.post(`${DINGTALK_API}/v1.0/card/instances`, createBody, {
      headers: {
        "x-acs-dingtalk-access-token": token,
        "Content-Type": "application/json",
      },
    });

    const deliverBody = buildDeliverBody(cardInstanceId, target, String(cfg.clientId ?? ""));
    await axios.post(`${DINGTALK_API}/v1.0/card/instances/deliver`, deliverBody, {
      headers: {
        "x-acs-dingtalk-access-token": token,
        "Content-Type": "application/json",
      },
    });

    return {
      cardInstanceId,
      accessToken: token,
      tokenExpireTime: Date.now() + TOKEN_EXPIRE_MS,
      inputingStarted: false,
    };
  } catch (err: any) {
    console.error(`[im:dingtalk] AI Card create failed:`, err?.message);
    return null;
  }
}

async function ensureValidToken(
  card: AICardInstance,
  cfg: DingtalkCredentials,
): Promise<string> {
  if (Date.now() > card.tokenExpireTime - 5 * 60 * 1000) {
    const newToken = await getAccessToken(cfg);
    card.accessToken = newToken;
    card.tokenExpireTime = Date.now() + TOKEN_EXPIRE_MS;
  }
  return card.accessToken;
}

/** Incrementally update the card content (finished=true finalizes the text). */
export async function streamDingtalkCard(
  card: AICardInstance,
  content: string,
  finished: boolean = false,
  cfg?: DingtalkCredentials,
): Promise<void> {
  if (!card) return;
  if (cfg) await ensureValidToken(card, cfg);

  if (!card.inputingStarted) {
    await cardRateLimiter.waitForToken();
    const statusBody = {
      outTrackId: card.cardInstanceId,
      cardData: {
        cardParamMap: {
          flowStatus: AICardStatus.INPUTING,
          msgContent: content,
          staticMsgContent: "",
          sys_full_json_obj: JSON.stringify({ order: ["msgContent"] }),
          config: JSON.stringify({ autoLayout: true }),
        },
      },
    };
    try {
      await axios.put(`${DINGTALK_API}/v1.0/card/instances`, statusBody, {
        headers: {
          "x-acs-dingtalk-access-token": card.accessToken,
          "Content-Type": "application/json",
        },
      });
    } catch (err: any) {
      if (isQpsLimitError(err)) {
        cardRateLimiter.triggerBackoff();
        await cardRateLimiter.waitForToken();
        await axios.put(`${DINGTALK_API}/v1.0/card/instances`, statusBody, {
          headers: {
            "x-acs-dingtalk-access-token": card.accessToken,
            "Content-Type": "application/json",
          },
        });
      } else {
        throw err;
      }
    }
    card.inputingStarted = true;
  }

  const fixedContent = content;
  const streamContent = finished ? fixedContent : fixedContent.replace(/\n+$/, "");
  const body = {
    outTrackId: card.cardInstanceId,
    guid: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    key: "msgContent",
    content: streamContent,
    isFull: true,
    isFinalize: finished,
    isError: false,
  };

  await cardRateLimiter.waitForToken();
  try {
    await axios.put(`${DINGTALK_API}/v1.0/card/streaming`, body, {
      headers: {
        "x-acs-dingtalk-access-token": card.accessToken,
        "Content-Type": "application/json",
      },
    });
  } catch (err: any) {
    if (isQpsLimitError(err)) {
      cardRateLimiter.triggerBackoff();
      await cardRateLimiter.waitForToken();
      body.guid = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await axios.put(`${DINGTALK_API}/v1.0/card/streaming`, body, {
        headers: {
          "x-acs-dingtalk-access-token": card.accessToken,
          "Content-Type": "application/json",
        },
      });
    } else {
      throw err;
    }
  }
}

/** Finalize the card (FINISHED status — removes the loading animation). */
export async function finishDingtalkCard(
  card: AICardInstance,
  content: string,
  cfg?: DingtalkCredentials,
  /** Skip the streaming finalize frame (PUT /card/streaming with
   *  isFinalize=true). That endpoint caps a single content frame at ~1K;
   *  long replies would be truncated with "***". Skipping it lets the
   *  FINISHED PUT below carry the full text directly. */
  skipStreamFinalize: boolean = false,
): Promise<void> {
  if (!card) return;
  if (cfg) await ensureValidToken(card, cfg);
  const fixedContent = content;

  if (!skipStreamFinalize) {
    await streamDingtalkCard(card, fixedContent, true, cfg);
  }

  const body = {
    outTrackId: card.cardInstanceId,
    cardData: {
      cardParamMap: {
        flowStatus: AICardStatus.FINISHED,
        msgContent: fixedContent,
        staticMsgContent: "",
        sys_full_json_obj: JSON.stringify({ order: ["msgContent"] }),
        config: JSON.stringify({ autoLayout: true }),
      },
    },
    cardUpdateOptions: { updateCardDataByKey: true },
  };
  await cardRateLimiter.waitForToken();
  try {
    await axios.put(`${DINGTALK_API}/v1.0/card/instances`, body, {
      headers: {
        "x-acs-dingtalk-access-token": card.accessToken,
        "Content-Type": "application/json",
      },
    });
  } catch (err: any) {
    if (isQpsLimitError(err)) {
      cardRateLimiter.triggerBackoff();
      await cardRateLimiter.waitForToken();
      await axios.put(`${DINGTALK_API}/v1.0/card/instances`, body, {
        headers: {
          "x-acs-dingtalk-access-token": card.accessToken,
          "Content-Type": "application/json",
        },
      });
    } else {
      console.error(`[im:dingtalk] AI Card FINISHED failed:`, err?.message);
    }
  }
}
