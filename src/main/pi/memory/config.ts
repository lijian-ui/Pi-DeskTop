import * as fs from "node:fs";
import * as path from "node:path";
import type { MemoryConfig, MemoryOverflowStrategy, ReviewTransport, SessionSearchVariant, ThinkingLevel } from "./types";
import type { RankingConfig, SignalWeights } from "./ranking/types";
import type { AnchorConfig } from "./anchors/types";
import type { GuardConfig, GuardSeverity } from "./guard/types";
import {
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_USER_CHAR_LIMIT,
  DEFAULT_PROJECT_CHAR_LIMIT,
  DEFAULT_PROJECTS_MEMORY_DIR,
  DEFAULT_NUDGE_INTERVAL,
  DEFAULT_FLUSH_MIN_TURNS,
  DEFAULT_NUDGE_TOOL_CALLS,
  DEFAULT_REVIEW_RECENT_MESSAGES,
  DEFAULT_FLUSH_RECENT_MESSAGES,
  DEFAULT_CONSOLIDATION_TIMEOUT_MS,
  DEFAULT_OVERFLOW_GRACE_MS,
  DEFAULT_FAILURE_INJECTION_MAX_AGE_DAYS,
  DEFAULT_FAILURE_INJECTION_MAX_ENTRIES,
  DEFAULT_SESSION_RETENTION_DAYS,
  GUARD_RULES_FILENAME,
} from "./constants";
import { AGENT_ROOT, normalizeConfiguredMemoryDir, normalizeProjectsMemoryDir } from "./paths";

// ─── Ranking / anchors / guard defaults ───
const DEFAULT_RANKING_CONFIG: RankingConfig = {
  enabled: true,
  halfLifeDays: 180,
  reinforcementFactor: 0.5,
  rrfK: 60,
  weights: { fts: 1.0, term: 0.6, decay: 0.5, recency: 0.4, affinity: 0.3 },
  // Seed reinforcement so a fresh write is not stuck at zero forever; and give
  // new entries a grace window before age can bury them. See RankingConfig.
  initialAccessCount: 1,
  decayGraceDays: 14,
};
const DEFAULT_ANCHORS_CONFIG: AnchorConfig = { enabled: true, minAccessCount: 3, maxAnchors: 5 };
const DEFAULT_GUARD_CONFIG: GuardConfig = { enabled: true, severity: "block", rulesPath: undefined };

const MEMORY_OVERFLOW_STRATEGIES: readonly MemoryOverflowStrategy[] = ["auto-consolidate", "reject", "fifo-evict"];
const SESSION_SEARCH_VARIANTS: readonly SessionSearchVariant[] = ["legacy", "anchors"];
const REVIEW_TRANSPORTS: readonly ReviewTransport[] = ["direct", "subprocess"];
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function isReviewTransport(value: unknown): value is ReviewTransport {
  return typeof value === "string" && REVIEW_TRANSPORTS.includes(value as ReviewTransport);
}

function isMemoryOverflowStrategy(value: unknown): value is MemoryOverflowStrategy {
  return typeof value === "string" && MEMORY_OVERFLOW_STRATEGIES.includes(value as MemoryOverflowStrategy);
}

