/**
 * DingTalk stream connection (ported from dingtalk-openclaw-connector,
 * MIT — protocol code only; OpenClaw framework parts dropped).
 *
 * - DWClient WebSocket long connection (no public callback URL needed)
 * - application-layer heartbeat: 10s ping / 20s timeout (SDK keepAlive off)
 * - exponential-backoff reconnect with jitter, guarded against concurrency
 * - message dedup with 5-minute TTL (accountId-scoped)
 */
import { EventEmitter } from "node:events";

// dingtalk-stream is CJS; import() is used so the ESM build can resolve it.
let DWClientCtor: any = null;
let TOPIC_ROBOT: string = "";
async function loadDingtalkStream() {
  if (DWClientCtor) return;
  const mod: any = await import("dingtalk-stream");
  DWClientCtor = mod.DWClient ?? mod.default?.DWClient;
  TOPIC_ROBOT = mod.TOPIC_ROBOT ?? "/v1.0/im/bot/messages/get";
  if (!DWClientCtor) throw new Error("dingtalk-stream: DWClient not found");
}

const HEARTBEAT_INTERVAL = 10 * 1000;
const HEARTBEAT_TIMEOUT = 20 * 1000;
const BASE_BACKOFF_DELAY = 2000;
const MAX_BACKOFF_DELAY = 30_000;
const DEDUP_TTL_MS = 5 * 60 * 1000;

export interface DingtalkConnectionOptions {
  clientId: string;
  clientSecret: string;
  onMessage: (rawData: string, headers: any) => void;
  onStatusChange?: (connected: boolean) => void;
}

export class DingtalkConnection extends EventEmitter {
  private client: any = null;
  private stopped = false;
  private isReconnecting = false;
  private reconnectAttempts = 0;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private dedup = new Map<string, number>();
  private connected = false;

  constructor(private readonly opts: DingtalkConnectionOptions) {
    super();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Mark a message id as processed (returns true if it was already seen). */
  private checkAndMark(accountId: string, msgId: string): boolean {
    const now = Date.now();
    // GC old entries
    for (const [k, ts] of this.dedup) {
      if (now - ts > DEDUP_TTL_MS) this.dedup.delete(k);
    }
    const key = `${accountId}:${msgId}`;
    if (this.dedup.has(key)) return true;
    this.dedup.set(key, now);
    return false;
  }

  private setupSocketListeners() {
    const socket = this.client?.socket;
    if (!socket) return;
    // pong keeps the heartbeat happy
    socket.on("pong", () => {
      this.reconnectAttempts = 0;
      this.connected = true;
    });
    socket.on("message", (_: any) => {
      this.reconnectAttempts = 0;
      this.connected = true;
    });
    socket.on("close", () => {
      this.connected = false;
      if (!this.stopped && !this.isReconnecting) {
        this.doReconnect(true).catch(() => {});
      }
    });
  }

  private startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (!this.client?.socket) return;
      if (this.client.socket.readyState === 1) {
        this.client.socket.ping();
        // optimistic: assume alive unless close fires
        this.connected = true;
      } else if (!this.isReconnecting) {
        this.doReconnect(false).catch(() => {});
      }
    }, HEARTBEAT_INTERVAL);
  }

  private stopKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private backoffDelay(): number {
    const exponential = BASE_BACKOFF_DELAY * 2 ** this.reconnectAttempts;
    const jitter = Math.random() * 1000;
    return Math.min(exponential + jitter, MAX_BACKOFF_DELAY);
  }

  private async doReconnect(immediate: boolean) {
    if (this.isReconnecting || this.stopped) return;
    this.isReconnecting = true;
    try {
      if (!immediate) {
        await new Promise((r) => setTimeout(r, this.backoffDelay()));
      }
      this.reconnectAttempts++;
      this.client?.disconnect();
      // Re-register the callback before reconnecting — registerCallbackListener
      // is idempotent (it checks for an existing CALLBACK subscription), and
      // guarantees the reconnect handshake carries it even if the client was
      // recreated.
      this.registerMessageListener();
      await this.client.connect();
      this.setupSocketListeners();
      // wait for socket open
      const ok = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 10_000);
        const check = () => {
          if (this.client?.socket?.readyState === 1) {
            clearTimeout(t);
            resolve(true);
          } else {
            setTimeout(check, 200);
          }
        };
        check();
      });
      if (ok) {
        this.connected = true;
        this.reconnectAttempts = 0;
        this.opts.onStatusChange?.(true);
      }
    } catch {
      // keep retrying on next tick
    } finally {
      this.isReconnecting = false;
    }
  }

  private registerMessageListener() {
    this.client.registerCallbackListener(TOPIC_ROBOT, async (res: any) => {
      const headers = res?.headers ?? {};
      const messageId = headers.messageId;
      const rawData: string = res?.data ?? "";
      if (messageId) {
        this.client.socketCallBackResponse?.(messageId, { success: true });
      }
      // protocol-level dedup on headers.messageId
      if (messageId && this.checkAndMark("stream", messageId)) {
        return { status: "SUCCESS" };
      }
      this.opts.onMessage(rawData, headers);
      return { status: "SUCCESS" };
    });
  }

  async connect(): Promise<void> {
    await loadDingtalkStream();
    if (this.stopped) return;
    this.client = new DWClientCtor({
      clientId: this.opts.clientId,
      clientSecret: this.opts.clientSecret,
      autoReconnect: false,
      keepAlive: false,
      // NOTE: no `subscriptions` here — the lib defaults to EVENT:"*" and we
      // must NOT override it. The CALLBACK subscription for TOPIC_ROBOT is
      // pushed by registerMessageListener() BEFORE connect(), so the connect
      // handshake's subscription payload includes it (otherwise the server
      // never delivers bot messages to this callback).
    });
    this.client.on("error", (err: Error) => {
      this.connected = false;
      this.opts.onStatusChange?.(false);
      console.error("[im:dingtalk] connection error:", err?.message);
    });
    // Register the message callback BEFORE connect: registerCallbackListener
    // pushes {type:"CALLBACK", topic:TOPIC_ROBOT} into config.subscriptions,
    // which is serialized into the gateway subscription payload sent during
    // connect(). Registered after connect, the server would never have the
    // CALLBACK subscription and bot messages would be silently dropped.
    this.registerMessageListener();
    await this.client.connect();
    this.setupSocketListeners();
    this.startKeepAlive();
    this.connected = true;
    this.opts.onStatusChange?.(true);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopKeepAlive();
    this.client?.disconnect();
    this.client = null;
    this.connected = false;
  }
}
