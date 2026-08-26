/**
 * Feishu/Lark WebSocket long-connection — built on @larksuiteoapi/node-sdk.
 *
 * - WSClient + EventDispatcher (no public callback URL needed)
 * - message dedup with 5-minute TTL (message_id scoped)
 * - AbortSignal-based graceful shutdown
 * - brand switch: Feishu (feishu.cn) vs Lark (larksuite.com)
 *
 * The SDK's WSClient handles reconnect internally; we add application-layer
 * dedup and a patch so card-action events (type="card") are routed through
 * the EventDispatcher (which only accepts type="event").
 */
import * as Lark from "@larksuiteoapi/node-sdk";

const DEDUP_TTL_MS = 5 * 60 * 1000;

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  /** "feishu" (default) or "lark" — selects the API domain. */
  brand?: "feishu" | "lark";
}

export interface FeishuConnectionOptions {
  credentials: FeishuCredentials;
  /** Fired for every im.message.receive_v1 event (after dedup + self-echo). */
  onMessage: (data: any) => void;
  /** Fired for card.action.trigger events (button clicks). */
  onCardAction?: (data: any) => void;
  onStatusChange?: (connected: boolean) => void;
  abortSignal?: AbortSignal;
}

export class FeishuConnection {
  private sdk: Lark.Client | null = null;
  private wsClient: any = null;
  private stopped = false;
  private dedup = new Map<string, number>();
  private botOpenId: string | null = null;
  private abortHandler: (() => void) | null = null;

  constructor(private readonly opts: FeishuConnectionOptions) {}

  get client(): Lark.Client {
    if (!this.sdk) throw new Error("FeishuConnection not started");
    return this.sdk;
  }

  get botOpenIdValue(): string | null {
    return this.botOpenId;
  }

  private resolveDomain(): Lark.Domain {
    return this.opts.credentials.brand === "lark"
      ? Lark.Domain.Lark
      : Lark.Domain.Feishu;
  }

  /** Mark a message id as processed (returns true if it was already seen). */
  private checkAndMark(msgId: string): boolean {
    const now = Date.now();
    for (const [k, ts] of this.dedup) {
      if (now - ts > DEDUP_TTL_MS) this.dedup.delete(k);
    }
    if (this.dedup.has(msgId)) return true;
    this.dedup.set(msgId, now);
    return false;
  }

  async start(): Promise<void> {
    if (this.sdk) return;
    const { appId, appSecret, encryptKey, verificationToken } = this.opts.credentials;
    this.sdk = new Lark.Client({
      appId,
      appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: this.resolveDomain(),
    });

    // Probe bot identity (open_id + name) for self-echo filtering and @-mention
    // detection. The ping endpoint is a custom openclaw extension; fall back
    // gracefully if it is unavailable (older SDK / non-openclaw bot).
    await this.probeBot().catch((err) => {
      console.warn("[im:feishu] bot probe failed (non-fatal):", err?.message);
    });

    const dispatcher = new Lark.EventDispatcher({
      encryptKey: encryptKey ?? "",
      verificationToken: verificationToken ?? "",
    });
    dispatcher.register({
      "im.message.receive_v1": async (data: any) => {
        this.handleMessageEvent(data);
      },
      "card.action.trigger": async (data: any) => {
        this.opts.onCardAction?.(data);
      },
    });

    this.wsClient = new Lark.WSClient({
      appId,
      appSecret,
      domain: this.resolveDomain(),
      loggerLevel: Lark.LoggerLevel.info,
    });

    // Patch: the SDK's handleEventData only routes type="event"; card actions
    // arrive as type="card" and would be silently dropped. Rewrite the header
    // so the EventDispatcher can process them (same technique as openclaw-lark).
    const wsAny = this.wsClient as any;
    if (wsAny?.handleEventData) {
      const orig = wsAny.handleEventData.bind(wsAny);
      wsAny.handleEventData = (d: any) => {
        const hdr = d?.headers;
        const typeHdr = hdr?.find?.((h: any) => h.key === "type");
        if (typeHdr?.value === "card") {
          const patched = {
            ...d,
            headers: hdr.map((h: any) =>
              h.key === "type" ? { ...h, value: "event" } : h,
            ),
          };
          return orig(patched);
        }
        return orig(d);
      };
    }

    // AbortSignal → graceful stop.
    if (this.opts.abortSignal) {
      this.abortHandler = () => this.stop();
      this.opts.abortSignal.addEventListener("abort", this.abortHandler);
    }

    await this.wsClient.start({ eventDispatcher: dispatcher });
    this.opts.onStatusChange?.(true);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.abortHandler && this.opts.abortSignal) {
      this.opts.abortSignal.removeEventListener("abort", this.abortHandler);
      this.abortHandler = null;
    }
    try {
      this.wsClient?.close?.();
    } catch {
      /* ignore */
    }
    this.wsClient = null;
    this.sdk = null;
    this.opts.onStatusChange?.(false);
  }

  /** Probe the bot's own open_id via a custom ping API. */
  private async probeBot(): Promise<void> {
    const res = await (this.sdk as any).request({
      method: "POST",
      url: "/open-apis/bot/v1/openclaw_bot/ping",
      data: { needBotInfo: true },
    });
    const botInfo = res?.data?.pingBotInfo;
    if (botInfo?.botID) this.botOpenId = botInfo.botID;
  }

  private handleMessageEvent(data: any) {
    const msg = data?.message;
    if (!msg) return;
    const msgId = msg.message_id;
    if (!msgId) return;

    // Dedup (WebSocket reconnect can replay events).
    if (this.checkAndMark(msgId)) return;

    // Self-echo filter: drop messages sent by the bot itself.
    const senderOpenId = data?.sender?.sender_id?.open_id;
    if (senderOpenId && this.botOpenId && senderOpenId === this.botOpenId) return;

    // Expired message guard (reconnect replay of old messages).
    const createTime = Number(msg.create_time ?? 0);
    if (createTime && Date.now() - createTime > DEDUP_TTL_MS) return;

    this.opts.onMessage(data);
  }
}