function isSessionSearchVariant(value: unknown): value is SessionSearchVariant {
  return typeof value === "string" && SESSION_SEARCH_VARIANTS.includes(value as SessionSearchVariant);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

const DEFAULT_CONFIG: MemoryConfig = {
  memoryMode: "policy-only",
  memoryPolicyStyle: "full",
  memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
  userCharLimit: DEFAULT_USER_CHAR_LIMIT,
  projectCharLimit: DEFAULT_PROJECT_CHAR_LIMIT,
  nudgeInterval: DEFAULT_NUDGE_INTERVAL,
  reviewRecentMessages: DEFAULT_REVIEW_RECENT_MESSAGES,
  reviewEnabled: true,
  reviewTransport: "direct",
  flushOnCompact: true,
  flushOnShutdown: true,
  flushMinTurns: DEFAULT_FLUSH_MIN_TURNS,
  flushRecentMessages: DEFAULT_FLUSH_RECENT_MESSAGES,
  memoryOverflowStrategy: "auto-consolidate",
  overflowGraceMs: DEFAULT_OVERFLOW_GRACE_MS,
  autoConsolidate: true,
  correctionDetection: true,
  failureInjectionEnabled: true,
  failureInjectionMaxAgeDays: DEFAULT_FAILURE_INJECTION_MAX_AGE_DAYS,
  failureInjectionMaxEntries: DEFAULT_FAILURE_INJECTION_MAX_ENTRIES,
  consolidationTimeoutMs: DEFAULT_CONSOLIDATION_TIMEOUT_MS,
  autoConsolidationWarnOnFailure: true,
  nudgeToolCalls: DEFAULT_NUDGE_TOOL_CALLS,
  projectsMemoryDir: DEFAULT_PROJECTS_MEMORY_DIR,
  sessionSearch: { variant: "legacy" },
  quickCheckOnOpen: true,
  sessionRetentionDays: DEFAULT_SESSION_RETENTION_DAYS,
  ranking: DEFAULT_RANKING_CONFIG,
  anchors: DEFAULT_ANCHORS_CONFIG,
  guard: DEFAULT_GUARD_CONFIG,
};

export const DEFAULT_CONFIG_PATH = path.join(
  AGENT_ROOT,
  "hermes-memory-config.json",
);

/**
 * Partial update shape accepted by saveConfig(). Only the "core memory knobs"
 * are writable from the desktop UI — everything else in MemoryConfig is left
 * untouched so the panel cannot corrupt unrelated settings.
 */
export interface MemoryConfigPatch {
  flushOnShutdown?: boolean;
  flushOnCompact?: boolean;
  flushMinTurns?: number;
  flushRecentMessages?: number;
  reviewEnabled?: boolean;
  reviewRecentMessages?: number;
  nudgeInterval?: number;
  nudgeToolCalls?: number;
  correctionDetection?: boolean;
  /** Inject recent failure lessons into the prompt in both memory modes. */
  failureInjection?: {
    enabled?: boolean;
    maxAgeDays?: number;
    maxEntries?: number;
  };
  ranking?: {
    enabled?: boolean;
    halfLifeDays?: number;
    reinforcementFactor?: number;
    /** Reinforcement seeded into a brand-new row (breaks the 0-access deadlock). */
    initialAccessCount?: number;
    /** Days after creation during which decay is treated as full weight. */
    decayGraceDays?: number;
  };
  anchors?: {
    enabled?: boolean;
    minAccessCount?: number;
    maxAnchors?: number;
  };
  guard?: {
    enabled?: boolean;
    severity?: GuardSeverity;
  };
}

/**
 * Persist a partial config patch to hermes-memory-config.json, merging on top
 * of whatever is already on disk (so fields the UI doesn't expose survive).
 * Returns the normalized full config after the write.
 *
 * Validation mirrors loadConfig(): invalid values are dropped rather than
 * written, keeping the on-disk file always loadable.
 */
export function saveConfig(
  patch: MemoryConfigPatch,
  configPath = DEFAULT_CONFIG_PATH,
): MemoryConfig {
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (parsed && typeof parsed === "object") raw = parsed as Record<string, unknown>;
    } catch {
      // Corrupt file — start from an empty object and rebuild.
    }
  }

  const isBool = (v: unknown): v is boolean => typeof v === "boolean";
  const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

  if (isBool(patch.flushOnShutdown)) raw.flushOnShutdown = patch.flushOnShutdown;
  if (isBool(patch.flushOnCompact)) raw.flushOnCompact = patch.flushOnCompact;
  if (isNum(patch.flushMinTurns)) raw.flushMinTurns = Math.trunc(patch.flushMinTurns);
  if (isNum(patch.flushRecentMessages)) raw.flushRecentMessages = Math.trunc(patch.flushRecentMessages);
  if (isBool(patch.reviewEnabled)) raw.reviewEnabled = patch.reviewEnabled;
  if (isNum(patch.reviewRecentMessages)) raw.reviewRecentMessages = Math.trunc(patch.reviewRecentMessages);
  if (isNum(patch.nudgeInterval)) raw.nudgeInterval = Math.trunc(patch.nudgeInterval);
  if (isNum(patch.nudgeToolCalls)) raw.nudgeToolCalls = Math.trunc(patch.nudgeToolCalls);
  if (isBool(patch.correctionDetection)) raw.correctionDetection = patch.correctionDetection;

  if (patch.failureInjection && typeof patch.failureInjection === "object") {
    if (isBool(patch.failureInjection.enabled)) raw.failureInjectionEnabled = patch.failureInjection.enabled;
    if (isNum(patch.failureInjection.maxAgeDays)) raw.failureInjectionMaxAgeDays = Math.trunc(patch.failureInjection.maxAgeDays);
    if (isNum(patch.failureInjection.maxEntries)) raw.failureInjectionMaxEntries = Math.trunc(patch.failureInjection.maxEntries);
  }

  if (patch.ranking && typeof patch.ranking === "object") {
    const prev = (raw.ranking && typeof raw.ranking === "object") ? raw.ranking as Record<string, unknown> : {};
    const next = { ...prev };
    if (isBool(patch.ranking.enabled)) next.enabled = patch.ranking.enabled;
    if (typeof patch.ranking.halfLifeDays === "number" && patch.ranking.halfLifeDays > 0) {
      next.halfLifeDays = patch.ranking.halfLifeDays;
    }
    if (typeof patch.ranking.reinforcementFactor === "number" && patch.ranking.reinforcementFactor >= 0) {
      next.reinforcementFactor = patch.ranking.reinforcementFactor;
    }
    if (typeof patch.ranking.initialAccessCount === "number" && patch.ranking.initialAccessCount >= 0) {
      next.initialAccessCount = Math.trunc(patch.ranking.initialAccessCount);
    }
    if (typeof patch.ranking.decayGraceDays === "number" && patch.ranking.decayGraceDays >= 0) {
      next.decayGraceDays = Math.trunc(patch.ranking.decayGraceDays);
    }
    raw.ranking = next;
  }

  if (patch.anchors && typeof patch.anchors === "object") {
    const prev = (raw.anchors && typeof raw.anchors === "object") ? raw.anchors as Record<string, unknown> : {};
    const next = { ...prev };
    if (isBool(patch.anchors.enabled)) next.enabled = patch.anchors.enabled;
    if (isNum(patch.anchors.minAccessCount)) next.minAccessCount = Math.trunc(patch.anchors.minAccessCount);
    if (typeof patch.anchors.maxAnchors === "number" && patch.anchors.maxAnchors > 0) {
      next.maxAnchors = Math.trunc(patch.anchors.maxAnchors);
    }
    raw.anchors = next;
  }

  if (patch.guard && typeof patch.guard === "object") {
    const prev = (raw.guard && typeof raw.guard === "object") ? raw.guard as Record<string, unknown> : {};
    const next = { ...prev };
    if (isBool(patch.guard.enabled)) next.enabled = patch.guard.enabled;
    if (patch.guard.severity === "block" || patch.guard.severity === "warn") {
      next.severity = patch.guard.severity;
    }
    raw.guard = next;
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), "utf-8");
  return loadConfig(configPath);
}

