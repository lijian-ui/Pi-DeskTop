import {
  CONFIG_DIR_NAME,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  loadSkills,
  ModelRuntime,
  SessionManager as PiSessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, mkdir, unlink, readdir } from "node:fs/promises";
import { existsSync, statSync, watch, mkdirSync, readdirSync, type FSWatcher } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import extract from "extract-zip";
import type { WebContents } from "electron";
import { BrowserWindow } from "electron";
import { exportSessionToHtmlFile } from "./session-export";
import { readSoul, writeSoul } from "./soul";
import { soulExtension } from "./soul-extension";

// ── Agent data directory (per-platform) ──────────────────────────────────
// Pi SDK defaults to ~/.pi/agent, a hidden folder macOS Finder hides. On macOS
// we redirect the data dir to ~/Documents/PiAgent so it is easy to find; other
// platforms keep the SDK default (~/.pi/agent).
// The SDK's getAgentDir() reads PI_CODING_AGENT_DIR (config.js:412), so setting
// it here (before any SDK call) makes every path — settings.json, auth.json,
// sessions/, skills/, soul.md — follow the new location.
if (process.platform === "darwin" && !process.env.PI_CODING_AGENT_DIR) {
  process.env.PI_CODING_AGENT_DIR = join(homedir(), "Documents", "PiAgent");
}

/** A skill as surfaced to the renderer (stable subset of SDK Skill). */
export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: "user" | "project" | "path";
  disableModelInvocation: boolean;
}

/** A built-in provider from the SDK catalog, surfaced to the Models UI. */
export interface ProviderCatalogItem {
  id: string;
  name: string;
  baseUrl?: string;
  modelCount: number;
  configured: boolean;
  authSource: string | null;
  models: { id: string; name?: string }[];
}

/** A user-defined provider persisted in ~/.pi/agent/custom-models.json. */
export interface CustomProviderItem {
  id: string;
  name: string;
  baseUrl?: string;
  api?: string;
  models: { id: string; name?: string; reasoning?: boolean }[];
}

/** The groups used by the Models picker modal. */
export interface ProviderCatalog {
  apiKeyProviders: ProviderCatalogItem[];
  customProviders: CustomProviderItem[];
}

function authJsonPath(): string {
  return join(getAgentDir(), "auth.json");
}

/**
 * Fallback cwd used when the user has NOT chosen a workspace folder. The SDK
 * still needs *some* directory to store chat sessions, so "pure chat" mode
 * (no workspace selected) keeps its sessions under our own agent dir. This is
 * NOT persisted as a "workspace" — it's only an internal default so the user
 * can chat immediately without being forced to pick a folder first.
 */
function chatOnlyCwd(): string {
  return join(getAgentDir(), "chat");
}

