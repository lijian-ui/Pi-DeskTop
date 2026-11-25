/**
 * Session flush — lets the live agent decide what is worth remembering.
 *
 * The previous implementation ran a separate `completeSimple` request (or a
 * `pi -p` subprocess) on `session_before_compact` / `session_shutdown`. Two
 * problems:
 *
 *  1. The SDK aborts the session BEFORE emitting `session_shutdown`
 *     (agent-session-runtime.teardownCurrent: abort → emit → dispose), so no
 *     turn can run at that point.
 *  2. With Pi's built-in compaction disabled and the compress extension
 *     rewriting the view each turn, `session_before_compact` is almost never
 *     emitted — the switch was effectively dead.
 *
 * New model:
 *  - `agent_end` samples the size of the view actually sent to the model.
 *    A drop of FLUSH_DROP_EVENT_MIN_TOKENS+ counts as one compression event.
 *  - Once enough events / tokens accumulated (merged trigger) — and the
 *    cooldown has passed — a hidden custom message is injected with
 *    `triggerTurn: true`. Custom messages become `role: "user"` for the LLM
 *    but are not rendered (display: false), so the agent decides by itself
 *    whether to call memory_add. The full prefix stays cacheable.
 *  - `session_shutdown` only writes a millisecond-level snapshot; the next
 *    `session_start` drains it through the direct completion path.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { MemoryStore } from "../store/memory-store";
import { DatabaseManager } from "../store/db";
import {
  buildMemoryTargetRoutingGuidance,
  DIRECT_FLUSH_SYSTEM_PROMPT,
  ENTRY_DELIMITER,
  FLUSH_ACCUM_EVENTS,
  FLUSH_ACCUM_TOKENS,
  FLUSH_COOLDOWN_MS,
  FLUSH_DROP_EVENT_MIN_TOKENS,
  PENDING_FLUSH_MAX_AGE_MS,
  PENDING_FLUSH_MAX_ATTEMPTS,
  PENDING_FLUSH_MIN_CHARS,
  PENDING_FLUSH_MAX_CHARS,
  PENDING_FLUSH_RECENT_PARTS,
  PENDING_FLUSH_RECENT_FLUSH_WINDOW_MS,
} from "../constants";
import type { MemoryConfig } from "../types";
import { measureLifecycle } from "../lifecycle-timing";
import { collectMessageParts, safeSessionId } from "./message-parts";
import { runDirectMemoryCompletion } from "./review-memory-ops";
import {
  bumpPendingAttempt,
  deletePendingFlush,
  listPendingFlushes,
  writePendingFlush,
} from "./pending-flush";

function buildDirectFlushUserPrompt(
  store: MemoryStore,
  parts: string[],
): string {
  const sections = [
    "--- Current Memory ---",
    store.getMemoryEntries().join(ENTRY_DELIMITER) || "(empty)",
    "",
    "--- Current User Profile ---",
    store.getUserEntries().join(ENTRY_DELIMITER) || "(empty)",
  ];

  sections.push(
    "",
    "--- Conversation ---",
    parts.join("\n\n"),
  );

  return sections.join("\n");
}

/** The hidden user-role notice that asks the live agent to decide. */
function buildFlushNotice(droppedTokens: number, compressionEvents: number): string {
  return [
    `刚才的上下文被压缩（累计丢弃约 ${droppedTokens} tokens，共 ${compressionEvents} 次压缩）。`,
    "如果其中有值得跨会话保留的用户偏好、纠正、约定或教训，请用 memory_add 保存；",
    "没有就忽略这条消息，不要为它额外搜索或展开其它任务。",
  ].join("");
}

/** Keep the most recent parts up to `maxChars` (the catch-up prompt is unbounded otherwise). */
function tailByChars(parts: string[], maxChars: number): string[] {
  let total = 0;
  const out: string[] = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (total + part.length > maxChars) {
      if (out.length === 0) out.push(part.slice(-maxChars));
      break;
    }
    out.push(part);
    total += part.length;
  }
  return out.reverse();
}

/** `agent_end` ctx surface we depend on (kept structural to avoid over-typing). */
interface ContextUsageProbe {
  getContextUsage?: () => { tokens: number | null } | undefined;
}

let drainInFlight = false;

