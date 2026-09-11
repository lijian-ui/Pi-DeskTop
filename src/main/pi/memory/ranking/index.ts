/**
 * Memory ranking subsystem — public API.
 *
 * Layers:
 *  - dictionary / tokenizer: CJK-aware tokenization for the term-overlap signal
 *    and for storing memories.search_tokens at write time.
 *  - decay: age × reinforcement half-life math.
 *  - signals: the five independent ranking signals.
 *  - rrf: weighted reciprocal rank fusion.
 *  - ranker: orchestrates signals -> fused, ordered results.
 */

export { tokenizeText, tokenizeForStorage } from './tokenizer';
export { getDictionary, clearDictionaryCache, DICT_EXTRA_FILENAME } from './dictionary';
export type { MemoryDictionary } from './dictionary';
export { daysSince, decayWeight, effectiveHalfLifeDays } from './decay';
export { buildSignals, tokenizeQuery, type SignalInputs } from './signals';
export { reciprocalRankFusion } from './rrf';
export { rankCandidates, rankMemories, type RankInputs } from './ranker';
export type {
  RankableMemory,
  RankCandidate,
  RankedMemory,
  RankingScope,
  SignalRanking,
  SignalName,
  SignalWeights,
  RankingConfig,
} from './types';
