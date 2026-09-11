/**
 * Memory config panel service — bridges the desktop UI to the Hermes
 * hermes-memory-config.json file.
 *
 * Renderer never touches the file or the in-process config object directly:
 * - getMemoryConfigView() returns a plain serializable snapshot of the
 *   "core memory knobs" the panel exposes.
 * - saveMemoryConfigView() validates + persists the patch, then hot-reloads
 *   the live extension config so changes take effect without a restart.
 */

import { loadConfig, saveConfig, type MemoryConfigPatch } from "./config";
import { reloadMemoryConfig, hasLiveMemoryConfig } from "./index";
import type { GuardSeverity } from "./guard/types";

/** Serializable snapshot of the memory settings the panel can edit. */
export interface MemoryConfigView {
  // Auto-save (session flush)
  flushOnShutdown: boolean;
  flushOnCompact: boolean;
  flushMinTurns: number;
  flushRecentMessages: number;
  // Background review
  reviewEnabled: boolean;
  reviewRecentMessages: number;
  nudgeInterval: number;
  nudgeToolCalls: number;
  // Correction detection
  correctionDetection: boolean;
  // Failure lessons (injected in BOTH memory modes — see prompt-context.ts)
  failureInjectionEnabled: boolean;
  failureInjectionMaxAgeDays: number;
  failureInjectionMaxEntries: number;
  // Ranking / time-decay
  rankingEnabled: boolean;
  halfLifeDays: number;
  reinforcementFactor: number;
  /** Reinforcement a brand-new memory starts with (0 = old frozen behaviour). */
  initialAccessCount: number;
  /** Grace period (days) before a new memory starts decaying. */
  decayGraceDays: number;
  // Anchors
  anchorsEnabled: boolean;
  minAccessCount: number;
  maxAnchors: number;
  // Guard
  guardEnabled: boolean;
  guardSeverity: GuardSeverity;
  // Runtime status
  hotReloadAvailable: boolean;
}

/** Read the current on-disk config as a panel view. */
export function getMemoryConfigView(): MemoryConfigView {
  const c = loadConfig();
  const ranking = c.ranking;
  const anchors = c.anchors;
  const guard = c.guard;
  return {
    flushOnShutdown: c.flushOnShutdown,
    flushOnCompact: c.flushOnCompact,
    flushMinTurns: c.flushMinTurns,
    flushRecentMessages: c.flushRecentMessages ?? 0,
    reviewEnabled: c.reviewEnabled,
    reviewRecentMessages: c.reviewRecentMessages ?? 0,
    nudgeInterval: c.nudgeInterval,
    nudgeToolCalls: c.nudgeToolCalls,
    correctionDetection: c.correctionDetection,
    failureInjectionEnabled: c.failureInjectionEnabled ?? true,
    failureInjectionMaxAgeDays: c.failureInjectionMaxAgeDays ?? 7,
    failureInjectionMaxEntries: c.failureInjectionMaxEntries ?? 5,
    rankingEnabled: ranking?.enabled ?? true,
    halfLifeDays: ranking?.halfLifeDays ?? 180,
    reinforcementFactor: ranking?.reinforcementFactor ?? 0.5,
    initialAccessCount: ranking?.initialAccessCount ?? 1,
    decayGraceDays: ranking?.decayGraceDays ?? 14,
    anchorsEnabled: anchors?.enabled ?? true,
    minAccessCount: anchors?.minAccessCount ?? 3,
    maxAnchors: anchors?.maxAnchors ?? 5,
    guardEnabled: guard?.enabled ?? true,
    guardSeverity: guard?.severity ?? "block",
    hotReloadAvailable: hasLiveMemoryConfig(),
  };
}

/**
 * Persist a config patch and hot-reload the live extension.
 * Returns the normalized view plus whether the running extension picked it up.
 */
export function saveMemoryConfigView(patch: MemoryConfigPatch): {
  view: MemoryConfigView;
  hotReloaded: boolean;
} {
  saveConfig(patch);
  const hotReloaded = reloadMemoryConfig();
  return { view: getMemoryConfigView(), hotReloaded };
}