export function loadConfig(configPath = DEFAULT_CONFIG_PATH): MemoryConfig {
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      // Merge: override defaults with user config
      const config: MemoryConfig = { ...DEFAULT_CONFIG };
      const isNonNegativeNumber = (value: unknown): value is number => (
        typeof value === "number" && Number.isFinite(value) && value >= 0
      );
      const isStringArray = (value: unknown): value is string[] => (
        Array.isArray(value) && value.every((item) => typeof item === "string")
      );
      let hasLegacyAutoConsolidate = false;
      let hasMemoryOverflowStrategy = false;
      if (parsed.memoryMode === "policy-only" || parsed.memoryMode === "legacy-inject") config.memoryMode = parsed.memoryMode;
      if (
        parsed.memoryPolicyStyle === "full" ||
        parsed.memoryPolicyStyle === "compact" ||
        parsed.memoryPolicyStyle === "custom" ||
        parsed.memoryPolicyStyle === "none"
      ) config.memoryPolicyStyle = parsed.memoryPolicyStyle;
      if (typeof parsed.memoryPolicyCustomText === "string") config.memoryPolicyCustomText = parsed.memoryPolicyCustomText;
      if (typeof parsed.memoryCharLimit === "number") config.memoryCharLimit = parsed.memoryCharLimit;
      if (typeof parsed.userCharLimit === "number") config.userCharLimit = parsed.userCharLimit;
      if (typeof parsed.nudgeInterval === "number") config.nudgeInterval = parsed.nudgeInterval;
      if (isNonNegativeNumber(parsed.reviewRecentMessages)) config.reviewRecentMessages = parsed.reviewRecentMessages;
      if (typeof parsed.reviewEnabled === "boolean") config.reviewEnabled = parsed.reviewEnabled;
      if (isReviewTransport(parsed.reviewTransport)) config.reviewTransport = parsed.reviewTransport;
      if (typeof parsed.flushOnCompact === "boolean") config.flushOnCompact = parsed.flushOnCompact;
      if (typeof parsed.flushOnShutdown === "boolean") config.flushOnShutdown = parsed.flushOnShutdown;
      if (typeof parsed.flushMinTurns === "number") config.flushMinTurns = parsed.flushMinTurns;
      if (isNonNegativeNumber(parsed.flushRecentMessages)) config.flushRecentMessages = parsed.flushRecentMessages;
      if (typeof parsed.autoConsolidate === "boolean") {
        config.autoConsolidate = parsed.autoConsolidate;
        hasLegacyAutoConsolidate = true;
      }
      if (isMemoryOverflowStrategy(parsed.memoryOverflowStrategy)) {
        config.memoryOverflowStrategy = parsed.memoryOverflowStrategy;
        hasMemoryOverflowStrategy = true;
      }
      if (isNonNegativeNumber(parsed.overflowGraceMs)) config.overflowGraceMs = parsed.overflowGraceMs;
      if (typeof parsed.correctionDetection === "boolean") config.correctionDetection = parsed.correctionDetection;
      if (isStringArray(parsed.correctionStrongPatterns)) config.correctionStrongPatterns = parsed.correctionStrongPatterns;
      if (isStringArray(parsed.correctionWeakPatterns)) config.correctionWeakPatterns = parsed.correctionWeakPatterns;
      if (isStringArray(parsed.correctionNegativePatterns)) config.correctionNegativePatterns = parsed.correctionNegativePatterns;
      if (isStringArray(parsed.correctionDirectiveWords)) config.correctionDirectiveWords = parsed.correctionDirectiveWords;
      if (typeof parsed.consolidationTimeoutMs === "number") {
        config.consolidationTimeoutMs = parsed.consolidationTimeoutMs;
        if (parsed.consolidationTimeoutMs < DEFAULT_CONSOLIDATION_TIMEOUT_MS) {
          console.warn(
            `⚠️ consolidationTimeoutMs is set to ${parsed.consolidationTimeoutMs}ms, below the ${DEFAULT_CONSOLIDATION_TIMEOUT_MS}ms default.`
            + " Consolidation spawns a child agent turn and is routinely killed mid-run at lower values.",
          );
        }
      }
      if (typeof parsed.autoConsolidationWarnOnFailure === "boolean") {
        config.autoConsolidationWarnOnFailure = parsed.autoConsolidationWarnOnFailure;
      }
      if (typeof parsed.failureInjectionEnabled === "boolean") config.failureInjectionEnabled = parsed.failureInjectionEnabled;
      if (typeof parsed.failureInjectionMaxAgeDays === "number") config.failureInjectionMaxAgeDays = parsed.failureInjectionMaxAgeDays;
      if (typeof parsed.failureInjectionMaxEntries === "number") config.failureInjectionMaxEntries = parsed.failureInjectionMaxEntries;
      if (typeof parsed.nudgeToolCalls === "number") config.nudgeToolCalls = parsed.nudgeToolCalls;
      // Accept any finite number >= 0 so a user can both opt in (positive value)
      // and explicitly disable retention with 0. Invalid/negative values are
      // ignored, keeping the current (default) semantics.
      if (typeof parsed.sessionRetentionDays === "number" && Number.isFinite(parsed.sessionRetentionDays) && parsed.sessionRetentionDays >= 0) {
        config.sessionRetentionDays = parsed.sessionRetentionDays;
      }
  if (typeof parsed.projectCharLimit === "number") config.projectCharLimit = parsed.projectCharLimit;
  // ─── ranking / anchors / guard ───
  if (parsed.ranking && typeof parsed.ranking === "object") {
    const r = parsed.ranking as Record<string, unknown>;
    const weights = (typeof r.weights === "object" && r.weights !== null) ? r.weights as Record<string, unknown> : {};
    const mergedWeights: SignalWeights = { ...DEFAULT_RANKING_CONFIG.weights };
    const weightKeys: (keyof SignalWeights)[] = ["fts", "term", "decay", "recency", "affinity"];
    for (const key of weightKeys) {
      const v = weights[key as string];
      if (typeof v === "number" && Number.isFinite(v)) mergedWeights[key] = v;
    }
    config.ranking = {
      enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULT_RANKING_CONFIG.enabled,
      halfLifeDays: typeof r.halfLifeDays === "number" && r.halfLifeDays > 0 ? r.halfLifeDays : DEFAULT_RANKING_CONFIG.halfLifeDays,
      reinforcementFactor: typeof r.reinforcementFactor === "number" && r.reinforcementFactor >= 0 ? r.reinforcementFactor : DEFAULT_RANKING_CONFIG.reinforcementFactor,
      rrfK: typeof r.rrfK === "number" && r.rrfK > 0 ? r.rrfK : DEFAULT_RANKING_CONFIG.rrfK,
      weights: mergedWeights,
      initialAccessCount:
        typeof r.initialAccessCount === "number" && r.initialAccessCount >= 0
          ? Math.trunc(r.initialAccessCount)
          : DEFAULT_RANKING_CONFIG.initialAccessCount,
      decayGraceDays:
        typeof r.decayGraceDays === "number" && r.decayGraceDays >= 0
          ? Math.trunc(r.decayGraceDays)
          : DEFAULT_RANKING_CONFIG.decayGraceDays,
    };
  }
  if (parsed.anchors && typeof parsed.anchors === "object") {
    const a = parsed.anchors as Record<string, unknown>;
    config.anchors = {
      enabled: typeof a.enabled === "boolean" ? a.enabled : DEFAULT_ANCHORS_CONFIG.enabled,
      minAccessCount: typeof a.minAccessCount === "number" && a.minAccessCount >= 0 ? Math.trunc(a.minAccessCount) : DEFAULT_ANCHORS_CONFIG.minAccessCount,
      maxAnchors: typeof a.maxAnchors === "number" && a.maxAnchors > 0 ? Math.trunc(a.maxAnchors) : DEFAULT_ANCHORS_CONFIG.maxAnchors,
    };
  }
  if (parsed.guard && typeof parsed.guard === "object") {
    const g = parsed.guard as Record<string, unknown>;
    const severity = g.severity === "block" || g.severity === "warn" ? (g.severity as GuardSeverity) : DEFAULT_GUARD_CONFIG.severity;
    config.guard = {
      enabled: typeof g.enabled === "boolean" ? g.enabled : DEFAULT_GUARD_CONFIG.enabled,
      severity,
      rulesPath: typeof g.rulesPath === "string" && g.rulesPath.trim() ? g.rulesPath.trim() : DEFAULT_GUARD_CONFIG.rulesPath,
    };
  }
      if (typeof parsed.memoryDir === "string") {
        const normalizedMemoryDir = normalizeConfiguredMemoryDir(parsed.memoryDir);
        if (normalizedMemoryDir) config.memoryDir = normalizedMemoryDir;
      }
      if (typeof parsed.projectsMemoryDir === "string") {
        const normalizedProjectsMemoryDir = normalizeProjectsMemoryDir(parsed.projectsMemoryDir);
        if (normalizedProjectsMemoryDir) config.projectsMemoryDir = normalizedProjectsMemoryDir;
      }
      if (
        typeof parsed.sessionSearch === "object" &&
        parsed.sessionSearch !== null &&
        isSessionSearchVariant(parsed.sessionSearch.variant)
      ) {
        config.sessionSearch = { variant: parsed.sessionSearch.variant };
      }
      if (typeof parsed.quickCheckOnOpen === "boolean") config.quickCheckOnOpen = parsed.quickCheckOnOpen;
      if (typeof parsed.llmModelOverride === "string") {
        const trimmed = parsed.llmModelOverride.trim();
        if (trimmed.length > 0) config.llmModelOverride = trimmed;
      }
      // Support array form for primary override too (e.g. llmModelOverride: ["a/b","c/d"]) — first entry is primary, rest are fallbacks
      if (Array.isArray(parsed.llmModelOverride) && parsed.llmModelOverride.every((v: unknown) => typeof v === "string")) {
        const cleaned = (parsed.llmModelOverride as string[]).map((s) => s.trim()).filter(Boolean);
        if (cleaned.length > 0) {
          config.llmModelOverride = cleaned[0];
          const fallbacks = cleaned.slice(1);
          if (fallbacks.length > 0) config.llmFallbackModels = fallbacks;
        }
      }
      if (isStringArray(parsed.llmFallbackModels)) {
        const cleaned = (parsed.llmFallbackModels as string[]).map((s) => s.trim()).filter(Boolean);
        if (cleaned.length > 0) config.llmFallbackModels = [...new Set([...(config.llmFallbackModels ?? []), ...cleaned])];
      }
      // Backward-compat alias: llmModelFallbacks / fallbackModels
      if (isStringArray((parsed as Record<string, unknown>).llmModelFallbacks)) {
        const cleaned = ((parsed as Record<string, unknown>).llmModelFallbacks as string[]).map((s: string) => s.trim()).filter(Boolean);
        if (cleaned.length > 0) config.llmFallbackModels = [...new Set([...(config.llmFallbackModels ?? []), ...cleaned])];
      }
      if (isStringArray((parsed as Record<string, unknown>).fallbackModels)) {
        const cleaned = ((parsed as Record<string, unknown>).fallbackModels as string[]).map((s: string) => s.trim()).filter(Boolean);
        if (cleaned.length > 0) config.llmFallbackModels = [...new Set([...(config.llmFallbackModels ?? []), ...cleaned])];
      }
      if (isThinkingLevel(parsed.llmThinkingOverride)) config.llmThinkingOverride = parsed.llmThinkingOverride;
      if (isStringArray(parsed.childExtensionPaths)) {
        const childExtensionPaths = [...new Set<string>(
          (parsed.childExtensionPaths as string[]).map((item) => item.trim()).filter(Boolean),
        )];
        if (childExtensionPaths.length > 0) config.childExtensionPaths = childExtensionPaths;
      }
      if (hasMemoryOverflowStrategy) {
        config.autoConsolidate = config.memoryOverflowStrategy === "auto-consolidate";
      } else if (hasLegacyAutoConsolidate) {
        config.memoryOverflowStrategy = config.autoConsolidate ? "auto-consolidate" : "reject";
      }
      return config;
    }
  } catch {
    // Fall back to defaults on parse error or access issues
  }
  return { ...DEFAULT_CONFIG };
}