export function setupSessionFlush(
  pi: ExtensionAPI,
  store: MemoryStore,
  config: MemoryConfig,
  dbManager: DatabaseManager | null = null,
  deps: { runDirectMemoryCompletion?: typeof runDirectMemoryCompletion } = {},
): void {
  const runDirect = deps.runDirectMemoryCompletion ?? runDirectMemoryCompletion;

  /** High-water mark of the tokens actually sent to the model. */
  let highWaterTokens = 0;
  let accumDrops = 0;
  let accumTokens = 0;
  let lastFlushAt = 0;
  /** Notice waiting to ride along with the next request (no extra turn). */
  let pendingNotice: string | null = null;

  // ── 1. Compression-triggered flush (merged trigger) ──
  pi.on("agent_end", (_event, ctx) => {
    if (!config.autoDeposit) return;

    const usage = (ctx as unknown as ContextUsageProbe).getContextUsage?.();
    const tokens = usage?.tokens ?? null;
    if (tokens === null || tokens <= 0) return;

    // Normal growth: just track the high-water mark.
    if (tokens >= highWaterTokens) {
      highWaterTokens = tokens;
      return;
    }

    const drop = highWaterTokens - tokens;
    highWaterTokens = tokens;
    if (drop < FLUSH_DROP_EVENT_MIN_TOKENS) return;

    accumDrops += 1;
    accumTokens += drop;

    if (accumDrops < FLUSH_ACCUM_EVENTS && accumTokens < FLUSH_ACCUM_TOKENS) return;

    const now = Date.now();
    if (lastFlushAt > 0 && now - lastFlushAt < FLUSH_COOLDOWN_MS) return;

    const dropped = accumTokens;
    const events = accumDrops;
    accumDrops = 0;
    accumTokens = 0;
    lastFlushAt = now;
    // 不另起一轮：提示搭在下一次请求上，避免 UI 里冒出一条无来源的助手回复。
    pendingNotice = buildFlushNotice(dropped, events);
  });

  // 把待发提示附到最后一条 user 消息末尾（与 <memory-hint> 同一机制）。
  pi.on("context", async (event, _ctx) => {
    const notice = pendingNotice;
    if (!notice) return;
    const messages = (event as { messages?: AgentMessage[] }).messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        lastUser = i;
        break;
      }
    }
    // 没有可挂载的 user 消息时保留提示，等下一轮再试。
    if (lastUser < 0) return;

    pendingNotice = null;
    const original = messages[lastUser] as { role?: string; content?: unknown };
    const rawContent = original.content;
    const content = Array.isArray(rawContent)
      ? (rawContent as unknown[])
      : [{ type: "text", text: String(rawContent ?? "") }];
    const next = [...messages];
    next[lastUser] = {
      ...(original as object),
      content: [...content, { type: "text", text: `\n\n${notice}` }],
    } as AgentMessage;
    return { messages: next };
  });

  // ── 2. Shutdown: snapshot only (no LLM work while the SDK tears down) ──
  pi.on("session_shutdown", async (event, ctx) => {
    if (!config.autoDeposit || event.reason === "reload") return;
    await measureLifecycle("shutdown.snapshot", async () => {
      try {
        const entries = ctx.sessionManager.getBranch();
        const parts = tailByChars(
          collectMessageParts(entries, PENDING_FLUSH_RECENT_PARTS),
          PENDING_FLUSH_MAX_CHARS,
        );
        // Skip one-or-two-liner sessions: not worth a catch-up LLM call.
        if (parts.join("").length < PENDING_FLUSH_MIN_CHARS) return;
        const sessionId = safeSessionId(ctx);
        const recentFlush =
          lastFlushAt > 0 && Date.now() - lastFlushAt < PENDING_FLUSH_RECENT_FLUSH_WINDOW_MS;
        if (sessionId) writePendingFlush(sessionId, parts, recentFlush);
      } catch {
        // Context already stale — nothing to snapshot.
      }
    });
  });

  // ── 3. Next start: drain snapshots left by previous shutdowns ──
  // Fire-and-forget: draining can take up to one timeout per snapshot, and
  // awaiting it here would delay the new session from becoming usable.
  pi.on("session_start", (_event, ctx) => {
    if (drainInFlight) return;
    drainInFlight = true;
    void (async () => {
      try {
        const files = listPendingFlushes();
        for (const { file, snapshot } of files) {
          const tooOld = Date.now() - snapshot.createdAt > PENDING_FLUSH_MAX_AGE_MS;
          if (tooOld || snapshot.attempts >= PENDING_FLUSH_MAX_ATTEMPTS) {
            deletePendingFlush(file);
            continue;
          }
          const userPrompt = buildDirectFlushUserPrompt(store, snapshot.parts)
            + (snapshot.recentFlush
              ? "\n\nNOTE: this conversation was already reviewed for memories right before it closed. Only save facts that are clearly missing from the current memory above."
              : "");
          const result = await runDirect(
            ctx as Pick<ExtensionContext, "model" | "modelRegistry">,
            store,
            {
              systemPrompt: [
                DIRECT_FLUSH_SYSTEM_PROMPT,
                "",
                buildMemoryTargetRoutingGuidance(),
              ].join("\n"),
              userPrompt,
              config,
              timeoutMs: 60000,
              guardConfig: config.guard,
              sourceSessionId: snapshot.sessionId,
            },
            dbManager,
          );
          if (result.ok) deletePendingFlush(file);
          else bumpPendingAttempt(file, snapshot);
        }
      } catch {
        // Best-effort catch-up; snapshots stay for the next start.
      } finally {
        drainInFlight = false;
      }
    })();
  });
}
