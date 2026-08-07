/**
 * DingTalk channel adapter — implements ImChannelAdapter over the stream
 * connection. Converts DingTalk bot messages into ImInboundMessage and routes
 * replies back via the robot REST API. One instance per configured robot.
 */
import type {
  ImChannelAdapter,
  ImInboundMessage,
  ImStatus,
} from "../types";
import type { ImChannelInstance } from "../im-config";
import { DingtalkConnection } from "./dingtalk-connection";
import { sendDingtalkText } from "./dingtalk-reply";
import {
  createDingtalkCard,
  streamDingtalkCard,
  finishDingtalkCard,
  type AICardInstance,
  type AICardTarget,
} from "./dingtalk-card";

interface DingtalkMessageData {
  senderStaffId?: string;
  senderId?: string;
  conversationId?: string;
  conversationType?: string; // "1" single, "2" group
  msgtype?: string;
  text?: { content?: string };
  msgId?: string;
  isInAtList?: boolean;
  senderNick?: string;
}

export class DingtalkAdapter implements ImChannelAdapter {
  readonly channel = "dingtalk";
  readonly instanceId: string;
  readonly name: string;
  private conn: DingtalkConnection | null = null;
  private status: ImStatus = "off";
  /** peer → isGroup, learned from inbound messages (reply routing needs it). */
  private peerInfo = new Map<string, boolean>();

  onMessage?: (msg: ImInboundMessage) => void;
  onStatusChange?: (status: ImStatus) => void;

  constructor(private readonly inst: ImChannelInstance) {
    this.instanceId = inst.id;
    this.name = inst.name;
  }

  private get clientId(): string {
    return this.inst.config?.clientId ?? "";
  }
  private get clientSecret(): string {
    return this.inst.config?.clientSecret ?? "";
  }

  private setStatus(s: ImStatus) {
    this.status = s;
    this.onStatusChange?.(s);
  }

  async start(): Promise<void> {
    if (this.conn) await this.stop();
    this.setStatus("connecting");
    this.conn = new DingtalkConnection({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      onMessage: (rawData) => this.handleRaw(rawData),
      onStatusChange: (connected) =>
        this.setStatus(connected ? "connected" : "connecting"),
    });
    try {
      await this.conn.connect();
      this.setStatus("connected");
    } catch (err) {
      this.setStatus("error");
      throw err;
    }
  }

  async stop(): Promise<void> {
    await this.conn?.stop();
    this.conn = null;
    this.setStatus("off");
  }

  getStatus(): ImStatus {
    return this.status;
  }

  private handleRaw(rawData: string) {
    let data: DingtalkMessageData;
    try {
      data = JSON.parse(rawData);
    } catch {
      return; // ignore non-JSON frames
    }
    if (data.msgtype !== "text" || !data.text?.content) return;
    if (data.conversationType !== "1" && data.conversationType !== "2") return;

    const isGroup = data.conversationType === "2";
    const peer = isGroup
      ? data.conversationId ?? ""
      : data.senderStaffId ?? data.senderId ?? "";
    if (!peer) return;

    // Group messages must @ the bot; ignore otherwise (avoids noise).
    if (isGroup && !data.isInAtList) return;

    this.peerInfo.set(peer, isGroup);
    this.onMessage?.({
      channel: "dingtalk",
      // instanceId isolates conversations between multiple robots on the same
      // platform: `${channel}:${instanceId}:${peer}`
      sessionKey: `dingtalk:${this.instanceId}:${peer}`,
      text: data.text.content,
      raw: { isGroup, senderNick: data.senderNick, msgId: data.msgId },
    });
  }

  async sendText(target: string, text: string): Promise<void> {
    // Infer single/group from the most recent inbound message for this peer;
    // default to group (safer endpoint) if unknown.
    const isGroup = this.peerInfo.get(target) ?? true;
    await sendDingtalkText(
      { clientId: this.clientId, clientSecret: this.clientSecret },
      target,
      text,
      isGroup,
    );
  }

  // ── AI Card streaming ──
  /** active card per peer — one streaming card at a time per conversation. */
  private cards = new Map<string, AICardInstance | null>();

  private cardTarget(target: string): AICardTarget {
    const isGroup = this.peerInfo.get(target) ?? true;
    return isGroup
      ? { type: "group", targetId: target }
      : { type: "user", targetId: target };
  }

  async beginStream(target: string): Promise<void> {
    // A new turn: drop any previous card for this peer.
    const prev = this.cards.get(target);
    if (prev) {
      this.cards.delete(target);
    }
    const card = await createDingtalkCard(
      { clientId: this.clientId, clientSecret: this.clientSecret },
      this.cardTarget(target),
    );
    this.cards.set(target, card ?? null);
    if (!card) {
      // Card creation failed — fall back to a "thinking…" text so the user
      // gets some feedback; streamText will be a no-op until endStream.
      await this.sendText(target, "⏳ 正在思考…").catch(() => {});
    }
  }

  async streamText(target: string, text: string, finished = false): Promise<void> {
    const card = this.cards.get(target);
    if (!card) return; // no active card — ignore (plain text fallback at end)
    try {
      await streamDingtalkCard(card, text, finished);
    } catch (err) {
      // Streaming failed (network / QPS) — drop the card so endStream won't
      // try to finalize a broken instance.
      this.cards.delete(target);
    }
  }

  async endStream(target: string, text: string): Promise<void> {
    const card = this.cards.get(target);
    this.cards.delete(target);
    if (!card) {
      // No card was created (or it failed) — fall back to plain text so the
      // reply is never lost.
      await this.sendText(target, text);
      return;
    }
    try {
      await finishDingtalkCard(card, text);
    } catch {
      // Finalize failed — send the plain text as a fallback.
      await this.sendText(target, text).catch(() => {});
    }
  }
}
