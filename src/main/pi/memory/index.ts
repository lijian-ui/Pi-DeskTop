/**
 * Pi Hermes Memory Extension
 *
 * Brings Hermes-style persistent memory and a learning loop to any Pi user.
 * After `pi install`, users get:
 *
 * 1. Persistent Memory — MEMORY.md + USER.md that survive across sessions
 * 2. Session Flush — after context compression the running agent is asked to
 *    save what matters; sessions that quit before flushing leave a snapshot
 *    that the next session start drains
 * 3. Auto-Consolidation — merges memory when full instead of erroring
 * 4. Context Fencing — <memory-context> tags prevent injection through stored memory
 * 5. Memory Aging — entry timestamps guide consolidation
 *
 * NOTE (pi-desktop): the upstream `/memory-*` slash commands are deliberately
 * not registered. They report through ctx.ui.notify and several need terminal
 * modals — unusable in a desktop shell. See the "9. Register commands" note in
 * the factory body: memory is surfaced through the agent tools instead.
 *
 * See docs/ROADMAP.md for full roadmap and Hermes competitive analysis.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { MemoryStore } from "./store/memory-store";
import { touchMemoryByContent } from "./store/sqlite-memory-store";
import { DatabaseManager } from "./store/db";
import { indexSession, upsertSessionFileMetadata, pruneEphemeralReviewSessions, pruneOldSessions, retentionCutoffMs } from "./store/session-indexer";
import { runRecoveryMaintenance } from "./store/recovery-maintenance";
import { forgetStaleMemories } from "./handlers/forget-stale";
import { scheduleSessionBackfill, waitForSessionBackfill, SESSION_BACKFILL_SHUTDOWN_TIMEOUT_MS } from "./handlers/session-backfill";
import { scheduleLiveSessionIndex, waitForLiveSessionIndex, SESSION_LIVE_INDEX_SHUTDOWN_TIMEOUT_MS } from "./handlers/session-live-index";
import { parseSessionFile } from "./store/session-parser";
import { registerMemoryTool } from "./tools/memory-tool";
import { registerSessionSearchTool } from "./tools/session-search-tool";
import { registerMemorySearchTool } from "./tools/memory-search-tool";
import { setupSessionFlush } from "./handlers/session-flush";
import { migrateThenSyncMarkdownMemories } from "./handlers/sync-markdown-memories";
import { GUARD_RULES_FILENAME } from "./constants";
import { promoteAnchorsBeforeCompact, buildAnchorContextBlock } from "./anchors";
import { loadConfig } from "./config";
import type { MemoryConfig } from "./types";
import { maybeRotateSnapshot } from "./snapshot";
import { readMemoryExtensionConfigSync } from "./extension-config";
import { buildPromptContext } from "./prompt-context";
import { AGENT_ROOT } from "./paths";
import { isDatabaseMigrationPending } from "./extension-root-migration";
import { measureLifecycle, measureLifecycleSync } from "./lifecycle-timing";

/**
 * Live-mutable config holder. The extension's three auto-memory setups
 * (background review / session flush / correction detector) capture this object
 * reference once and read `config.xxx` at *trigger time*, so mutating the
 * object's fields in place makes hot-reload work without re-registering hooks.
 */
const liveConfigRef: { current: MemoryConfig | null } = { current: null };
/** Global memory dir resolved at mount time — reused by reloadMemoryConfig to
 * re-pin the co-located guard rules file after a hot reload. */
const liveGlobalDirRef: { current: string | null } = { current: null };

/**
 * 触发「轻量检索提示」的指代词/旧约定。
 * 刻意收窄：宁可漏报，也不要每轮都往用户消息里塞提示。
 */
const RETRIEVAL_HINT_TRIGGER = /(上次|之前|原来|以前|我们说好|说好的|按惯例|照旧|别再|不要再|还记得|\blast time\b|\bpreviously\b|\bas we agreed\b|\bas before\b|\bwe agreed\b)/i;
const RETRIEVAL_HINT_MARKER = "<memory-hint>";
const RETRIEVAL_HINT_SUFFIX = "\n\n<memory-hint>This request may depend on earlier decisions or preferences. Call memory_search before acting if it refers to prior context.</memory-hint>";

/**
 * 已计入引用的注入条目，按会话隔离。
 * 同一会话同一句只计一次，防止每轮注入把 access_count 刷爆。
 */
const countedInjectionsBySession = new Map<string, Set<string>>();

/** 取消息里的可见文本（content 可能是字符串或 {type:"text",text} 数组）。 */
function messageTextOf(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => (
      typeof block === "object"
      && block !== null
      && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string"
    ))
    .map((block) => block.text)
    .join("\n");
}

