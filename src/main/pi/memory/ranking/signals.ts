/**
 * Ranking signals.
 *
 * Each signal turns the candidate set into a 1-based ranking (1 = best) by
 * sorting on a per-candidate score. The ranker fuses these with weighted RRF,
 * so signals can be added or retuned independently.
 *
 * Signals:
 *  - fts:    FTS5 bm25 order (lower bm25 rank = better). The authoritative
 *            relevance signal from the trigram index.
 *  - term:   token-overlap count between the query and the entry's stored
 *            search_tokens (whole-word / dictionary-token matches).
 *  - decay:  age-based weight, stretched by how often the entry is referenced.
 *  - recency: shorter half-life decay on last_referenced, so recently used
 *            memories float up within their decay class.
 *  - affinity: project match with the active session scope.
 */

import type {
  RankableMemory,
  RankCandidate,
  RankingConfig,
  RankingScope,
  SignalName,
  SignalRanking,
} from './types';
import { getDictionary, type MemoryDictionary } from './dictionary';
import { tokenizeText } from './tokenizer';
import { daysSince, decayWeight, effectiveHalfLifeDays } from './decay';

export interface SignalInputs {
  queryTokens: Set<string>;
  scope: RankingScope;
  now: Date;
}

/** Assign 1-based ranks by descending score (highest score -> rank 1). */
function rankByScore(
  name: SignalName,
  candidates: RankCandidate[],
  scoreOf: (candidate: RankCandidate) => number,
): SignalRanking {
  const ordered = [...candidates].sort((a, b) => scoreOf(b) - scoreOf(a));
  const ranks = new Map<number, number>();
  ordered.forEach((c, idx) => ranks.set(c.memory.id, idx + 1));
  return { name, ranks };
}

/** FTS5 order: lower bm25 position is better. */
function ftsScore(candidate: RankCandidate): number {
  // ftsOrder is always set by the caller (nulls become worst), so this is safe.
  return -(candidate.ftsOrder ?? Number.MAX_SAFE_INTEGER);
}

function termScore(memory: RankableMemory, queryTokens: Set<string>): number {
  if (queryTokens.size === 0 || !memory.searchTokens) return 0;
  const entryTokens = memory.searchTokens.split(' ');
  let overlap = 0;
  for (const token of entryTokens) {
    if (token && queryTokens.has(token)) overlap++;
  }
  return overlap;
}

function decayScore(memory: RankableMemory, config: RankingConfig, now: Date): number {
  const ageDays = daysSince(memory.created, now);
  // Grace period: a freshly written memory sits at full weight for
  // `decayGraceDays`, so age cannot bury it before it has ever been surfaced.
  // This is what stops the "unreferenced -> ranks low -> never surfaced ->
  // never referenced" loop from applying to new entries.
  if (config.decayGraceDays > 0 && ageDays <= config.decayGraceDays) return 1;
  const halfLife = effectiveHalfLifeDays(config.halfLifeDays, memory.accessCount, config.reinforcementFactor);
  return decayWeight(ageDays, halfLife);
}

function recencyScore(memory: RankableMemory, config: RankingConfig, now: Date): number {
  // Recency uses a shorter half-life than base decay so recent use outweighs
  // mere age within the same decay class.
  const halfLife = effectiveHalfLifeDays(config.halfLifeDays, memory.accessCount, config.reinforcementFactor) * 0.5;
  return decayWeight(daysSince(memory.lastReferenced, now), halfLife);
}

function affinityScore(memory: RankableMemory, scope: RankingScope): number {
  // No active project scope -> neutral (do not penalize any entry).
  if (!scope.project) return 1;
  return memory.project === scope.project ? 1 : 0;
}

/**
 * Build all five signal rankings for the candidate set.
 */
export function buildSignals(
  candidates: RankCandidate[],
  inputs: SignalInputs,
  config: RankingConfig,
): SignalRanking[] {
  const { queryTokens, scope, now } = inputs;

  return [
    rankByScore('fts', candidates, (c) => ftsScore(c)),
    rankByScore('term', candidates, (c) => termScore(c.memory, queryTokens)),
    rankByScore('decay', candidates, (c) => decayScore(c.memory, config, now)),
    rankByScore('recency', candidates, (c) => recencyScore(c.memory, config, now)),
    rankByScore('affinity', candidates, (c) => affinityScore(c.memory, scope)),
  ];
}

/**
 * Tokenize a query for the term-overlap signal using the active dictionary.
 */
export function tokenizeQuery(query: string, memoryDir?: string | null): Set<string> {
  const dict: MemoryDictionary = getDictionary(memoryDir);
  return new Set(tokenizeText(query, dict));
}
