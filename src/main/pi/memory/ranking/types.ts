/**
 * Shared types for the memory ranking subsystem.
 *
 * The ranking layer sits on top of the existing FTS5 search: SQLite still
 * produces the candidate set, this layer re-orders it by fusing several
 * independent signals with weighted reciprocal rank fusion (RRF).
 */

import type { MemoryCategory } from '../types';

/** A memory row enriched with the columns the ranker needs. */
export interface RankableMemory {
  id: number;
  content: string;
  project: string | null;
  target: 'memory' | 'user' | 'failure';
  category: MemoryCategory | null;
  created: string;
  lastReferenced: string;
  accessCount: number;
  pinned: boolean;
  /** Raw space-separated token string as stored in memories.search_tokens. */
  searchTokens: string;
}

/** Scope of the active session, used by the affinity signal. */
export interface RankingScope {
  project: string | null;
}

/** One candidate plus the signal inputs that depend on how it was retrieved. */
export interface RankCandidate {
  memory: RankableMemory;
  /** Position in the FTS5 result list (0-based), or null when not from FTS. */
  ftsOrder: number | null;
  /** Raw bm25 score when available (lower is better); informational only. */
  ftsScore: number | null;
}

/** A signal produces a 1-based rank per candidate id. */
export interface SignalRanking {
  name: SignalName;
  /** id -> 1-based rank (1 = best). */
  ranks: Map<number, number>;
}

export type SignalName = 'fts' | 'term' | 'decay' | 'recency' | 'affinity';

export type SignalWeights = Record<SignalName, number>;

export interface RankingConfig {
  enabled: boolean;
  /** Days until a never-reinforced memory drops to half weight. */
  halfLifeDays: number;
  /** How much each recorded access stretches the half-life (log-scaled). */
  reinforcementFactor: number;
  /** RRF damping constant. Larger values flatten rank differences. */
  rrfK: number;
  weights: SignalWeights;
  /**
   * Access count a memory starts with, so a fresh write is not permanently
   * stuck at zero reinforcement. Default: 1.
   *
   * Without a floor, reinforcement only rewards memories that a search has
   * already surfaced — a chicken-and-egg problem: an unreferenced memory ranks
   * low, so it is never surfaced, so it never gains access, so it keeps
   * ranking low. The store's own auto-extraction writes would never escape it.
   */
  initialAccessCount: number;
  /**
   * Days after creation during which decay is not applied, so brand-new
   * memories get a fair chance to be surfaced before age can bury them.
   * Default: 14. Set 0 to disable.
   */
  decayGraceDays: number;
}

export interface RankedMemory {
  memory: RankableMemory;
  /** Fused RRF score (higher is better). */
  score: number;
  /** Per-signal ranks that contributed, for debugging. */
  ranks: Partial<Record<SignalName, number>>;
}