/**
 * Re-read hermes-memory-config.json from disk and apply it to the live config
 * object in place. Returns true when a live extension is mounted and updated.
 * Called by the desktop config panel so changes take effect without a restart.
 */
export function reloadMemoryConfig(): boolean {
  const live = liveConfigRef.current;
  if (!live) return false;
  const next = loadConfig();
  // Re-pin the co-located guard rules file: loadConfig() leaves rulesPath
  // undefined when the file omits it, and replacing guard wholesale would
  // otherwise drop the default resolved at mount time.
  const globalDir = liveGlobalDirRef.current;
  if (next.guard && globalDir) {
    next.guard.rulesPath = next.guard.rulesPath ?? path.join(globalDir, GUARD_RULES_FILENAME);
  }
  const liveRecord = live as unknown as Record<string, unknown>;
  for (const key of Object.keys(liveRecord)) {
    delete liveRecord[key];
  }
  Object.assign(live, next);
  return true;
}

/** Whether a live memory extension is currently mounted (config reloadable). */
export function hasLiveMemoryConfig(): boolean {
  return liveConfigRef.current !== null;
}

export default function (pi: ExtensionAPI) {
  // 总开关（设置 → 可用工具 → 扩展工具）：关 → 不注册任何工具/事件。
  if (!readMemoryExtensionConfigSync().enabled) {
    liveConfigRef.current = null;
    return;
  }
  const config = loadConfig();
  liveConfigRef.current = config;
  // Nested objects (ranking/anchors/guard) are replaced wholesale by
  // reloadMemoryConfig; pin the guard rulesPath default first so a reload
  // without that field still resolves to the co-located file.
  const agentRoot = AGENT_ROOT;
  const legacyGlobalDir = path.join(agentRoot, "memory");
  const defaultGlobalDir = path.join(agentRoot, "pi-hermes-memory");

  const configuredMemoryDir = config.memoryDir?.trim();
  const pointsToLegacyMemoryDir = configuredMemoryDir
    ? path.resolve(configuredMemoryDir) === path.resolve(legacyGlobalDir)
    : false;

  const globalDir = !configuredMemoryDir || pointsToLegacyMemoryDir
    ? defaultGlobalDir
    : configuredMemoryDir;

  // Co-locate the user guard rules file with the memory directory when not
  // overridden explicitly in config.
  if (config.guard) {
    config.guard.rulesPath = config.guard.rulesPath ?? path.join(globalDir, GUARD_RULES_FILENAME);
  }
  liveGlobalDirRef.current = globalDir;

  const shouldMigrateExtensionRoot = !configuredMemoryDir || pointsToLegacyMemoryDir;
  let persistenceInitialized = false;

  const store = new MemoryStore({ ...config, memoryDir: globalDir });
  // 注入即使用：touchEntryByText 更新的是 Markdown 的 last，access_count 只存在于
  // SQLite（排名与锚点阈值都读它），所以这里把计数转发给搜索镜像。
  const bindAccessObserver = (target: MemoryStore) => {
    target.setAccessObserver((rawTarget, text) => {
      try {
        touchMemoryByContent(dbManager, text, rawTarget);
      } catch {
        // 计数是尽力而为，绝不影响主流程。
      }
    });
  };
  const dbManager = new DatabaseManager(globalDir);
  bindAccessObserver(store);
  dbManager.setQuickCheckOnOpen(config.quickCheckOnOpen ?? true);
  let databaseMigrationPending = shouldMigrateExtensionRoot
    && isDatabaseMigrationPending(legacyGlobalDir, globalDir);
  if (databaseMigrationPending) {
    dbManager.setOpenGuard(() => {
      if (databaseMigrationPending) {
        throw new Error("Legacy sessions.db migration is pending");
      }
    });
  }
  const sessionsDir = path.join(agentRoot, "sessions");

  // ── 1. Load memory from disk on session start ──
  pi.on("session_start", async (_event, ctx) => {
    // 本会话的「注入即使用」去重表（同一句只计一次）。
    const sessionId = ctx.sessionManager.getSessionId();
    if (!countedInjectionsBySession.has(sessionId)) {
      countedInjectionsBySession.set(sessionId, new Set());
    }

    if (!persistenceInitialized) {
      try {
        await measureLifecycle("session-start.persistence-sync", async () => {
          await migrateThenSyncMarkdownMemories(
            dbManager,
            shouldMigrateExtensionRoot ? legacyGlobalDir : null,
            globalDir,
            {
              onMigrationSucceeded: () => {
                databaseMigrationPending = false;
                dbManager.setOpenGuard(null);
              },
            },
          );
        });
        persistenceInitialized = true;
      } catch {
        // Best-effort only: migration or SQLite backfill must not block startup.
      }
    }

    await measureLifecycle("session-start.load", async () => {
      await store.loadFromDisk();
    });

    if (persistenceInitialized) {
      try {
        pruneEphemeralReviewSessions(dbManager);
      } catch (err) {
        console.warn(`⚠️ Ephemeral session cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Prune sessions older than the configured retention window to bound the
      // size of the session index database (see #183). Runs before
      // scheduleSessionBackfill so pruned sessions are never re-indexed by a
      // backfill started in the same startup.
      if (config.sessionRetentionDays && config.sessionRetentionDays > 0) {
        try {
          const pruneResult = pruneOldSessions(dbManager, config.sessionRetentionDays);
          if (pruneResult.sessionsRemoved > 0) {
            console.info(
              `🧠 Pruned ${pruneResult.sessionsRemoved} old session(s) (> ${config.sessionRetentionDays} days old)`,
            );
          }
        } catch (err) {
          console.warn(`⚠️ Session pruning failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      try {
        await runRecoveryMaintenance({ config, globalDir });
      } catch (err) {
        console.warn(`⚠️ Snapshot retention sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        const forgotten = await forgetStaleMemories(store, dbManager, globalDir);
        if (forgotten.archived > 0) {
          console.info(`🧹 Forgot ${forgotten.archived} stale memories (archived to ${globalDir}/archive).`);
        }
      } catch (err) {
        console.warn(`⚠️ Stale memory sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      scheduleSessionBackfill(dbManager, sessionsDir, {
        notify: (message, level) => {
          const ui = (ctx as { ui?: { notify?: (message: string, level?: string) => void } }).ui;
          if (ui?.notify) {
            ui.notify(message, level);
          } else if (level === "error" || level === "warning") {
            console.warn(message);
          } else {
            console.info(message);
          }
        },
        // Exclude files older than the retention cutoff so sessions pruned by
        // retention are never re-indexed and never schedule another backfill.
        retentionCutoffMs: retentionCutoffMs(config.sessionRetentionDays),
      });
    }
  });

  // ── 2a. 轻量检索提示：用户用指代词/旧约定时，在最后一条用户消息尾部追一句 ──
  // 只提示、不检索：记忆正文仍不进提示词，模型自己决定是否调 memory_search。
  pi.on("context", (event) => {
    if (config.retrievalHintEnabled === false || config.memoryMode !== "policy-only") return;

    const messages = event.messages;
    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if ((messages[i] as { role?: string }).role === "user") {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex === -1) return;

    const original = messages[lastUserIndex];
    const text = messageTextOf(original);
    // 已有标记直接跳过：同一消息重复触发时靠标记保持幂等。
    if (!text || text.includes(RETRIEVAL_HINT_MARKER) || !RETRIEVAL_HINT_TRIGGER.test(text)) return;

    const content = (original as { content?: unknown }).content;
    const next = messages.slice();
    if (typeof content === "string") {
      next[lastUserIndex] = { ...original, content: content + RETRIEVAL_HINT_SUFFIX } as AgentMessage;
    } else if (Array.isArray(content)) {
      next[lastUserIndex] = {
        ...original,
        content: [...content, { type: "text", text: RETRIEVAL_HINT_SUFFIX.trim() }],
      } as AgentMessage;
    } else {
      return;
    }
    // 新数组 + 新消息对象，原消息保持不变；其它消息原样透传。
    return { messages: next };
  });

  // ── 2. Inject memory policy; memory bodies never enter the prompt ──
  pi.on("before_agent_start", async (event, ctx) => {
    // 7-day rotating snapshot safety net (snapshot.ts). Age-guarded so it only
    // fires roughly once a week even though this hook runs on every agent start.
    try {
      maybeRotateSnapshot(globalDir);
    } catch (err) {
      console.warn(`⚠️ Memory snapshot rotation failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const promptContext = await buildPromptContext(config, store);

    const parts: string[] = [];
    if (promptContext.text) parts.push(promptContext.text);

    // 注入即使用：对纠正块里真正写进提示的条目各记一次引用。
    // 同一会话同一句只计一次，防止每轮注入把 access_count 刷爆。
    const sessionId = ctx.sessionManager.getSessionId();
    let counted = countedInjectionsBySession.get(sessionId);
    if (!counted) {
      counted = new Set();
      countedInjectionsBySession.set(sessionId, counted);
    }
    for (const entryText of promptContext.injectedTexts) {
      const key = `${sessionId}|${entryText.slice(0, 80)}`;
      if (counted.has(key)) continue;
      counted.add(key);
      // 找不到即静默跳过。
      store.touchEntryByText(entryText);
    }

    // Compact bridge: pin durable, high-value memories and inject them so key
    // facts survive context resets (see anchors/compact-bridge.ts).
    const anchorsConfig = config.anchors;
    if (anchorsConfig?.enabled && dbManager) {
      try {
        const anchorBlock = buildAnchorContextBlock(dbManager, anchorsConfig);
        if (anchorBlock) parts.push(anchorBlock);
      } catch (err) {
        console.warn(`⚠️ Anchor block injection failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const combined = parts.filter(Boolean).join("\n\n");
    if (combined) {
      return {
        systemPrompt: event.systemPrompt + "\n\n" + combined,
      };
    }
  });

  // ── 3. Register action-specific memory write tools with SQLite sync ──
  registerMemoryTool(pi, store, dbManager, config);

  // ── 4. Skill tool moved to the standalone skills extension (src/main/pi/skills) ──

  // ── 5. Setup session flush (compression turn + shutdown snapshot) ──
  setupSessionFlush(pi, store, config, dbManager);

  // ── 5b. Compact bridge: pin high-value memories before compaction so they
  // survive the context window reset (runs alongside the flush listener). ──
  pi.on("session_before_compact", async (_event, _ctx) => {
    const anchorsConfig = config.anchors;
    if (anchorsConfig?.enabled && dbManager) {
      promoteAnchorsBeforeCompact(dbManager, anchorsConfig);
    }
  });

  // ── 6. Auto-consolidation removed ──
  // 记忆已无字符上限，且正文不进系统提示；整理改由写入时的近重复拦截与
  // 定时遗忘（forget-stale）承担，不再保留「超限后自动合并」这条死路径。

  // NOTE: pi-hermes-memory's ten `/memory-*` slash commands are intentionally
  // NOT registered. They are TUI affordances: every one of them reports back
  // through ctx.ui.notify and several need terminal modals, which a desktop
  // shell cannot provide. The desktop surface for memory is the agent tools
  // (memory_add / memory_search / session_search) — the user
  // just says "remember X". Their handlers are deleted from handlers/ rather
  // than left dangling; only the non-command logic they shared is kept
  // (migrateThenSyncMarkdownMemories, session backfill).

  // ── 10. Live session indexing ──
  pi.on("message_end", async (_event, ctx) => {
    scheduleLiveSessionIndex(dbManager, ctx.sessionManager, {
      onError: (err) => console.warn(`⚠️ Live session indexing failed: ${err instanceof Error ? err.message : String(err)}`),
    });
  });

  // ── 11. SQLite session search + extended memory ──
  registerSessionSearchTool(pi, dbManager, config.sessionSearch ?? { variant: "legacy" });
  registerMemorySearchTool(pi, dbManager, config, globalDir);

  // ── 12. Auto-index session on shutdown ──
  // Registered last, so this runs after the session-flush shutdown handler and
  // is the final DB activity. Closing here truncates the WAL via
  // PRAGMA wal_checkpoint(TRUNCATE); without it the WAL only grows to its
  // high-water mark and is never reclaimed across sessions.
  //
  // Ordering is safe: Pi's ExtensionRunner.emit() runs same-extension handlers
  // sequentially in registration order and awaits each one, so the flush above
  // fully completes before close() runs. WARNING: do not register another
  // DB-writing session_shutdown handler after this block — it would run after
  // close() and silently no-op.
  pi.on("session_shutdown", async (_event, ctx) => {
    // 注入去重表按会话存活：不清理会随会话数线性涨内存。
    try {
      countedInjectionsBySession.delete(ctx.sessionManager.getSessionId());
    } catch { /* best effort */ }
    try {
      measureLifecycleSync("shutdown.active-index", () => {
        const sessionFile = ctx.sessionManager.getSessionFile();
        if (sessionFile && fs.existsSync(sessionFile)) {
          const sessionData = parseSessionFile(sessionFile);
          if (sessionData) {
            dbManager.withCorruptionRecovery(() => {
              indexSession(dbManager, sessionData);
              // Keep session_files metadata in sync with the final on-disk state.
              // Pi appends the closing session entry on shutdown after the last
              // message_end, so without this upsert the stored size/mtime would be
              // stale and the next startup would re-parse this file unnecessarily.
              upsertSessionFileMetadata(dbManager, sessionFile, sessionData.id);
            });
          }
        }
      });
    } catch {
      // Silent fail — don't block shutdown
    } finally {
      try {
        await measureLifecycle("shutdown.index-waits", () => Promise.all([
          waitForSessionBackfill(SESSION_BACKFILL_SHUTDOWN_TIMEOUT_MS),
          waitForLiveSessionIndex(SESSION_LIVE_INDEX_SHUTDOWN_TIMEOUT_MS),
        ]));
      } catch {
        // Best effort only — shutdown should not be held up by indexing errors.
      }
      try {
        measureLifecycleSync("shutdown.database-close", () => dbManager.close());
      } catch { /* best effort — never block shutdown */ }
    }
  });
}
