/**
 * Weighted reciprocal rank fusion (RRF).
 *
 * Each signal produces a 1-based rank per candidate (1 = best). RRF fuses them
 * into a single score by summing `weight / (k + rank)` across signals. RRF is
 * rank-based rather than score-based, so heterogeneous signals (bm25 order,
 * decay weight, term overlap count) combine without brittle score normalization.
 */

import type { SignalName, SignalRanking, SignalWeights } from './types';

/**
 * Fuse per-signal rankings into one score map (id -> fused score, higher better).
 */
export function reciprocalRankFusion(
  rankings: SignalRanking[],
  weights: SignalWeights,
  k: number,
): Map<number, number> {
  const fused = new Map<number, number>();
  const allIds = new Set<number>();
  for (const ranking of rankings) {
    for (const id of ranking.ranks.keys()) allIds.add(id);
  }

  for (const id of allIds) {
    let score = 0;
    for (const ranking of rankings) {
      const rank = ranking.ranks.get(id);
      if (rank === undefined) continue;
      const weight = weights[ranking.name] ?? 0;
      if (weight <= 0) continue;
      score += weight / (k + rank);
    }
    fused.set(id, score);
  }

  return fused;
}

export type { SignalName };