async function readAuthJson(): Promise<Record<string, any>> {
  try {
    const content = await readFile(authJsonPath(), "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function writeAuthJson(data: Record<string, any>): Promise<void> {
  await writeJsonFile(authJsonPath(), data);
}

function customModelsPath(): string {
  return join(getAgentDir(), "custom-models.json");
}

// ── Bash guard config file (~/.pi/agent/bash-guard.json) ──
interface BashGuardConfig {
  blacklist: string[];
  whitelist: string[];
}

// Default danger blacklist. Entries are matched as *precise, full-line* regex
// patterns against the trimmed command: evaluateBash wraps each in ^(?:…)$ so a
// pattern must describe the WHOLE command (no loose substring match). This is the
// hard safety floor — always enforced before the whitelist, even in YOLO mode.
// Each entry targets a specific high-risk command family; write them as regex so
// they catch the dangerous variants precisely (e.g. "rm\s+-rf\s+/\S*" blocks
// `rm -rf /`, `/home`, `/etc` — but NOT `rm -rf ./build`). Cross-platform coverage:
// Linux / macOS / Windows + a few universal hazards.
const DEFAULT_BASH_GUARD_BLACKLIST = [
  // ── Unix / Linux / macOS: destructive delete & wipe ──
  "rm\\s+-rf\\s+/\\S*",          // rm -rf / and anything under root
  "rm\\s+-rf\\s+~\\S*",          // rm -rf ~ and under home
  "rm\\s+-rf\\s+\\.\\S*",        // rm -rf . (current dir) and under it
  "rm\\s+-rf\\s+\\*",            // rm -rf *
  "sudo\\s+rm\\b.*",             // sudo rm <anything>
  "chmod\\s+777\\b.*",
  "chmod\\s+-R\\s+777\\b.*",
  "chmod\\s+0{3,}\\b.*",         // chmod 000 / 0000 (no perms)
  "chmod\\s+-R\\s+0{3,}\\b.*",
  "chown\\s+-R\\b.*",
  "dd\\s+if=/dev/(zero|random|urandom)\\b.*",
  "mkfs\\b.*",
  "fdisk\\b.*",
  ">\\s*/dev/sd[a-z]\\d*\\b.*",  // raw overwrite of a disk block device
  "mv\\s+/\\s+/dev.*",           // mv / /dev/...
  // ── Unix / Linux / macOS: power & process ──
  "shutdown\\b.*",
  "reboot\\b.*",
  "poweroff\\b.*",
  "halt\\b.*",
  // ── Universal: dynamic eval / code injection ──
  "eval\\b.*",
  "exec\\b.*",
  // ── Universal: download-and-execute (supply-chain risk) ──
  "curl\\s.*\\|\\s*(ba)?sh",
  "wget\\s.*\\|\\s*(ba)?sh",
  // ── Universal: resource exhaustion / fork bomb ──
  ":\\(\\)\\s*\\{\\s*:\\|\\|:\\s*&\\s*\\};\\s*:",
  // ── Universal: skip host-key verification (MITM risk) ──
  "ssh\\s+-o\\s+StrictHostKeyChecking=no\\b.*",
  // ── Universal: destructive VCS / scheduled ops ──
  "git\\s+reset\\s+--hard\\b.*",
  "git\\s+push\\s+--force\\b.*",
  "crontab\\s+-r\\b.*",
  // ── Windows: recursive delete & format ──
  // Drive-letter paths (rm -rf E:\...) were a blind spot: the Unix patterns
  // above only match `/`, `~`, `.` and `*` prefixes, and the Windows section
  // only covered cmd.exe verbs. `[A-Za-z]:\\[^&|;]*` catches `rm -rf E:\project`
  // (with optional quoting, incl. spaces inside quotes) while tolerating any
  // rm flag order (rm -r -f) and stopping at command separators.
  "rm\\s+(?:-[a-zA-Z]+\\s+)*\"?[A-Za-z]:\\\\[^&|;]*",
  "rmdir\\s+/s\\s+/q\\b.*",
  "rd\\s+/s\\s+/q\\b.*",
  "del\\s+/f\\s+/s\\s+/q\\b.*",
  "format\\b.*",                // format, format C:, format-volume
  "diskpart\\b.*",
  // ── Windows: ransomware-style shadow / log wipe ──
  "vssadmin\\s+delete\\s+shadows\\b.*",
  "cipher\\s+/w\\b.*",
  "wevtutil\\s+cl\\b.*",
  // ── Windows: boot / registry / privilege ──
  "bcdedit\\s+/delete\\b.*",
  "reg\\s+delete\\b.*",
  "takeown\\b.*",
  "icacls\\s+/grant\\b.*",
  "net\\s+user\\s+administrator\\s+/active:yes\\b.*",
  "net\\s+user\\b.*",
  // ── Windows: obfuscated / silent / dangerous PowerShell ──
  "powershell(?:\\.exe)?\\s+-enc\\b.*",
  "powershell(?:\\.exe)?\\s+-nop\\b.*",
  "powershell(?:\\.exe)?\\s+-executionpolicy\\s+bypass\\b.*",
  "powershell(?:\\.exe)?\\s+iex\\b.*",
  "powershell(?:\\.exe)?\\s+invoke-expression\\b.*",
  "powershell(?:\\.exe)?\\s+remove-item\\s+-recurse\\b.*",
  "powershell(?:\\.exe)?\\s+stop-computer\\b.*",
  "powershell(?:\\.exe)?\\s+restart-computer\\b.*",
  "powershell(?:\\.exe)?\\s+set-mppreference\\b.*",
  "powershell(?:\\.exe)?\\s+clear-disk\\b.*",
  "powershell(?:\\.exe)?\\s+format-volume\\b.*",
  "taskkill\\s+/f\\b.*",
  "schtasks\\s+/delete\\b.*",
  // ── macOS: disk erase & backup destroy ──
  "diskutil\\s+eraseDisk\\b.*",
  "diskutil\\s+partitionDisk\\b.*",
  "diskutil\\s+zeroDisk\\b.*",
  "hdiutil\\s+erase\\b.*",
  "tmutil\\s+disable\\b.*",
  "tmutil\\s+delete\\b.*",
  "sudo\\s+nvram\\b.*",
  "sudo\\s+spctl\\s+--master-disable\\b.*",
  "launchctl\\s+unload\\s+-w\\b.*",
  "srm\\b.*",
];

function bashGuardPath(): string {
  return join(getAgentDir(), "bash-guard.json");
}

async function readBashGuardConfig(): Promise<BashGuardConfig> {
  try {
    const content = await readFile(bashGuardPath(), "utf-8");
    const parsed = JSON.parse(content);
    const disk = Array.isArray(parsed.blacklist) ? parsed.blacklist : [];
    // ADD-ONLY merge with the defaults: a stale on-disk config (saved before
    // a new default danger pattern was added — e.g. the Windows drive-path
    // `rm -rf E:\...` pattern) would otherwise keep serving a blacklist that
    // misses the newest protection. The user's own entries are preserved, and
    // only default entries that are missing get re-added (security wins over
    // "I deleted that default" — removing a default danger rule is not a
    // supported hardening step).
    const blacklist = [...new Set([...disk, ...DEFAULT_BASH_GUARD_BLACKLIST])];
    return {
      blacklist,
      whitelist: Array.isArray(parsed.whitelist) ? parsed.whitelist : [],
    };
  } catch {
    return { blacklist: [...DEFAULT_BASH_GUARD_BLACKLIST], whitelist: [] };
  }
}

async function writeBashGuardConfig(cfg: BashGuardConfig): Promise<void> {
  await writeJsonFile(bashGuardPath(), cfg);
}

// ── Compaction config (subset of ~/.pi/agent/settings.json) ──
// Pi SDK reads compaction.* from settings.json; we expose keepRecentTokens so
// the desktop user can tune how much recent raw history survives a /compact.
// Small value ⇒ aggressive compaction (less raw history kept); large value ⇒
// only the oldest history is summarized.
interface CompactionConfig {
  keepRecentTokens: number;
  reserveTokens: number;
  enabled: boolean;
}

const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  keepRecentTokens: 20000,
  reserveTokens: 16384,
  enabled: true,
};

// After a compaction with no subsequent assistant reply, the SDK returns
// tokens:null (it only trusts real LLM-reported usage). For display we
// approximate the post-compaction context as keepRecentTokens plus a small
// overhead for the synthetic compaction-summary entry.
const COMPACTION_SUMMARY_OVERHEAD_TOKENS = 500;

// ─────────────────────────────────────────────────────────────────────────
// Context-usage persistence (sidecar file — NEVER inside SDK session files)
//
// AgentSession.getContextUsage() only returns a *real* token count after an
// assistant reply. After a manual compaction with no following reply the SDK
// returns tokens:null (it deliberately refuses to estimate), so the indicator
// would show "—" / an approximation — and that state would survive a restart.
// To keep the ring accurate across restarts and session switches we persist
// the latest known usage per session here and fall back to it when the SDK
// can't compute. Keyed by the SDK sessionId (stable across restarts; embedded
// in the session file name as <timestamp>_<sessionId>.jsonl).
// ─────────────────────────────────────────────────────────────────────────
const MAX_CONTEXT_USAGE_ENTRIES = 500;

/** Auto-deny a bash approval if the renderer doesn't respond within this time.
 *  Prevents the agent loop from hanging forever if the window is closed,
 *  crashes, or the user simply walks away from the modal. */
const BASH_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Cap on per-unit denied-command tracking entries. The denialCounts Map
 *  grows on every rejected bash command and is never fully drained (only
 *  allowed commands are deleted), so without a cap a long session with many
 *  distinct denied commands would leak memory. When the cap is hit we clear
 *  the oldest entries (FIFO — Map preserves insertion order). */
const MAX_DENIAL_COUNTS = 500;

interface ContextUsageEntry {
  tokens: number;
  contextWindow: number;
  updatedAt: number;
}

let contextUsageCache: Record<string, ContextUsageEntry> | null = null;
// Single-flight guard: concurrent first loads MUST share one promise. Without
// it, two racing loads each readFile() and the later one replaces the cache
// with a fresh (un-GC'd) object, so the orphan GC's cleanup gets overwritten
// on the next save (GC log printed but file "never" shrank).
let contextUsageLoadPromise: Promise<Record<string, ContextUsageEntry>> | null =
  null;

// SAFETY NOTE (B3): This cache is intentionally never expired at runtime
// because Pi Desktop is a single-process application — no other process
// writes to context-usage.json. If the app ever becomes multi-instance,
// add a file-watcher or periodic re-read to invalidate this cache.

function contextUsagePath(): string {
  return join(getAgentDir(), "context-usage.json");
}

function loadContextUsageMap(): Promise<Record<string, ContextUsageEntry>> {
  if (contextUsageCache) return Promise.resolve(contextUsageCache);
  if (!contextUsageLoadPromise) {
    contextUsageLoadPromise = (async () => {
      let map: Record<string, ContextUsageEntry>;
      try {
        const content = await readFile(contextUsagePath(), "utf-8");
        const parsed = JSON.parse(content);
        map =
          parsed && typeof parsed === "object"
            ? (parsed as Record<string, ContextUsageEntry>)
            : {};
      } catch {
        map = {};
      }
      contextUsageCache = map;
      // One-shot orphan GC per app run: drop entries whose session file no
      // longer exists. Catches sessions deleted before cleanup existed,
      // deleted manually on disk, or removed through any path that bypassed
      // deleteSession(). Await it so callers never observe (and persist) the
      // pre-GC map.
      await gcContextUsageOrphans(map);
      return map;
    })();
  }
  return contextUsageLoadPromise;
}

let contextUsageGcDone = false;

/**
 * Remove context-usage entries whose sessionId has no matching session file
 * under <agentDir>/sessions/<escaped-cwd>/<timestamp>_<sessionId>.jsonl.
 * Best-effort and non-blocking; if the sessions dir can't be scanned, the map
 * is left untouched (never mass-delete on a read error).
 */
async function gcContextUsageOrphans(
  map: Record<string, ContextUsageEntry>,
): Promise<void> {
  if (contextUsageGcDone) return;
  contextUsageGcDone = true;
  try {
    const sessionsRoot = join(getAgentDir(), "sessions");
    const liveIds = new Set<string>();
    let dirs: string[];
    try {
      dirs = await readdir(sessionsRoot);
    } catch {
      return; // sessions dir missing/unreadable — don't touch the map
    }
    for (const dir of dirs) {
      let files: string[];
      try {
        files = await readdir(join(sessionsRoot, dir));
      } catch {
        continue;
      }
      for (const f of files) {
        // <timestamp>_<sessionId>.jsonl (timestamp is hyphen-only, single "_")
        const m = f.match(/_(.+)\.jsonl$/);
        if (m?.[1]) liveIds.add(m[1]);
      }
    }
    const orphans = Object.keys(map).filter((k) => !liveIds.has(k));
    if (orphans.length === 0) return;
    for (const k of orphans) delete map[k];
    await persistContextUsageMap(map);
    console.log(
      `context-usage.json GC: removed ${orphans.length} orphan entr${orphans.length === 1 ? "y" : "ies"}`,
    );
  } catch (err) {
    console.error("context-usage.json orphan GC failed:", err);
  }
}

async function persistContextUsageMap(
  map: Record<string, ContextUsageEntry>,
): Promise<void> {
  // Evict the oldest entries (by updatedAt) once over the cap, to bound the
  // file's growth even if session deletion cleanup is missed.
  const keys = Object.keys(map);
  if (keys.length > MAX_CONTEXT_USAGE_ENTRIES) {
    const oldest = keys
      .sort((a, b) => (map[a].updatedAt ?? 0) - (map[b].updatedAt ?? 0))
      .slice(0, keys.length - MAX_CONTEXT_USAGE_ENTRIES);
    for (const k of oldest) delete map[k];
  }
  await writeJsonFile(contextUsagePath(), map).catch((err) => {
    console.error("Failed to persist context-usage.json:", err);
  });
}

/**
 * Tombstones for deleted sessions. Session deletion races with the usage
 * auto-persist path (getContextUsage() -> saveContextUsage()): the status-bar
 * polling can re-write the entry for the *currently open* session right after
 * deleteSession() removed it, resurrecting the record. Session ids are uuidv7
 * and never reused, so permanently refusing writes for deleted ids is safe.
 * In-memory only — cleared on restart, when the startup orphan GC takes over.
 */
const deletedContextUsageIds = new Set<string>();

async function saveContextUsage(
  sessionId: string,
  tokens: number,
  contextWindow: number,
): Promise<void> {
  if (!sessionId || contextWindow <= 0) return;
  if (deletedContextUsageIds.has(sessionId)) return;
  const map = await loadContextUsageMap();
  // Re-check after the await: deleteContextUsage may have tombstoned this id
  // while we were loading. Without this, the assignment below would resurrect
  // the entry in the shared map and the next persist would write it back.
  if (deletedContextUsageIds.has(sessionId)) return;
  map[sessionId] = { tokens, contextWindow, updatedAt: Date.now() };
  await persistContextUsageMap(map);
}

async function readContextUsage(
  sessionId: string,
): Promise<ContextUsageEntry | undefined> {
  if (!sessionId) return undefined;
  const map = await loadContextUsageMap();
  return map[sessionId];
}

async function deleteContextUsage(sessionId: string): Promise<void> {
  if (!sessionId) return;
  // Tombstone FIRST: even if a concurrent saveContextUsage is already past
  // its own check, the final state converges because any later save is
  // rejected, and the delete below removes whatever landed in the map.
  deletedContextUsageIds.add(sessionId);
  const map = await loadContextUsageMap();
  if (!(sessionId in map)) return;
  delete map[sessionId];
  await persistContextUsageMap(map);
}

function settingsJsonPath(): string {
  return join(getAgentDir(), "settings.json");
}

/** All built-in tools the Pi SDK registers (docs/sdk.md:492). The SDK by
 * default activates only read/bash/edit/write; we allow opting into the rest
 * via settings.json `activeTools`. */
const ALL_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Active tool names from settings.json. Defaults to the full built-in set
 * (grep/find/ls included) — users can narrow it down in the settings UI. */
async function readActiveTools(): Promise<string[]> {
  try {
    const settings = await readSettingsJson();
    const t = settings.activeTools;
    if (Array.isArray(t) && t.length > 0) {
      return t.filter((n): n is string => typeof n === "string" && ALL_BUILTIN_TOOLS.includes(n));
    }
  } catch {
    // fall through to default
  }
  return [...ALL_BUILTIN_TOOLS];
}

async function readSettingsJson(): Promise<Record<string, any>> {
  try {
    const content = await readFile(settingsJsonPath(), "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function readCompactionConfig(): Promise<CompactionConfig> {
  const settings = await readSettingsJson();
  const c = settings.compaction ?? {};
  return {
    keepRecentTokens:
      typeof c.keepRecentTokens === "number" && c.keepRecentTokens > 0
        ? c.keepRecentTokens
        : DEFAULT_COMPACTION_CONFIG.keepRecentTokens,
    reserveTokens:
      typeof c.reserveTokens === "number" && c.reserveTokens > 0
        ? c.reserveTokens
        : DEFAULT_COMPACTION_CONFIG.reserveTokens,
    enabled: typeof c.enabled === "boolean" ? c.enabled : DEFAULT_COMPACTION_CONFIG.enabled,
  };
}

async function writeCompactionConfig(cfg: CompactionConfig): Promise<void> {
  const settings = await readSettingsJson();
  settings.compaction = {
    ...(settings.compaction ?? {}),
    keepRecentTokens: cfg.keepRecentTokens,
    reserveTokens: cfg.reserveTokens,
    enabled: cfg.enabled,
  };
  await writeJsonFile(settingsJsonPath(), settings);
}

async function readCustomModelsJson(): Promise<Record<string, any>> {
  try {
    const content = await readFile(customModelsPath(), "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function writeJsonFile(path: string, data: any): Promise<void> {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(path, JSON.stringify(data, null, 2), "utf-8");
}

/** One independent SDK runtime per active workspace (cwd). */
interface RuntimeUnit {
  cwd: string;
  sessionManager: PiSessionManager;
  runtime: AgentSessionRuntime;
  services: any;
  /** Path of the session currently active in this unit (jsonl file path). */
  activePath: string | null;
  /** Path of the session currently RUNNING a turn in this cwd, or null when idle. */
  runningPath: string | null;
  /**
   * Monotonic run counter, bumped on every prompt() start. The prompt()'s
   * finally only clears runningPath if it still owns the latest run — without
   * this, an old turn's cleanup can wipe a NEWER turn's running flag (the
   * abort→re-prompt race), which would defeat the cwd-busy guard and make the
   * stop button disappear mid-run.
   */
  runSeq: number;
  unsubscribe: (() => void) | null;
  /**
   * Bash guard state — ISOLATED PER UNIT (cwd). Under the old global guard a
   * "allow this session" click in one workspace silently lifted the gate for
   * EVERY workspace and leaked the approved verb into the shared on-disk
   * whitelist. Keeping these per-unit lets different cwds hold independent
   * permission decisions during concurrent multi-cwd runs.
   */
  allowAllSession: boolean;
  pendingBashRequests: Map<
    number,
    { resolve: (d: "allow" | "deny") => void; command: string; timer: NodeJS.Timeout }
  >;
  /**
   * The model the user picked for this unit, persisted so it survives across
   * session switches / "new task" clicks and applies to brand-new sessions
   * before they've loaded. Null until the user selects one (SDK then falls
   * back to its own defaultModel from settings.json).
   */
  defaultModel: { provider: string; modelId: string } | null;
  denialCounts: Map<string, number>;
  /** Pending retry timer for installToolGuardOn (cleared on dispose so a
   *  destroyed unit is never re-touched by a stale callback). */
  toolGuardTimer: NodeJS.Timeout | null;
  /**
   * Last tokens value we persisted for context usage. Short-circuits duplicate
   * compaction_end writes — if the same session compacts to the same token
   * count, the file write is skipped.
   */
  lastPersistedTokens: number | undefined;
}

export class PiDeskSessionManager {
  private modelRuntime: ModelRuntime | null = null;
  private webContents: WebContents | null = null;
  /**
   * Current workspace (cwd). `null` means the user has NOT yet chosen a
   * workspace — on first launch we deliberately leave this null (no default
   * directory is auto-captured) and the renderer shows a picker. Only an
   * explicit `setCwd` (user choice) or a previously-saved `current` populates
   * it.
   */
  private cwd: string | null = null;
  /**
   * Cwd-level concurrency model: every active workspace gets its own SDK
   * runtime so tasks in DIFFERENT cwds run in parallel. A single cwd can host
   * only ONE running task at a time (the `runningPath` guard) — that is the
   * only serialization we need, because the only real conflict risk is two
   * sessions in the SAME cwd stepping on each other's files. Switching the
   * focused cwd does NOT dispose other units; they keep streaming in the
   * background and stay resumable.
   */
   private units: Map<string, RuntimeUnit> = new Map();
   /**
    * Cwd-bound SDK services cache. createAgentSessionServices() is EXPENSIVE:
    * it synchronously scans skill/extension dirs, compiles TS extensions via
    * jiti and reads AGENTS.md up the directory tree — several seconds of
    * main-thread blocking. Services are cwd-bound, so we build them once per
    * cwd and reuse for every session in that workspace. Invalidated on skill
    * import / context-file change / provider change, keyed by cwd.
    *
    * Stored as a Promise (single-flight): concurrent ensureUnit() calls for the
    * same NEW cwd share one in-flight createAgentSessionServices() instead of
    * racing and running the expensive build twice.
    */
   private servicesByCwd: Map<string, Promise<any>> = new Map();
  /**
   * Watchers for AGENTS.md/CLAUDE.md context files. The SDK reads these files
   * ONCE when services are created (resourceLoader.reload() snapshot), so a
   * user editing AGENTS.md would otherwise keep sending the stale snapshot to
   * the LLM forever (until app restart / workspace switch). We watch every
   * directory Pi scans — cwd up to the fs root, plus ~/.pi/agent — and on a
   * relevant change invalidate servicesCache + reload the live session (same
   * invalidation path as skill import).
   */
   private contextFileWatchers: Map<string, FSWatcher[]> = new Map();
  /**
   * Per-cwd debounce for context-file changes. A single shared timer was a
   * bug: two different workspaces touching AGENTS.md within 300ms would clear
   * each other's pending invalidation, so one workspace kept serving stale
   * services (old context kept being injected). Keyed by cwd, so invalidation
   * never gets dropped across workspaces.
   */
  private contextFileDebounce = new Map<string, NodeJS.Timeout>();
  /** Recently used workspace paths, most-recent first, deduped, capped at 10. */
  private recentCwds: string[] = [];

  /**
   * Bash guard (permission prototype, no Pi source changes).
   * - bashMode: GLOBAL preference ("yolo" = auto-allow everything; "ask" =
   *   confirm each non-whitelisted command). Driven by the Settings UI.
   * - guardConfig: GLOBAL safety policy (blacklist always enforced, plus the
   *   user-managed whitelist) loaded from ~/.pi/agent/bash-guard.json — shared
   *   across every workspace.
   * Per-unit state (allowAllSession / pendingBashRequests / denialCounts) lives
   * on RuntimeUnit, so concurrent multi-cwd runs keep independent permission
   * decisions and a "allow this session" in one cwd never leaks into another.
   */
  private bashMode: "yolo" | "ask" = "ask";
  private bashReqId: number = 0;
  /**
   * Global requestId → owning unit. The renderer's approval response only
   * carries a requestId; this index routes it to the exact cwd that spawned
   * the prompt, so a decision in one workspace never answers another's.
   */
  private pendingBashIndex = new Map<number, RuntimeUnit>();
  // In-flight bind operations keyed by source session path (single-flight).
  private bindingPaths = new Set<string>();
  /**
   * Sequential write lock for auth.json. Methods that do read→modify→write
   * (saveApiKey, deleteApiKey, saveCustomProvider, deleteCustomProvider)
   * chain through this Promise so concurrent calls never overwrite each
   * other's writes. Resolved immediately when empty so the first caller is
   * not delayed.
   */
  private authWriteLock: Promise<void> = Promise.resolve();
  // Runtime-loaded from ~/.pi/agent/bash-guard.json
  private guardConfig: BashGuardConfig = { blacklist: [], whitelist: [] };
  /**
   * Pre-compiled guard patterns, rebuilt whenever guardConfig changes.
   * evaluateBash runs on EVERY command the model proposes (including inside
   * tool loops), and compiling ~60 blacklist regexes per call was measurable
   * garbage-collection churn. Invalid user-edited patterns are dropped here
   * instead of being re-tried (and re-thrown) on every evaluation.
   */
  private bashBlacklistRx: RegExp[] = [];
  private bashWhitelistRx: RegExp[] = [];

  private compileBashPatterns(): void {
    this.bashBlacklistRx = [];
    for (const pat of this.guardConfig.blacklist) {
      try {
        this.bashBlacklistRx.push(new RegExp(`^(?:${pat})$`));
      } catch {
        // Malformed pattern — skip it, but warn so the user knows their
        // rule isn't active (previous version silently dropped these).
        console.warn(`Bash guard: skipping malformed blacklist pattern: "${pat}"`);
      }
    }
    this.bashWhitelistRx = [];
    for (const pat of this.guardConfig.whitelist) {
      try {
        this.bashWhitelistRx.push(new RegExp(pat));
      } catch {
        console.warn(`Bash guard: skipping malformed whitelist pattern: "${pat}"`);
      }
    }
  }

  /**
   * Serialise auth.json writes through a sequential Promise chain.
   * Callers that read→modify→write surrender ordering to this lock so
   * concurrent calls never overwrite each other's changes.
   */
  private withAuthLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const next = new Promise<void>((r) => { release = r; });
    const prev = this.authWriteLock;
    this.authWriteLock = next;
    return prev.then(fn).finally(() => release!());
  }

  async initialize(cwd?: string): Promise<void> {
    // No workspace is persisted to disk: the user picks one from the UI (or
    // chats without one). The recent list therefore starts empty each launch.
    this.recentCwds = [];
    this.cwd = cwd ?? null;
    // Load bash guard config (blacklist/whitelist) from disk
    this.guardConfig = await readBashGuardConfig();
    this.compileBashPatterns();
    // Always spin up the chat-only runtime so the user can chat even before
    // (or without ever) choosing a workspace folder.
    await this.ensureUnit(chatOnlyCwd());
    // If a real workspace is selected, ensure its unit too.
    if (this.cwd) {
      await this.ensureUnit(this.cwd);
    }
  }

  /**
   * Lazily create (or return the existing) SDK runtime for a given cwd. This
   * is the heart of cwd-level concurrency: each workspace gets its OWN runtime
   * + session-manager + services, so tasks in different cwds run in parallel.
   * The first call also spins up the shared modelRuntime (custom providers are
   * cwd-independent) and registers custom providers.
   */
  private async ensureUnit(cwd: string): Promise<RuntimeUnit> {
    if (!cwd) {
      throw new Error("ensureUnit requires a workspace cwd");
    }
    // The chat-only default dir may not exist yet on first run; create it so
    // the SDK can store sessions there. For real workspaces the dir already
    // exists (the user picked it), so this is a harmless no-op.
    mkdirSync(cwd, { recursive: true });
    const existing = this.units.get(cwd);
    if (existing) return existing;

    if (!this.modelRuntime) {
      this.modelRuntime = await ModelRuntime.create();
      // Register custom providers FIRST, so they are available when the
      // session is created and tries to load the default model from settings.
      await this.reloadCustomProviders();
    }

    const sessionManager = PiSessionManager.create(cwd);

    // Reuse cached cwd-bound services when available — this is what makes
    // "new task" instant instead of blocking the main process for seconds
    // (skill dir scans + jiti extension compilation are all synchronous).
    // Single-flight: store the Promise so concurrent ensureUnit() calls for
    // the same new cwd share one build instead of racing.
    let servicesPromise = this.servicesByCwd.get(cwd);
    if (!servicesPromise) {
      // Notify the renderer that an expensive service build is starting,
      // so it can show a loading indicator instead of appearing frozen.
      const wc = this.webContents && !this.webContents.isDestroyed()
        ? this.webContents
        : this.findLiveWebContents();
      wc?.send("pi:servicesBuilding", { cwd });
      // Soul / persona: injected via the `soulExtension` inline extension
      // (before_agent_start event) so the soul text lands at the ABSOLUTE
      // BOTTOM of the fully assembled system prompt — after Pi's base
      // prompt, <project_context> and the trailing cwd line. The previous
      // appendSystemPromptOverride approach could only place it before
      // project context (assembly order is hardcoded in buildSystemPrompt).
      //
      // Hot-reload: the extension re-reads soul.md on EVERY turn, so edits
      // apply on the next message even without session.reload(). The
      // soul.md watcher/invalidation remains as harmless belt-and-braces.
      servicesPromise = createAgentSessionServices({
        cwd,
        modelRuntime: this.modelRuntime!,
        resourceLoaderOptions: {
          extensionFactories: [soulExtension],
        },
      });
      this.servicesByCwd.set(cwd, servicesPromise);
    }
    const services = await servicesPromise;

    const runtime = await createAgentSessionRuntime(
      async ({ sessionManager: sm, sessionStartEvent }) => ({
        ...(await createAgentSessionFromServices({
          services,
          sessionManager: sm,
          sessionStartEvent,
        })),
        services,
        diagnostics: services.diagnostics,
      }),
      { cwd, agentDir: getAgentDir(), sessionManager }
    );

    const unit: RuntimeUnit = {
      cwd,
      sessionManager,
      runtime,
      services,
      activePath: runtime.session?.sessionManager?.getSessionFile() ?? null,
      runningPath: null,
      // MUST be initialized — prompt() does `++unit.runSeq`, and
      // `++undefined` is NaN, which would make the finally ownership check
      // (runSeq === seq) fail forever and strand runningPath → the stop
      // button and sidebar spinner would never clear after a reply.
      runSeq: 0,
      unsubscribe: null,
      allowAllSession: false,
      pendingBashRequests: new Map(),
      denialCounts: new Map(),
      defaultModel: null,
      toolGuardTimer: null,
      lastPersistedTokens: undefined,
    };
    this.units.set(cwd, unit);
    // Fresh SDK sessions activate only read/bash/edit/write by default; apply
    // the user's configured tool set (default: all built-ins) right away.
    this.applyUnitActiveTools(unit);
    this.subscribeToUnit(unit);
    this.installContextWatchersFor(cwd);
    return unit;
  }

  /**
   * Watch AGENTS.md / CLAUDE.md along the directory tree Pi actually scans
   * (cwd → fs root, plus the global ~/.pi/agent dir). The SDK snapshots these
   * files into memory when services are created; without this watcher a user
   * edit would silently keep injecting the stale content into every request.
   *
   * We watch the *directories* (non-recursive) rather than the files so that
   * creating a brand-new AGENTS.md is detected too. Events are filtered by
   * filename and debounced (editors fire multiple rename/change events per
   * save). On a hit: drop servicesCache (next new session re-reads) and
   * reload the live session so the current conversation picks it up as well.
   */
  /**
   * Watch AGENTS.md / CLAUDE.md / soul.md along the directory tree of ONE cwd
   * (the SDK scans cwd → fs root, plus the global ~/.pi/agent dir). Each unit
   * installs its own watchers; on a hit we invalidate that cwd's services
   * cache and reload its live session. Watchers from all units accumulate in
   * `contextFileWatchers` and are all closed on dispose.
   */
   private installContextWatchersFor(cwd: string): void {
     // Close any previous watchers for this cwd (e.g. re-ensureUnit after
     // services invalidation) so handles don't accumulate across rebuilds.
     this.closeContextWatchersFor(cwd);

     const isContextFile = (name: string | null): boolean => {
       if (!name) return false;
       const n = name.toLowerCase();
       return n === "agents.md" || n === "claude.md" || n === "soul.md";
     };

      const dirs = new Set<string>();
      dirs.add(getAgentDir()); // soul.md lives here
      const root = resolve(cwd);
      dirs.add(root); // AGENTS.md usually lives here
      // Context files may ALSO sit in any ancestor of cwd (the SDK walks up).
      // Only watch ancestors where such a file currently exists — a new
      // AGENTS.md dropped into an empty ancestor won't be caught, which we
      // accept: it keeps the watcher count bounded (previously EVERY directory
      // from cwd up to the filesystem root was watched, ~10 handles per
      // workspace, and up to that many again per extra workspace).
      // Cap the upward traversal at 16 levels to avoid excessive sync I/O
      // on deeply nested paths or pathological filesystem roots.
      const MAX_ANCESTOR_DEPTH = 16;
      let dir = dirname(root);
      let depth = 0;
      while (dir !== dirname(dir) && depth < MAX_ANCESTOR_DEPTH) {
        try {
          if (readdirSync(dir).some((n) => isContextFile(n))) dirs.add(dir);
        } catch {
          // Unreadable ancestor — skip it.
        }
        dir = dirname(dir);
        depth++;
      }

      const watchers: FSWatcher[] = [];
      for (const d of dirs) {
       if (!existsSync(d)) continue;
       try {
         const watcher = watch(d, (_event, filename) => {
           if (!isContextFile(filename)) return;
           this.onContextFileChanged(cwd);
         });
         // Never keep the process alive because of these watchers.
         watcher.unref?.();
         watcher.on("error", () => { /* dir removed etc. — ignore */ });
         watchers.push(watcher);
       } catch {
         // Directory not watchable (permissions, network drive) — skip.
       }
     }
     if (watchers.length) this.contextFileWatchers.set(cwd, watchers);
   }

   /** Close and remove all FS watchers for a specific cwd. */
   private closeContextWatchersFor(cwd: string): void {
     const watchers = this.contextFileWatchers.get(cwd);
     if (!watchers) return;
     for (const w of watchers) {
       try { w.close(); } catch { /* ignore */ }
     }
     this.contextFileWatchers.delete(cwd);
   }

  private onContextFileChanged(cwd: string): void {
    const existing = this.contextFileDebounce.get(cwd);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.contextFileDebounce.delete(cwd);
      // Next new session in this cwd rebuilds services → re-reads AGENTS.md/CLAUDE.md.
      this.servicesByCwd.delete(cwd);
      // Make the CURRENT session of this cwd pick up the change too (same
      // mechanism as skill import). Safe no-op if the session doesn't support reload.
      const unit = this.units.get(cwd);
      Promise.resolve(unit?.runtime.session?.reload?.()).catch((err) => {
        console.warn("Context file change: session reload skipped:", err);
      });
      console.log(`Context file (AGENTS.md / CLAUDE.md / soul.md) changed in ${cwd} — services cache invalidated`);
    }, 300);
    this.contextFileDebounce.set(cwd, timer);
  }

  private subscribeToUnit(unit: RuntimeUnit): void {
    unit.unsubscribe?.();
    const handler = (event: AgentSessionEvent) => {
      // Tag every event with the owning session path + cwd so the renderer can
      // route it to the right conversation (back-ground sessions keep
      // streaming; only the focused one drives the visible chat panel).
      // Dynamically resolve the live webContents instead of using the stale
      // captured reference — the window may have been destroyed and rebuilt
      // (macOS "activate" edge path), in which case the old reference's send
      // would be silently dropped.
      const wc = this.webContents && !this.webContents.isDestroyed()
        ? this.webContents
        : this.findLiveWebContents();
      wc?.send("pi:event", {
        sessionPath: unit.activePath,
        cwd: unit.cwd,
        // Pass the event by reference — Electron's IPC performs its own
        // structured clone, so the renderer receives an independent copy.
        // The previous JSON deep-copy was pure overhead on high-frequency
        // streaming events (and silently dropped `undefined` fields).
        event,
      });
      // Persist the precise post-compaction token count so the usage indicator
      // survives a restart even before the next assistant reply. The SDK
      // returns tokens:null in that state, so we must capture it here.
      const ev = event as any;
      if (ev.type === "compaction_end" && ev.result?.estimatedTokensAfter != null) {
        const sid = unit.runtime.session?.sessionId;
        const cw = unit.runtime.session?.getContextUsage()?.contextWindow ?? 0;
        // Skip if the token count hasn't changed since the last persist
        if (sid && cw > 0 && ev.result.estimatedTokensAfter !== unit.lastPersistedTokens) {
          unit.lastPersistedTokens = ev.result.estimatedTokensAfter;
          saveContextUsage(sid, ev.result.estimatedTokensAfter, cw).catch(() => {});
        }
      }
    };
    unit.unsubscribe = unit.runtime.session.subscribe(handler);
    // Install the bash permission guard via the SDK's official beforeToolCall
    // extension hook. Runs on init, newSession, switchSession, and setCwd
    // (all route through subscribeToUnit). Idempotent per unit.
    this.installToolGuardOn(unit);
  }

  /** Broadcast which sessions are currently running (per cwd) to the renderer. */
  private broadcastRunningState(): void {
    const running: string[] = [];
    const cwds: string[] = [];
    for (const u of this.units.values()) {
      if (u.runningPath) {
        running.push(u.runningPath);
        cwds.push(u.cwd);
      }
    }
    const wc = this.webContents && !this.webContents.isDestroyed()
      ? this.webContents
      : this.findLiveWebContents();
    wc?.send("pi:runningState", { running, cwds });
  }

  setEventTarget(wc: WebContents): void {
    this.webContents = wc;
  }

  /** Find the webContents of a live (non-destroyed) BrowserWindow.
   *  Used as a fallback when the captured webContents reference is stale
   *  (window destroyed and rebuilt on macOS "activate"). */
  private findLiveWebContents(): WebContents | undefined {
    const win = BrowserWindow.getAllWindows()[0];
    return win && !win.isDestroyed() ? win.webContents : undefined;
  }

  get session(): AgentSession | null {
    return this.units.get(this.cwd ?? "")?.runtime.session ?? null;
  }

  getRuntime(): AgentSessionRuntime | null {
    return this.units.get(this.cwd ?? "")?.runtime ?? null;
  }

  /** The runtime unit for a given cwd (defaults to the focused cwd). */
  getUnit(cwd?: string): RuntimeUnit | undefined {
    return this.units.get(cwd ?? this.cwd ?? "");
  }

  /** Find the unit whose active session matches the given path. */
  private findUnitByPath(path: string): RuntimeUnit | undefined {
    for (const u of this.units.values()) {
      if (u.activePath === path) return u;
    }
    return undefined;
  }

  getModelRuntime(): ModelRuntime | null {
    return this.modelRuntime;
  }

  getAllProvidersInfo() {
    if (!this.modelRuntime) return [];
    const providers = this.modelRuntime.getProviders();
    return providers.map((p) => {
      const status = this.modelRuntime!.getProviderAuthStatus(p.id);
      return {
        id: p.id,
        name: p.name ?? p.id,
        baseUrl: p.baseUrl,
        configured: status?.configured ?? false,
        authSource: status?.source ?? null,
      };
    });
  }

  /**
   * Catalog of every provider the SDK knows about, partitioned into the two
   * groups used by the Models UI (mirrors pi-web's ModelsConfig picker):
   *   - apiKeyProviders: built-in providers with an API-key login
   *   - customProviders: user-defined providers from ~/.pi/agent/models.json
   */
  async getProvidersCatalog(): Promise<ProviderCatalog> {
    const mr = this.modelRuntime;
    if (!mr) return { apiKeyProviders: [], customProviders: [] };
    const providers = mr.getProviders();
    // Extension/custom providers (added via registerProvider, e.g. the LM Studio
    // endpoint) also get a synthesized auth.apiKey.login function by the SDK
    // (see composeApiKeyAuth in provider-composer.js), so the apiKey-login
    // check alone is not enough to distinguish them from built-ins. Use the
    // SDK's own getRegisteredProviderIds() (which returns extensionProviders'
    // keys) to exclude them — the picker is an "add provider" entry point and
    // already-configured custom providers are managed in ModelsPage.
    const customIds = new Set(mr.getRegisteredProviderIds());
    const apiKeyProviders: ProviderCatalogItem[] = [];
    for (const p of providers) {
      if (customIds.has(p.id)) continue;
      const hasApiKeyLogin =
        !!p && typeof (p as any).auth?.apiKey?.login === "function";
      if (!hasApiKeyLogin) continue;
      const status = mr.getProviderAuthStatus(p.id);
      const models = mr.getModels(p.id).map((m: any) => ({
        id: String(m?.id ?? ""),
        name: m?.name,
      }));
      apiKeyProviders.push({
        id: p.id,
        name: p.name ?? p.id,
        baseUrl: p.baseUrl,
        modelCount: models.length,
        configured: status?.configured ?? false,
        authSource: status?.source ?? null,
        models,
      });
    }
    // Stable, alphabetical order (the SDK already returns a curated list).
    apiKeyProviders.sort((a, b) => a.name.localeCompare(b.name));
    const custom = await readCustomModelsJson();
    const customProviders: CustomProviderItem[] = Object.entries(custom).map(
      ([id, cfg]: [string, any]) => ({
        id,
        name: cfg?.name ?? id,
        baseUrl: cfg?.baseUrl,
        api: cfg?.api,
        models: Array.isArray(cfg?.models)
          ? cfg.models.map((m: any) => ({
              id: String(m?.id ?? ""),
              name: m?.name,
              reasoning: !!m?.reasoning,
            }))
          : [],
      })
    );
    return { apiKeyProviders, customProviders };
  }

  /** Read ~/.pi/agent/custom-models.json (the file the desktop shell uses to
   *  persist user-defined providers). Returns {} if missing. */
  async getCustomModelsJson(): Promise<Record<string, any>> {
    return readCustomModelsJson();
  }

  /** Write ~/.pi/agent/custom-models.json. Caller is responsible for
   *  re-registering providers with the ModelRuntime afterwards. */
  async saveCustomModelsJson(data: Record<string, any>): Promise<void> {
    await writeJsonFile(customModelsPath(), data ?? {});
  }

  /**
   * Send a user message. `cwd` selects which workspace's runtime handles it
   * (different cwds run in parallel). `sessionPath` selects the target
   * session *within* that cwd. Cwd-level concurrency rule: if this cwd already
   * has a task running in a DIFFERENT session, the new prompt is rejected
   * (pi:rejected) — a single cwd may only run one task at a time.
   */
  async prompt(text: string, images?: any[], cwd?: string, sessionPath?: string): Promise<void> {
    const targetCwd = this.resolveCwd(cwd);
    const unit = await this.ensureUnit(targetCwd);
    if (unit.runningPath && unit.runningPath !== sessionPath) {
      this.webContents?.send("pi:rejected", {
        reason: "cwd-busy",
        cwd: targetCwd,
        sessionPath,
      });
      return;
    }
    if (sessionPath && unit.activePath !== sessionPath) {
      unit.unsubscribe?.();
      await unit.runtime.switchSession(sessionPath);
      unit.activePath = sessionPath;
      this.subscribeToUnit(unit);
    }
    unit.runningPath = sessionPath ?? unit.activePath;
    const seq = ++unit.runSeq;
    this.broadcastRunningState();
    try {
      await unit.runtime.session?.prompt(text, { images });
    } finally {
      // Only clear the flag if we still own the latest run. A stale finally
      // from a turn that was aborted and then re-prompted must not wipe the
      // newer turn's runningPath (that would disable the busy guard and the
      // stop button mid-run).
      if (unit.runSeq === seq) {
        unit.runningPath = null;
        this.broadcastRunningState();
      }
    }
  }

  async steer(text: string, cwd?: string, sessionPath?: string): Promise<void> {
    const unit = cwd ? this.units.get(cwd) : this.units.get(this.cwd ?? "");
    if (!unit) return;
    if (unit.runningPath && unit.runningPath !== sessionPath) {
      this.webContents?.send("pi:rejected", { reason: "cwd-busy", cwd: unit.cwd, sessionPath });
      return;
    }
    await unit.runtime.session?.steer(text);
  }

  async followUp(text: string, cwd?: string, sessionPath?: string): Promise<void> {
    const unit = cwd ? this.units.get(cwd) : this.units.get(this.cwd ?? "");
    if (!unit) return;
    if (unit.runningPath && unit.runningPath !== sessionPath) {
      this.webContents?.send("pi:rejected", { reason: "cwd-busy", cwd: unit.cwd, sessionPath });
      return;
    }
    await unit.runtime.session?.followUp(text);
  }

  async abort(cwd?: string): Promise<void> {
    const unit = cwd ? this.units.get(cwd) : this.units.get(this.cwd ?? "");
    if (!unit) return;
    try {
      await unit.runtime.session?.abort();
    } catch {
      // Abort raced the turn finishing; the prompt() finally clears the flag.
    }
    // NOTE: deliberately do NOT clear runningPath here. The owning prompt()'s
    // finally (guarded by runSeq) clears it once its turn settles. Clearing it
    // eagerly reintroduces the race where a stale finally of an aborted turn
    // wipes a re-prompted turn's running flag.
  }

  // ── Bash guard (permission prototype) ──────────────────────────────────
  /** Change the bash permission mode. Leaving "ask" clears the session allow-all. */
  setBashGuardMode(mode: "yolo" | "ask"): void {
    this.bashMode = mode;
    if (mode !== "ask") {
      // Switching out of "ask" drops every unit's per-session allow grant
      // (the old code only cleared a single global flag).
      for (const u of this.units.values()) {
        u.allowAllSession = false;
      }
    }
  }

  /** Resolve a pending approval request from the renderer modal. */
  handleBashApprovalResponse({
    requestId,
    decision,
  }: {
    requestId: number;
    decision: "allow" | "deny" | "allow-session";
  }): void {
    // Route the decision to the exact unit that spawned the prompt.
    const unit = this.pendingBashIndex.get(requestId);
    if (!unit) return;
    const entry = unit.pendingBashRequests.get(requestId);
    this.pendingBashIndex.delete(requestId);
    if (!entry) return;
    unit.pendingBashRequests.delete(requestId);
    clearTimeout(entry.timer);
    if (decision === "allow-session") {
      // "Allow this session" now scopes to the SINGLE cwd that spawned the
      // prompt: it raises that unit's per-session allow flag instead of
      // polluting the shared on-disk whitelist (the old global behavior leaked
      // the approved verb into every other workspace). The danger blacklist is
      // still enforced first in evaluateBash, so even a "allow session" cwd
      // can never run a blacklisted command.
      unit.allowAllSession = true;
      entry.resolve("allow");
    } else {
      entry.resolve(decision === "deny" ? "deny" : "allow");
    }
  }

  /** Read the current bash guard config (for the Settings UI). */
  async getBashGuardConfig(): Promise<BashGuardConfig> {
    return readBashGuardConfig();
  }

  /** Save a new blacklist/whitelist config from the Settings UI. */
  async saveBashGuardConfig(cfg: BashGuardConfig): Promise<void> {
    this.guardConfig = cfg;
    this.compileBashPatterns();
    await writeBashGuardConfig(cfg);
  }

  async getCompactionConfig(): Promise<CompactionConfig> {
    return readCompactionConfig();
  }

  async saveCompactionConfig(cfg: CompactionConfig): Promise<void> {
    await writeCompactionConfig(cfg);
    // Refresh the SDK's in-memory settings so the new value takes effect on the
    // next compaction without an app restart. settingsManager.reload() only
    // re-reads the settings file (no runtime rebuild, no session drop).
    try {
      const session = this.session as any;
      await session?.settingsManager?.reload?.();
    } catch {
      // Non-fatal: file is saved; it will apply on next launch regardless.
    }
  }

  /**
   * Read the current soul text (for the Assistant Settings UI). Returns ""
   * when no soul has been configured.
   */
  async getSoul(): Promise<string> {
    return readSoul();
  }

  /**
   * Save a new soul text and make it take effect immediately:
   *   - drop the cached cwd-bound services so the next new session re-reads
   *     it (and the running session's next service build picks it up too),
   *   - reload the live session so the current conversation gets the new
   *     persona right away.
   * This is the exact same invalidation path used by the AGENTS.md watcher and
   * skill import — soul is global, so clearing the current servicesCache entry
   * (the only cached cwd) and reloading the live session covers it.
   */
  async saveSoul(text: string): Promise<void> {
    await writeSoul(text);
    this.servicesByCwd.clear();
    Promise.resolve(this.session?.reload?.()).catch((err) => {
      console.warn("Soul change: session reload skipped:", err);
    });
    console.log("Soul changed — services cache invalidated");
  }

  /**
   * Install a bash permission guard through the SDK's official `beforeToolCall`
   * extension hook — no Pi source is modified. We push a minimal in-memory
   * "extension" (with a `tool_call` handler) onto the AgentSession's live
   * ExtensionRunner. The SDK routes every tool call the LLM makes (including
   * bash) through `beforeToolCall`, which awaits our policy decision. Returning
   * `{ block: true, ... }` makes the SDK skip the real tool execution and
   * surface the synthetic refusal result to the model.
   */
  private installToolGuardOn(unit: RuntimeUnit, retries = 20): void {
    // Bail out if the unit was disposed while a retry was pending.
    if (!this.units.has(unit.cwd)) return;
    const session = unit.runtime.session as any;
    const runner = session?.extensionRunner;
    if (runner && Array.isArray(runner.extensions)) {
      if (!runner.extensions.some((e: any) => e?.path === "bash-guard-internal")) {
        runner.extensions.push({
          path: "bash-guard-internal",
          handlers: new Map<string, any>([["tool_call", [this.makeToolCallHandler(unit)]]]),
          tools: new Map(),
          flags: new Map(),
          shortcuts: new Map(),
          messageRenderers: new Map(),
        });
      }
      unit.toolGuardTimer = null;
      return;
    }
    // The ExtensionRunner may not be bound yet (it is created during session
    // init). Retry shortly until it is available, instead of silently missing.
    // Save the timer on the unit so dispose() can cancel it and the callback
    // can check the unit is still alive before touching its session.
    if (retries > 0) {
      unit.toolGuardTimer = setTimeout(() => {
        unit.toolGuardTimer = null;
        this.installToolGuardOn(unit, retries - 1);
      }, 50);
    }
  }

  private makeToolCallHandler(unit: RuntimeUnit) {
    return async (event: any) => {
      if (!event || event.toolName !== "bash") return undefined;
      const command = typeof event.input?.command === "string" ? event.input.command : "";
      const decision = await this.evaluateBash(command, unit);
      if (decision === "allow") {
        // A command that was ultimately allowed no longer counts toward the
        // retry escalation for its text.
        unit.denialCounts.delete(command.trim());
        return undefined;
      }
      // Denied — either by the user via the approval dialog, or by the danger
      // command blacklist. The SDK's beforeToolCall contract (agent-loop.js:419-424)
      // reads the `reason` field — NOT `content` — and wraps it in
      // createErrorToolResult(...) with `isError:true` hard-coded. So we MUST put
      // our refusal message in `reason`; if we used `content` (or omitted reason)
      // the SDK falls back to the meaningless "Tool execution was blocked" and the
      // model would just retry blindly. Even though it is an error result, an
      // explicit "do not retry" instruction makes most models stop looping.
      // Blacklist hits are rejected directly (no dialog) with a policy-specific
      // message so the model understands it is a hard security rule, not a
      // transient user refusal.
      const key = command.trim();
      const count = (unit.denialCounts.get(key) ?? 0) + 1;
      unit.denialCounts.set(key, count);
      // Bound the Map: if it grows past the cap, drop the oldest entries
      // (Map iterates in insertion order). Without this a long session with
      // many distinct denied commands would leak memory.
      if (unit.denialCounts.size > MAX_DENIAL_COUNTS) {
        const toRemove = unit.denialCounts.size - MAX_DENIAL_COUNTS;
        let removed = 0;
        for (const k of unit.denialCounts.keys()) {
          unit.denialCounts.delete(k);
          if (++removed >= toRemove) break;
        }
      }
      const repeatedNote =
        count >= 2
          ? "\n\n注意：你已多次尝试执行被系统禁止的 bash 命令。这是最终决定，必须立即停止，不得再以任何等价命令重试。"
          : "";
      const refusalBase =
        decision === "deny-blacklist"
          ? "⛔ 该 bash 命令匹配「危险命令黑名单」，已被系统安全策略明确禁止执行（bash 权限控制）。请勿以任何形式重试该命令或等价命令，也不要尝试用其它命令达成相同目的。请直接告诉用户：此命令因安全策略被禁止执行，并询问用户是否希望改用其他更安全的方式来完成目标。"
          : "⛔ 该 bash 命令已被用户明确拒绝执行（bash 权限控制）。请勿以任何形式重试该命令或等价命令，也不要尝试用其它命令达成相同目的。请直接告诉用户你无法执行此操作，并询问用户是否希望改用其他方式或需要其它帮助。";
      return {
        block: true,
        reason: refusalBase + repeatedNote,
      };
    };
  }

  /**
   * Split a command line into its constituent commands on shell separators
   * (`&&`, `||`, `;`, `|`, newlines). Used so the danger blacklist can't be
   * bypassed by chaining — `rm -rf / && echo hi` splits into `rm -rf /` and
   * `echo hi`, and the first segment hits the blacklist. Splitting too eagerly
   * is safe here: segments are only ever SHORTER than the original, so a
   * dangerous pattern can never be masked by splitting. (Quoted pipes are a
   * theoretical over-split, but that only produces harmless shorter segments.)
   */
  private static splitCommandChain(cmd: string): string[] {
    return cmd
      .split(/\s*(?:&&|\|\||;|\||\r?\n)\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private async evaluateBash(command: string, unit: RuntimeUnit): Promise<"allow" | "deny" | "deny-blacklist"> {
    const trimmed = command.trim();
    // The danger blacklist is a hard security floor — always enforced, even in
    // YOLO mode. Order matters: check it *before* the whitelist, so a whitelisted
    // verb like "rm" can never override a blacklisted dangerous variant like
    // "rm -rf /". Blacklist patterns are matched *precisely* (full-line, ^(?:…)$),
    // so each entry describes exactly the command family it blocks. Patterns are
    // pre-compiled by compileBashPatterns() whenever the config changes.
    //
    // Two passes:
    //  1. whole line  — catches patterns that CONTAIN separators themselves
    //     (e.g. `curl … | sh`, the fork-bomb pattern), which splitting would
    //     otherwise fragment and miss;
    //  2. per segment — catches chained bypasses (`rm -rf / && echo hi`).
    const segments = PiDeskSessionManager.splitCommandChain(trimmed);
    const hitsBlacklist = (s: string) => this.bashBlacklistRx.some((rx) => rx.test(s));
    if (hitsBlacklist(trimmed) || segments.some(hitsBlacklist)) return "deny-blacklist";
    if (unit.allowAllSession) return "allow";
    if (this.bashMode === "yolo") return "allow";
    // Whitelist patterns are matched *broadly* (substring regex) so a verb like
    // "rm" whitelists the whole command family.
    if (this.bashWhitelistRx.some((rx) => rx.test(trimmed))) return "allow";
    return this.requestApproval(command, unit);
  }

  private requestApproval(command: string, unit: RuntimeUnit): Promise<"allow" | "deny"> {
    const requestId = ++this.bashReqId;
    return new Promise((resolve) => {
      // Safety net: if the renderer never responds (window closed, crashed,
      // or the user simply ignores the modal), auto-deny after 5 minutes so
      // the agent loop doesn't hang forever and the Promise/resolve closure
      // isn't leaked. The timer is cleared on a real response.
      const timer = setTimeout(() => {
        if (unit.pendingBashRequests.has(requestId)) {
          unit.pendingBashRequests.delete(requestId);
          this.pendingBashIndex.delete(requestId);
          console.warn(`Bash approval ${requestId} timed out — auto-denying`);
          resolve("deny");
        }
      }, BASH_APPROVAL_TIMEOUT_MS);
      unit.pendingBashRequests.set(requestId, { resolve, command, timer });
      this.pendingBashIndex.set(requestId, unit);
      // Carry the owning cwd + session path so the renderer can show WHICH
      // workspace the prompt came from (critical during concurrent multi-cwd
      // runs) and route the user's decision to the right conversation.
      this.webContents?.send("pi:bashApprovalRequest", {
        requestId,
        command,
        cwd: unit.cwd,
        sessionPath: unit.activePath,
      });
    });
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    if (!this.modelRuntime) throw new Error("ModelRuntime not available");
    const model = this.modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`Model "${modelId}" not found for provider "${provider}"`);
    // Resolve the effective cwd (chat-only fallback) so a model can be chosen
    // even before any workspace is picked. Target the unit's live session.
    const targetCwd = this.resolveCwd();
    const unit = await this.ensureUnit(targetCwd);
    // Remember the choice for this unit so it survives session switches and
    // "new task" clicks (those create fresh sessions that would otherwise
    // revert to the SDK default).
    unit.defaultModel = { provider, modelId };
    if (unit.runtime?.session) {
      await unit.runtime.session.setModel(model);
    }
    // Persist as the global default model in settings.json — the SDK reads
    // defaultModel when it spins up a new session, so future sessions (any
    // cwd) start on the user's pick without us re-applying per unit.
    await this.persistDefaultModel(provider, modelId);
    // Let the renderer refresh the pill immediately.
    this.webContents?.send("pi:modelChanged", { cwd: targetCwd, model });
  }

  async cycleModel(): Promise<void> {
    const targetCwd = this.resolveCwd();
    const unit = this.units.get(targetCwd);
    await unit?.runtime?.session?.cycleModel();
  }

  /** Write defaultModel/defaultProvider to ~/.pi/agent/settings.json. */
  private async persistDefaultModel(provider: string, modelId: string): Promise<void> {
    try {
      const settings = await readSettingsJson();
      settings.defaultModel = modelId;
      settings.defaultProvider = provider;
      await writeJsonFile(settingsJsonPath(), settings);
    } catch {
      // Non-fatal: in-memory unit.defaultModel still drives the current session.
    }
  }

  /** Apply this unit's remembered model to its (live) session, if any. */
  private applyUnitDefaultModel(unit: RuntimeUnit): void {
    if (!unit.defaultModel || !unit.runtime?.session) return;
    const model = this.modelRuntime?.getModel(unit.defaultModel.provider, unit.defaultModel.modelId);
    if (model) {
      unit.runtime.session.setModel(model).catch(() => {});
    }
  }

  /** Apply the configured active tool set to this unit's live session.
   * newSession()/switchSession() reset the tool set to the SDK default, so we
   * re-apply the user's selection after each — same pattern as
   * applyUnitDefaultModel. */
  private applyUnitActiveTools(unit: RuntimeUnit): void {
    const session = unit.runtime?.session;
    if (!session) return;
    readActiveTools()
      .then((tools) => session.setActiveToolsByName(tools))
      .catch(() => {});
  }

  /** Current active tool names (from ~/.pi/agent/settings.json). */
  async getActiveTools(): Promise<string[]> {
    return readActiveTools();
  }

  /** Persist the active tool selection and apply it to every live unit. */
  async saveActiveTools(tools: string[]): Promise<void> {
    const valid = tools.filter((t) => ALL_BUILTIN_TOOLS.includes(t));
    try {
      const settings = await readSettingsJson();
      settings.activeTools = valid;
      await writeJsonFile(settingsJsonPath(), settings);
    } catch {
      // Non-fatal: in-memory application below still takes effect this run.
    }
    for (const unit of this.units.values()) {
      unit.runtime?.session?.setActiveToolsByName(valid);
    }
  }

  async getAvailableModels(): Promise<any[]> {
    if (!this.modelRuntime) return [];
    // SDK 返回 readonly 数组，转成可变数组供渲染层使用
    return (await this.modelRuntime.getAvailable()) as unknown as any[];
  }

  /**
   * Start a fresh session in `cwd` (or the chat-only fallback).
   *
   * @returns the new session's file path. The renderer MUST use this return
   * value rather than a follow-up `getCurrentSessionPath()` lookup: there is no
   * global focus cwd any more, so "which unit is current" is only knowable by
   * the caller that just picked the cwd.
   */
  async newSession(cwd?: string): Promise<string | null> {
    const targetCwd = this.resolveCwd(cwd);
    const unit = await this.ensureUnit(targetCwd);
    unit.unsubscribe?.();
    await unit.runtime.newSession();
    unit.activePath = unit.runtime.session?.sessionManager?.getSessionFile() ?? null;
    // Re-apply the user's chosen model — newSession() resets it to the SDK
    // default, which would make a "new task" silently drop the selection.
    this.applyUnitDefaultModel(unit);
    this.applyUnitActiveTools(unit);
    this.subscribeToUnit(unit);
    return unit.activePath;
  }

  async switchSession(cwd: string, sessionPath: string): Promise<void> {
    const unit = await this.ensureUnit(cwd);
    if (unit.activePath === sessionPath) return;
    unit.unsubscribe?.();
    await unit.runtime.switchSession(sessionPath);
    unit.activePath = sessionPath;
    // A switched-to session may carry a different model; re-apply the unit's
    // chosen default so the pill stays consistent with the user's selection.
    this.applyUnitDefaultModel(unit);
    this.applyUnitActiveTools(unit);
    this.subscribeToUnit(unit);
  }

  /**
   * List persisted sessions across every known workspace (focused cwd first,
   * then recents) so the sidebar can show the multi-cwd task tree. Uses a
   * lightweight PiSessionManager per cwd — no runtime/services are built.
   */
  async listSessions(): Promise<any[]> {
    // Enumerate sessions across ALL workspaces (including the chat-only
    // fallback dir) via the SDK's static `listAll`. We deliberately do NOT
    // scope to `this.cwd` / `recentCwds` here: workspaces are bound
    // per-session (a session's cwd lives in its own file header), so there is
    // no single "current workspace" that should gate which sessions appear.
    // The renderer groups them afterwards by cwd (chat dir → "任务", anything
    // else → "空间").
    try {
      return await PiSessionManager.listAll();
    } catch (err) {
      console.error("Failed to list sessions:", err);
      return [];
    }
  }

  /**
   * Path of the session file currently loaded in the runtime, or undefined.
   */
  /**
   * Active session path of the unit that owns `cwd`.
   *
   * Must take an explicit cwd: `this.cwd` is permanently null under the
   * per-session workspace model, so `units.get(this.cwd)` would never match
   * and this method would always return undefined (which silently broke
   * "new task" — the renderer bailed out on the empty result).
   */
  getCurrentSessionPath(cwd?: string): string | undefined {
    const unit = this.units.get(this.resolveCwd(cwd));
    return unit?.runtime.session?.sessionManager?.getSessionFile() ?? undefined;
  }

  /**
   * Export a historical session to a standalone HTML file at outputPath.
   * Returns the written file path.
   */
  async exportSessionHtml(sessionPath: string, outputPath: string): Promise<string> {
    return exportSessionToHtmlFile(sessionPath, outputPath);
  }

  /**
   * Persistently rename a session. Appends a `session_info` entry carrying the
   * new display name to the session's .jsonl file. An empty name clears the
   * custom name (the list then falls back to the first message). Written
   * metadata only — never touches system prompt or message history.
   */
  async renameSession(sessionPath: string, name: string): Promise<void> {
    const sm = PiSessionManager.open(String(sessionPath));
    sm.appendSessionInfo(String(name));
  }

  /**
   * Permanently delete a session file.
   */
  async deleteSession(sessionPath: string): Promise<void> {
    // Refuse to delete a session that is currently RUNNING: unlinking the
    // file mid-stream would corrupt the conversation (Windows would also
    // likely throw EPERM on the open handle). The renderer surfaces the
    // rejection via the failed IPC call. Note: we deliberately do NOT match
    // on `activePath` — deleting the currently-focused-but-idle session is a
    // supported flow (the renderer deletes it and immediately creates a new
    // one), so only the actually-streaming case is blocked.
    for (const u of this.units.values()) {
      if (u.runningPath === sessionPath) {
        throw new Error("Session is currently running and cannot be deleted");
      }
    }
    try {
      await unlink(sessionPath);
    } catch (err) {
      console.error("Failed to delete session:", err);
    }
    // Clear activePath on any unit that was pointing at the deleted session.
    // The renderer immediately creates a new session after deleting the focused
    // one, but if activePath is left stale, a subsequent switchSession or
    // prompt targeting the old path would fail. Resetting to null makes the
    // next newSession() call re-establish a valid path cleanly.
    for (const u of this.units.values()) {
      if (u.activePath === sessionPath) {
        u.activePath = null;
      }
    }
    // Best-effort cleanup of the usage sidecar. Never block or fail the
    // actual session deletion. Session file name: <timestamp>_<sessionId>.jsonl
    // (fileTimestamp is hyphen-only, so the single "_" separates it from the
    // uuidv7 sessionId).
    const m = basename(sessionPath).match(/_(.+)\.jsonl$/);
    const sid = m?.[1] ?? "";
    if (sid) await deleteContextUsage(sid).catch(() => {});
  }

  /**
   * List skills discovered the same way the running session loads them:
   * the user directory (~/.pi/skills) and the project directory
   * (<cwd>/.pi/skills). Uses the SDK's own loader so name/description
   * validation matches exactly.
   */
  async listSkills(): Promise<SkillInfo[]> {
    try {
      const agentDir = getAgentDir();
      const home = homedir();
      // Scan every directory the user might have placed skills in. The SDK's
      // own runtime resolves the user dir to `<agentDir>/skills`, but skills are
      // also commonly dropped directly into `~/.pi/skills`, so cover both.
      const userSkillDirs = [
        join(agentDir, "skills"),
        join(home, CONFIG_DIR_NAME, "skills"),
      ];
      // When no workspace is selected yet, there are no project skills to
      // discover — fall back to a non-existent path so loadSkills simply
      // yields none rather than erroring on a null cwd.
      const projectSkillDir = this.cwd
        ? join(this.cwd, CONFIG_DIR_NAME, "skills")
        : join(homedir(), CONFIG_DIR_NAME, "__none__");
      const skillPaths = [...userSkillDirs, projectSkillDir];

      const result = loadSkills({
        cwd: this.cwd ?? chatOnlyCwd(),
        agentDir,
        skillPaths,
        includeDefaults: false,
      });

      const resolvedUserDirs = userSkillDirs.map((d) => resolve(d));
      const resolvedProjectDir = resolve(projectSkillDir);
      const isUnder = (target: string, root: string) =>
        target === root || target.startsWith(root + sep);

      return result.skills.map((s) => {
        const skillDir = dirname(resolve(s.filePath));
        let source: SkillInfo["source"] = "path";
        if (resolvedUserDirs.some((d) => isUnder(skillDir, d))) source = "user";
        else if (isUnder(skillDir, resolvedProjectDir)) source = "project";
        return {
          name: s.name,
          description: s.description ?? "",
          filePath: s.filePath,
          baseDir: s.baseDir,
          source,
          disableModelInvocation: s.disableModelInvocation,
        };
      });
    } catch (err) {
      console.error("Failed to list skills:", err);
      return [];
    }
  }

  /**
   * Extract a skill .zip into the user skills directory (~/.pi/skills) and
   * best-effort reload the running session so the new skill is immediately
   * invokable via /skill:name.
   */
  async importSkillZip(zipPath: string): Promise<{ name?: string; error?: string }> {
    try {
      const skillsDir = join(getAgentDir(), "skills");
      await mkdir(skillsDir, { recursive: true });
      await extract(zipPath, { dir: skillsDir });
      // The cached services hold a resourceLoader that scanned skills BEFORE
      // this import — drop the cache so the next new session re-scans and
      // picks up the new skill(s).
      this.servicesByCwd.clear();
      // Make the running session pick up the newly added skill(s).
      try {
        await this.session?.reload?.();
      } catch (reloadErr) {
        console.warn("Skill import: session reload skipped:", reloadErr);
      }
      return { name: basename(zipPath) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Manually compact the session. Returns a structured result so the UI can
   * tell expected no-ops (session too small / already compacted) apart from
   * real failures (e.g. summarization API errors).
   *
   * Note: the SDK emits `compaction_start` *before* it checks whether anything
   * is worth compacting, so for these no-op cases `compaction_end` never fires
   * and the renderer must reset its `isCompacting` flag itself.
   */
  async compact(
    customInstructions?: string
  ): Promise<
    | { ok: true }
    | {
        ok: false;
        reason: "too_small" | "already_compacted" | "unknown";
        message?: string;
      }
  > {
    try {
      await this.session?.compact(customInstructions);
      return { ok: true };
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      if (/nothing to compact/i.test(message)) {
        return { ok: false, reason: "too_small", message };
      }
      if (/already compacted/i.test(message)) {
        return { ok: false, reason: "already_compacted", message };
      }
      // Real failure (e.g. summarization failed) — let it surface as an error.
      throw err;
    }
  }

  /**
   * Return current context usage (tokens / contextWindow / percent).
   * Delegates to SDK AgentSession.getContextUsage().
   * Returns undefined if no model is set or contextWindow is unknown.
   */
  async getContextUsage(): Promise<
    | {
        tokens: number | null;
        contextWindow: number;
        percent: number | null;
      }
    | undefined
  > {
    const sdk = this.session?.getContextUsage();
    if (!sdk) return undefined;
    const sid = this.session?.sessionId;

    // Real computed value — persist it (idempotent; overwrites any prior
    // approximation/estimate for this session) and return as-is.
    if (sdk.tokens != null) {
      if (sid) await saveContextUsage(sid, sdk.tokens, sdk.contextWindow).catch(() => {});
      return sdk;
    }

    // tokens:null → SDK can't estimate (compaction entry, no assistant reply
    // yet). Prefer the precise value persisted at compaction_end so a restart
    // still shows the correct post-compaction usage; fall back to an
    // approximation only if nothing was persisted.
    const persisted = sid ? await readContextUsage(sid).catch(() => undefined) : undefined;
    if (persisted && persisted.contextWindow > 0) {
      const tokens = Math.min(persisted.tokens, sdk.contextWindow);
      return {
        tokens,
        contextWindow: sdk.contextWindow,
        percent: Math.min(100, (tokens / sdk.contextWindow) * 100),
      };
    }

    // Last-resort approximation: a real compaction only happens when
    // tokensBefore > keepRecentTokens, and the retained window is cut at
    // keepRecentTokens, so the post-compaction context ≈ keepRecentTokens
    // (+ a small summary overhead). Clamped to contextWindow.
    const cfg = await readCompactionConfig().catch(() => DEFAULT_COMPACTION_CONFIG);
    const kr =
      cfg && cfg.keepRecentTokens > 0
        ? cfg.keepRecentTokens
        : DEFAULT_COMPACTION_CONFIG.keepRecentTokens;
    const approx = Math.min(kr + COMPACTION_SUMMARY_OVERHEAD_TOKENS, sdk.contextWindow);
    const percent = Math.min(100, (approx / sdk.contextWindow) * 100);
    return { tokens: approx, contextWindow: sdk.contextWindow, percent };
  }

  async saveApiKey(providerId: string, apiKey: string): Promise<void> {
    await this.withAuthLock(async () => {
      const data = await readAuthJson();
      data[providerId] = { type: "api_key", key: apiKey };
      await writeAuthJson(data);
    });
    await this.modelRuntime?.setRuntimeApiKey(providerId, apiKey);
  }

  async deleteApiKey(providerId: string): Promise<void> {
    await this.withAuthLock(async () => {
      const data = await readAuthJson();
      delete data[providerId];
      await writeAuthJson(data);
    });
    await this.modelRuntime?.removeRuntimeApiKey(providerId);
  }

  /**
   * Save a custom provider: persists config to custom-models.json + registers
   * in ModelRuntime + sets runtime API key + persists key to auth.json.
   */
  async saveCustomProvider(providerId: string, config: any): Promise<void> {
    const mr = this.modelRuntime;
    if (!mr) throw new Error("ModelRuntime not available");

    // Persist config + API key under the write lock to prevent races
    await this.withAuthLock(async () => {
      const all = await readCustomModelsJson();
      all[providerId] = config;
      await writeJsonFile(customModelsPath(), all);

      if (config.apiKey) {
        const auth = await readAuthJson();
        auth[providerId] = { type: "api_key", key: config.apiKey };
        await writeAuthJson(auth);
      }
    });

    // Register in runtime (outside the lock — no fs access)
    mr.registerProvider(providerId, config);
    if (config.apiKey) {
      mr.setRuntimeApiKey(providerId, config.apiKey);
    }
  }

  /**
   * Delete a custom provider: removes from custom-models.json + unregisters
   * from ModelRuntime + removes runtime + persisted API key.
   */
  async deleteCustomProvider(providerId: string): Promise<void> {
    const mr = this.modelRuntime;
    if (!mr) throw new Error("ModelRuntime not available");

    await this.withAuthLock(async () => {
      const all = await readCustomModelsJson();
      delete all[providerId];
      await writeJsonFile(customModelsPath(), all);

      const auth = await readAuthJson();
      delete auth[providerId];
      await writeAuthJson(auth);
    });

    mr.unregisterProvider(providerId);
    mr.removeRuntimeApiKey(providerId);
  }

  /**
   * Delete a single model from a custom provider. Removes it from
   * custom-models.json and re-registers the provider so the runtime model set
   * is rebuilt without it. If the provider's model list becomes empty, the
   * whole provider is removed (file + runtime + persisted key).
   */
  async deleteCustomModel(providerId: string, modelId: string): Promise<void> {
    const mr = this.modelRuntime;
    if (!mr) throw new Error("ModelRuntime not available");

    await this.withAuthLock(async () => {
      const all = await readCustomModelsJson();
      const cfg = all[providerId];
      if (!cfg) return;

      const models = Array.isArray(cfg.models)
        ? cfg.models.filter((m: any) => String(m?.id ?? "") !== modelId)
        : [];

      if (models.length === 0) {
        // Last model removed → the provider itself disappears.
        // Delete provider config + auth key under the same lock.
        delete all[providerId];
        await writeJsonFile(customModelsPath(), all);
        const auth = await readAuthJson();
        delete auth[providerId];
        await writeAuthJson(auth);
        // Unregister from runtime (outside the lock below — after fs writes)
        mr.unregisterProvider(providerId);
        mr.removeRuntimeApiKey(providerId);
        return;
      }

      const updated = { ...cfg, models };
      all[providerId] = updated;
      await writeJsonFile(customModelsPath(), all);

      // Re-compose the runtime model set without the deleted model.
      mr.registerProvider(providerId, updated);
    });
  }

  /**
   * Re-register all persisted custom providers on startup.
   */
  private async reloadCustomProviders(): Promise<void> {
    const mr = this.modelRuntime;
    if (!mr) return;
    const all = await readCustomModelsJson();
    let changed = false;
    for (const [providerId, config] of Object.entries(all)) {
      // Fixup: "openai" shorthand → "openai-completions" for backward compat
      if ((config as any).api === "openai") {
        (config as any).api = "openai-completions";
        changed = true;
        for (const model of (config as any).models ?? []) {
          if (model.api === "openai") model.api = "openai-completions";
        }
      }
      // Fill in missing model fields that the SDK's applyExtension() drops
      for (const model of (config as any).models ?? []) {
        if (model.reasoning === undefined) { model.reasoning = false; changed = true; }
        if (model.input === undefined) { model.input = ["text"]; changed = true; }
        if (model.cost === undefined) { model.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; changed = true; }
        if (model.contextWindow === undefined) { model.contextWindow = 128000; changed = true; }
        if (model.maxTokens === undefined) { model.maxTokens = 16384; changed = true; }
      }
      mr.registerProvider(providerId, config);
      if ((config as any).apiKey) {
        mr.setRuntimeApiKey(providerId, (config as any).apiKey);
      }
    }
    // Persist migrated config back to disk
    if (changed) {
      await writeJsonFile(customModelsPath(), all);
    }
  }

  getState(cwd?: string) {
    // Empty/undefined cwd → effective cwd (chat-only fallback). Without this,
    // a model chosen before any workspace is picked could never be reflected
    // back to the UI (getState("") used to look up units.get("") → undefined).
    const key = cwd && cwd.trim().length > 0 ? cwd : this.cwd ?? chatOnlyCwd();
    const unit = this.units.get(key);
    const session = unit?.runtime.session;
    // Return by reference: Electron IPC structured-clones the payload, so the
    // renderer gets an independent copy. The previous JSON deep-copy doubled
    // the cost on every call (and silently dropped `undefined` fields).
    return {
      model: session?.model ?? unit?.defaultModel ?? null,
      thinkingLevel: session?.thinkingLevel ?? null,
      isStreaming: session?.isStreaming ?? false,
      sessionId: session?.sessionId ?? null,
      messages: session?.messages ?? [],
    };
  }

  /**
   * Resolve the effective cwd for an operation that needs one. When no
   * workspace is explicitly chosen we fall back to chatOnlyCwd() so the user
   * can still chat "without a workspace" — we never silently revert to
   * process.cwd() (which previously spawned stray session dirs).
   */
  private resolveCwd(cwd?: string): string {
    // `??` only catches null/undefined, not an empty string. The renderer
    // sends cwd: "" when no workspace is selected, so normalize that to
    // "no value" before falling back to chatOnlyCwd(). Otherwise ensureUnit
    // would receive "" and throw "requires a workspace cwd".
    const chosen = cwd && cwd.trim().length > 0 ? cwd.trim() : this.cwd;
    return chosen ?? chatOnlyCwd();
  }

  /** Current workspace (the cwd used for new sessions and project-scoped resources).
   * Returns "" when the user has not yet picked a workspace. */
  getCwd(): string {
    return this.cwd ?? "";
  }

  /** Recently used workspace paths, most-recent first. */
  getRecentCwds(): string[] {
    return [...this.recentCwds];
  }

  /**
   * Switch the working directory. Updates the in-memory focus (no disk
   * persistence — the workspace choice is intentionally not saved across
   * launches), then ensures a runtime exists for the new cwd. Other cwds'
   * units are NOT disposed — they keep running/streaming in the background and
   * stay resumable. The renderer's session list, skill list, and chat panel
   * must be reloaded after this returns.
   */
  async setCwd(newCwd: string): Promise<void> {
    if (!newCwd || typeof newCwd !== "string") {
      throw new Error("Invalid workspace path");
    }
    if (this.cwd === newCwd) return;
    // Validate up front so a stale "recent" entry (directory the user
    // deleted between visits) doesn't tear down the live runtime.
    if (!existsSync(newCwd)) {
      throw new Error(`Workspace path does not exist: ${newCwd}`);
    }
    // Must be a directory, not a file.
    let isDir: boolean;
    try {
      isDir = statSync(newCwd).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      throw new Error(`Workspace path is not a directory: ${newCwd}`);
    }

    // Track the new focus in memory only (workspace choice is not persisted).
    this.cwd = newCwd;
    this.recentCwds = [newCwd, ...this.recentCwds.filter((c) => c !== newCwd)].slice(0, 10);

    // Focus switch only: ensure a runtime exists for the new focused cwd and
    // keep it as the active unit. Other cwds' units are NOT disposed — they
    // keep running/streaming in the background and stay resumable when the
    // user focuses them again.
    await this.ensureUnit(newCwd);

    // Notify the renderer (belt-and-suspenders on top of the post-call
    // refresh the workspace-store performs).
    this.webContents?.send("workspace:changed", {
      cwd: this.cwd,
      recents: this.getRecentCwds(),
    });
  }

  /** Path of the chat-only fallback directory (used by the renderer to tell
   * "task" sessions apart from workspace-bound ones). */
  getChatOnlyCwd(): string {
    return chatOnlyCwd();
  }

  /**
   * Bind a brand-new, still-empty session to a real workspace directory.
   *
   * This is the ONLY entry point that re-homes a session across cwds, and it is
   * intentionally restricted to EMPTY sessions: re-homing a session that already
   * has message history would strand its streaming runtime and break the
   * cwd-level concurrency model, so that case is rejected.
   *
   * Implementation note — why we do NOT move the file:
   *  - `SessionManager.newSession()` only *computes* the session path; the file
   *    is written lazily on the first flush. A brand-new empty session therefore
   *    usually has NO file on disk, so `rename`/`forkFrom` would throw ENOENT.
   *  - Even when a header-only file does exist, `listAll()` derives a session's
   *    cwd from the file *header*, not from its directory — so a bare `rename`
   *    would leave the session showing up under "任务" forever.
   * Since the session is empty by definition there is nothing to preserve, so we
   * simply spin up a fresh session inside the target workspace unit (its header
   * gets `cwd = workspaceCwd`) and drop the stale placeholder.
   *
   * Crucially this does NOT touch the global `this.cwd` — workspace binding is
   * per-session (the session file's header is the single source of truth), so
   * subsequent new tasks still default to the chat-only fallback.
   *
   * @returns the on-disk path of the newly bound session.
   */
  async bindSessionToWorkspace(
    sessionPath: string,
    workspaceCwd: string,
  ): Promise<{ newPath: string; cwd: string }> {
    if (!workspaceCwd || typeof workspaceCwd !== "string") {
      throw new Error("Invalid workspace path");
    }
    if (!existsSync(workspaceCwd)) {
      throw new Error(`Workspace path does not exist: ${workspaceCwd}`);
    }
    let isDir: boolean;
    try {
      isDir = statSync(workspaceCwd).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      throw new Error(`Workspace path is not a directory: ${workspaceCwd}`);
    }

    const src = String(sessionPath ?? "");
    // Guard: only EMPTY sessions may be rebound. A brand-new session normally
    // has no file yet (lazy flush), which already means "empty"; when a
    // header-only file does exist we count its real entries without disturbing
    // the live runtime.
    let entryCount = 0;
    if (src && existsSync(src)) {
      try {
        entryCount = PiSessionManager.open(src).getEntries().length;
      } catch {
        entryCount = 0;
      }
    }
    if (entryCount > 0) {
      throw new Error("Cannot rebind a session that already has messages");
    }

    // Single-flight: avoid a double bind racing on the same source session.
    const lockKey = src || `@pending:${workspaceCwd}`;
    if (this.bindingPaths.has(lockKey)) {
      throw new Error("A bind for this session is already in progress");
    }
    this.bindingPaths.add(lockKey);
    try {
      const srcUnit = src ? this.findUnitByPath(src) : undefined;

      // Spin up a fresh session inside the target workspace unit. Its header is
      // written with `cwd = workspaceCwd`, which is what `listAll()` reads, so
      // the sidebar files it under "空间" / <workspace name>.
      const wsUnit = await this.ensureUnit(workspaceCwd);
      wsUnit.unsubscribe?.();
      await wsUnit.runtime.newSession();
      const newPath =
        wsUnit.runtime.session?.sessionManager?.getSessionFile() ?? "";
      wsUnit.activePath = newPath || null;
      this.applyUnitDefaultModel(wsUnit);
      this.applyUnitActiveTools(wsUnit);
      this.subscribeToUnit(wsUnit);

      // The chat unit must never be left pointing at the abandoned placeholder.
      if (srcUnit && srcUnit !== wsUnit) {
        try {
          srcUnit.unsubscribe?.();
          await srcUnit.runtime.newSession();
          srcUnit.activePath =
            srcUnit.runtime.session?.sessionManager?.getSessionFile() ?? null;
          this.applyUnitDefaultModel(srcUnit);
          this.applyUnitActiveTools(srcUnit);
          this.subscribeToUnit(srcUnit);
        } catch {
          /* non-fatal: the chat unit recovers on the next newSession */
        }
      }

      // Drop the stale header-only file, if one was ever flushed, so the empty
      // placeholder does not linger under "任务".
      if (src && existsSync(src)) {
        try {
          await unlink(src);
        } catch {
          /* non-fatal */
        }
      }

      return { newPath, cwd: workspaceCwd };
    } finally {
      this.bindingPaths.delete(lockKey);
    }
  }

  dispose(): void {
    // Reject every pending bash approval so the agent loop doesn't hang on a
    // resolve() that will never come (renderer gone / app quitting). Clear the
    // timeout timers first so they can't fire after the resolve.
    for (const u of this.units.values()) {
      for (const { resolve, timer } of u.pendingBashRequests.values()) {
        clearTimeout(timer);
        resolve("deny");
      }
      u.pendingBashRequests.clear();
    }
    for (const u of this.units.values()) {
      u.unsubscribe?.();
      if (u.toolGuardTimer) {
        clearTimeout(u.toolGuardTimer);
        u.toolGuardTimer = null;
      }
      try { u.runtime.session?.dispose?.(); } catch { /* ignore */ }
    }
    this.units.clear();
    this.pendingBashIndex.clear();
    for (const watchers of this.contextFileWatchers.values()) {
      for (const w of watchers) {
        try { w.close(); } catch { /* ignore */ }
      }
    }
    this.contextFileWatchers.clear();
    for (const t of this.contextFileDebounce.values()) clearTimeout(t);
    this.contextFileDebounce.clear();
  }
}
