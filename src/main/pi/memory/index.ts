/**
 * Pi Hermes Memory Extension
 *
 * Brings Hermes-style persistent memory and a learning loop to any Pi user.
 * After `pi install`, users get:
 *
 * 1. Persistent Memory — MEMORY.md + USER.md that survive across sessions
 * 2. Background Learning Loop — auto-saves notable facts every N turns
 * 3. Session-End Flush — saves memories before compaction/shutdown
 * 4. Auto-Consolidation — merges memory when full instead of erroring
 * 5. Correction Detection — immediate save on user corrections
 * 6. Procedural Skills — SKILL.md files for reusable procedures
 * 7. Tool-Call-Aware Nudge — review triggers on tool call count too
 * 8. Context Fencing — <memory-context> tags prevent injection through stored memory
 * 9. Memory Aging — entry timestamps guide consolidation
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
import { MemoryStore } from "./store/memory-store";
import { SkillStore } from "./store/skill-store";
import { DatabaseManager } from "./store/db";
import { indexSession, upsertSessionFileMetadata, pruneEphemeralReviewSessions, pruneOldSessions, retentionCutoffMs } from "./store/session-indexer";
import { runRecoveryMaintenance } from "./store/recovery-maintenance";
import { scheduleSessionBackfill, waitForSessionBackfill, SESSION_BACKFILL_SHUTDOWN_TIMEOUT_MS } from "./handlers/session-backfill";
import { scheduleLiveSessionIndex, waitForLiveSessionIndex, SESSION_LIVE_INDEX_SHUTDOWN_TIMEOUT_MS } from "./handlers/session-live-index";
import { parseSessionFile } from "./store/session-parser";
import { registerMemoryTool } from "./tools/memory-tool";
import { registerSkillTool } from "./tools/skill-tool";
import { registerSessionSearchTool } from "./tools/session-search-tool";
import { registerMemorySearchTool } from "./tools/memory-search-tool";
import { setupBackgroundReview } from "./handlers/background-review";
import { setupSessionFlush } from "./handlers/session-flush";
import { triggerConsolidation } from "./handlers/auto-consolidate";
import { setupCorrectionDetector } from "./handlers/correction-detector";
import { migrateThenSyncMarkdownMemories } from "./handlers/sync-markdown-memories";
import { GUARD_RULES_FILENAME } from "./constants";
import { promoteAnchorsBeforeCompact, buildAnchorContextBlock } from "./anchors";
import { loadConfig } from "./config";
import type { MemoryConfig } from "./types";
import { maybeRotateSnapshot } from "./snapshot";
import { shouldWarnAutoConsolidationFailure } from "./auto-consolidation-warning";
import { detectProject, detectProjectSkills } from "./project";
import { buildPromptContext } from "./prompt-context";
import { migrateLegacyProjectMemoryDirs } from "./project-memory-migration";
import { AGENT_ROOT, resolveGlobalMemoryDir } from "./paths";
import { isDatabaseMigrationPending } from "./extension-root-migration";
import { measureLifecycle, measureLifecycleSync } from "./lifecycle-timing";

export function resolveProjectSkillDiscovery(
  skillStore: SkillStore,
  projectsMemoryDir: string | undefined,
  cwd?: string,
): { skillPaths: string[] } {
  const detected = detectProjectSkills(projectsMemoryDir, cwd);
  skillStore.setProjectContext(detected.name, detected.skillsDir);

  // This extension writes its generated skills directly into Pi's own global
  // skills root (~/.pi/agent/skills/), so Pi discovers them on load without any
  // extra bridging. We still contribute the path here for explicit discovery.
  const skillPaths = [skillStore.getGlobalSkillsDir()];
  if (detected.skillsDir) skillPaths.push(detected.skillsDir);
  return { skillPaths };
}

export function registerProjectSkillDiscoveryHandler(
  pi: Pick<ExtensionAPI, "on">,
  skillStore: SkillStore,
  projectsMemoryDir: string | undefined,
): void {
  pi.on("resources_discover", async (event, _ctx) => {
    return resolveProjectSkillDiscovery(skillStore, projectsMemoryDir, (event as { cwd?: string }).cwd);
  });
}

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
  // Factory may run with no session (Pi public contract). Do not snapshot
  // project identity from process.cwd() here — bind from session_start ctx.cwd
  // and from tool execute ctx.cwd.
  let projectName = "";
  const skillStore = new SkillStore({
    globalSkillsDir: path.join(agentRoot, "skills"), // 全局技能固定落 agent 根 skills（原跟随 memoryDir 默认会落到 pi-hermes-memory/skills）
    piGlobalSkillsDir: path.join(agentRoot, "skills"),
    projectSkillsDir: null,
    projectName: null,
    legacySkillsDir: path.join(legacyGlobalDir, "skills"),
    migrationSentinelPath: path.join(agentRoot, ".skills-migrated-to-extension-storage"),
  });
  const dbManager = new DatabaseManager(globalDir);
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

  const refreshSkillProjectContext = (cwd?: string) => {
    const resource = resolveProjectSkillDiscovery(skillStore, config.projectsMemoryDir, cwd);
    return {
      name: skillStore.getProjectName(),
      skillsDir: skillStore.getProjectSkillsDir(),
      resource,
    };
  };

  // Keep project memory available for users upgrading from the old
  // ~/.pi/agent/<project>/ layout. This is non-destructive: legacy folders
  // remain in place while entries are copied/merged into projects-memory/.
  migrateLegacyProjectMemoryDirs(agentRoot, config.projectsMemoryDir);
  // Project-scoped store: ~/.pi/agent/<projectsMemoryDir>/<project_name>/
  // Bound from session/tool ctx.cwd, never from factory process.cwd().
  const createProjectStore = (projectInfo: ReturnType<typeof detectProject>): MemoryStore | null => {
    if (!projectInfo.memoryDir) return null;
    return new MemoryStore({
      ...config,
      memoryCharLimit: config.projectCharLimit,
      memoryDir: projectInfo.memoryDir,
    });
  };
  let projectMemoryDir: string | null = null;
  let projectStore: MemoryStore | null = null;
  const projectStoreRef = () => projectStore;
  const projectNameRef = () => projectName;
  let configureProjectStore: (candidate: MemoryStore | null) => void = () => {};
  let configureMemoryToolProjectStore: (candidate: MemoryStore | null) => void = () => {};
  const bindProjectFromCwd = async (cwd?: string): Promise<void> => {
    if (!cwd) return;
    const nextProject = detectProject(config.projectsMemoryDir, cwd);
    const nextProjectMemoryDir = nextProject.memoryDir ?? null;
    if (nextProjectMemoryDir !== projectMemoryDir) {
      projectMemoryDir = nextProjectMemoryDir;
      projectStore = createProjectStore(nextProject);
      configureProjectStore(projectStore);
      configureMemoryToolProjectStore(projectStore);
      if (projectStore) await projectStore.loadFromDisk();
    }
    projectName = nextProject.name ?? "";
  };

  // ── 1. Load memory from disk on session start ──
  pi.on("session_start", async (_event, ctx) => {
    if (!persistenceInitialized) {
      try {
        await measureLifecycle("session-start.persistence-sync", async () => {
          await migrateThenSyncMarkdownMemories(
            dbManager,
            shouldMigrateExtensionRoot ? legacyGlobalDir : null,
            globalDir,
            config.projectsMemoryDir,
            agentRoot,
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
      await bindProjectFromCwd(ctx.cwd);
      refreshSkillProjectContext(ctx.cwd);
      await skillStore.migrateLegacySkills();
      await skillStore.ensureDiscoveredRoots();
      await store.loadFromDisk();
      if (projectStore) await projectStore.loadFromDisk();
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

  registerProjectSkillDiscoveryHandler(pi, skillStore, config.projectsMemoryDir);

  // ── 2. Inject memory policy by default; legacy mode keeps full frozen memory blocks ──
  pi.on("before_agent_start", async (event, _ctx) => {
    // 7-day rotating snapshot safety net (snapshot.ts). Age-guarded so it only
    // fires roughly once a week even though this hook runs on every agent start.
    try {
      maybeRotateSnapshot(globalDir);
    } catch (err) {
      console.warn(`⚠️ Memory snapshot rotation failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const promptContext = await buildPromptContext(config, store, projectStoreRef(), projectNameRef());

    const parts: string[] = [];
    if (promptContext) parts.push(promptContext);

    // Compact bridge: pin durable, high-value memories and inject them so key
    // facts survive context resets (see anchors/compact-bridge.ts).
    const anchorsConfig = config.anchors;
    if (anchorsConfig?.enabled && dbManager) {
      try {
        const anchorBlock = buildAnchorContextBlock(dbManager, anchorsConfig, projectNameRef());
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
  configureMemoryToolProjectStore = registerMemoryTool(pi, store, projectStoreRef, dbManager, projectNameRef, bindProjectFromCwd, config);

  // ── 4. Register the skill tool ──
  registerSkillTool(pi, skillStore);

  // ── 5. Setup background learning loop (with tool-call-aware nudge) ──
  setupBackgroundReview(pi, store, projectStoreRef, config, {
    dbManager,
    projectName: projectNameRef,
  });

  // ── 6. Setup session-end flush ──
  setupSessionFlush(pi, store, projectStoreRef, config, dbManager, projectNameRef);

  // ── 6b. Compact bridge: pin high-value memories before compaction so they
  // survive the context window reset (runs alongside the flush listener). ──
  pi.on("session_before_compact", async (_event, _ctx) => {
    const anchorsConfig = config.anchors;
    if (anchorsConfig?.enabled && dbManager) {
      promoteAnchorsBeforeCompact(dbManager, anchorsConfig, projectNameRef());
    }
  });

  // ── 7. Setup auto-consolidation (inject consolidator into stores) ──
  // Keep the failure in the tool result regardless; session-console logging is
  // separately configurable for users who already monitor tool results (#135).
  const runAutoConsolidation = async (
    target: "memory" | "user" | "failure",
    targetStore: MemoryStore,
    toolTarget: "memory" | "user" | "failure" | "project",
    signal?: AbortSignal,
  ) => {
    const result = await triggerConsolidation(
      pi,
      targetStore,
      target,
      signal,
      config.consolidationTimeoutMs,
      toolTarget,
      config,
    );
    if (result.deferred) {
      console.info(`⏳ Auto-consolidation for '${toolTarget}' deferred: ${result.error ?? "another session holds the consolidation lock"}`);
    } else if (shouldWarnAutoConsolidationFailure(config.autoConsolidationWarnOnFailure, result.consolidated)) {
      console.warn(`⚠️ Auto-consolidation failed for '${toolTarget}': ${result.error ?? "no reason reported"}`);
    }
    return result;
  };

  store.setConsolidator((target, signal) => runAutoConsolidation(target, store, target, signal));
  configureProjectStore = (candidate) => {
    if (!candidate) return;
    candidate.setConsolidator((target, signal) =>
      runAutoConsolidation(target, candidate, target === "memory" ? "project" : target, signal),
    );
  };
  configureProjectStore(projectStore);

  // ── 8. Setup correction detection ──
  setupCorrectionDetector(pi, store, projectStoreRef, config, dbManager, projectNameRef);

  // NOTE: pi-hermes-memory's ten `/memory-*` slash commands are intentionally
  // NOT registered. They are TUI affordances: every one of them reports back
  // through ctx.ui.notify and several need terminal modals, which a desktop
  // shell cannot provide. The desktop surface for memory is the agent tools
  // (memory_add / memory_search / session_search / skill_manage) — the user
  // just says "remember X". Their handlers are deleted from handlers/ rather
  // than left dangling; only the non-command logic they shared is kept
  // (triggerConsolidation, migrateThenSyncMarkdownMemories, session backfill).

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
