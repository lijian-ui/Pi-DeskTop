/**
 * Ranking orchestrator.
 *
 * Turns the FTS5 candidate set into a fused, re-ordered list. The store builds
 * RankCandidate[] (memory + FTS5 position), this module scores them with the
 * five signals and fuses with weighted RRF. Pure data in, ranked data out — no
 * SQLite access here.
 */

import type {
  RankableMemory,
  RankCandidate,
  RankedMemory,
  RankingConfig,
  RankingScope,
  SignalName,
} from './types';
import { buildSignals } from './signals';
import { reciprocalRankFusion } from './rrf';

export interface RankInputs {
  queryTokens: Set<string>;
  scope: RankingScope;
  config: RankingConfig;
  now: Date;
}

function collectRanks(
  signals: { name: SignalName; ranks: Map<number, number> }[],
  id: number,
): Partial<Record<SignalName, number>> {
  const ranks: Partial<Record<SignalName, number>> = {};
  for (const signal of signals) {
    const rank = signal.ranks.get(id);
    if (rank !== undefined) ranks[signal.name] = rank;
  }
  return ranks;
}

/**
 * Re-rank the candidate set using the configured signals and weighted RRF.
 * Returns entries sorted by fused score (descending).
 */
export function rankCandidates(candidates: RankCandidate[], inputs: RankInputs): RankedMemory[] {
  const signals = buildSignals(
    candidates,
    { queryTokens: inputs.queryTokens, scope: inputs.scope, now: inputs.now },
    inputs.config,
  );
  const fused = reciprocalRankFusion(signals, inputs.config.weights, inputs.config.rrfK);

  return candidates
    .map((candidate) => ({
      memory: candidate.memory,
      score: fused.get(candidate.memory.id) ?? 0,
      ranks: collectRanks(signals, candidate.memory.id),
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Convenience wrapper: build RankCandidate[] from memories + their FTS5 order,
 * then rank. `ftsOrderById` maps memory id -> 0-based FTS5 position (entries not
 * present default to worst).
 */
export function rankMemories(
  memories: RankableMemory[],
  ftsOrderById: Map<number, number>,
  inputs: RankInputs,
): RankedMemory[] {
  const candidates: RankCandidate[] = memories.map((memory, index) => ({
    memory,
    ftsOrder: ftsOrderById.get(memory.id) ?? index + memories.length + 1,
    ftsScore: null,
  }));
  return rankCandidates(candidates, inputs);
}
