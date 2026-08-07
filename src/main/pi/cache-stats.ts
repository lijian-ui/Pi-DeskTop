/**
 * Prompt-cache statistics (port of the SDK's cache-stats.js algorithm).
 *
 * The SDK does NOT re-export these functions from its package entry
 * (`exports` only maps "." and "./rpc-entry"), so importing them from the
 * dist is blocked. The algorithm is small and dependency-free, so we vendor a
 * copy here rather than monkey-patching the library.
 *
 * What it computes: across a session, how many prompt tokens were re-billed
 * (charged as fresh input / cache-write) even though the previous turn's
 * prompt contained them (i.e. they should have been cache reads), plus the
 * extra cost vs. a full cache hit. A miss is a strong signal that the
 * provider's KV cache expired (idle > TTL), the model changed, or compaction
 * re-wrote the prefix.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Prompt-cache TTL: idle gaps longer than this are likely the cause of a miss
 *  (Anthropic's default cache TTL is 5 minutes). */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/** Per-turn misses at or below this are cache breakpoint granularity noise. */
const NOISE_FLOOR_TOKENS = 1024;

/** Minimal pricing lookup, satisfied by ModelRuntime. Cost is $/million tokens. */
export interface ModelPriceSource {
  getModel(
    provider: string,
    modelId: string,
  ):
    | {
        cost: { cacheRead: number };
      }
    | undefined;
}

/** A counted cache miss on a single assistant message. */
export interface CacheMiss {
  /** Prompt tokens that were in the previous turn's prompt but not read from cache. */
  missedTokens: number;
  /** Extra dollars paid vs. a full cache hit; 0 when pricing is unknown. */
  missedCost: number;
  /** Milliseconds since the previous request (which last refreshed the cache). */
  idleMs: number;
  /** True when the model changed relative to the previous request. */
  modelChanged: boolean;
}

/** Cumulative cache waste across a session. */
export interface CacheWasteTotals {
  missedTokens: number;
  missedCost: number;
  /** Number of counted misses (turns above the noise floor). */
  missCount: number;
}

interface PreviousRequest {
  promptTokens: number;
  modelKey: string;
  timestamp: number;
  reportedCache: boolean;
}

function detectMiss(
  prev: PreviousRequest | undefined,
  message: any,
  models: ModelPriceSource,
): CacheMiss | undefined {
  const usage = message.usage;
  if (!usage) return undefined;
  const promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  // A zero-cache turn only counts when cache activity was reported before:
  // on cache-read-only providers that is a total miss, while on providers
  // that never report caching it means nothing.
  if (
    !prev ||
    promptTokens <= 0 ||
    ((usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) === 0 && !prev.reportedCache)
  ) {
    return undefined;
  }
  const missedTokens = Math.min(prev.promptTokens, promptTokens) - (usage.cacheRead ?? 0);
  if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;

  // Extra cost = missed tokens billed at the actual paid rate (input/cacheWrite,
  // incl. write premium) instead of the cache-read rate.
  const paidTokens = (usage.input ?? 0) + (usage.cacheWrite ?? 0);
  const paidPerToken =
    paidTokens > 0
      ? ((usage.cost?.input ?? 0) + (usage.cost?.cacheWrite ?? 0)) / paidTokens
      : 0;
  const readPerToken =
    (usage.cacheRead ?? 0) > 0
      ? (usage.cost?.cacheRead ?? 0) / (usage.cacheRead ?? 1)
      : (models.getModel(message.provider, message.model)?.cost.cacheRead ?? 0) / 1_000_000;
  return {
    missedTokens,
    missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
    idleMs: Math.max(0, (message.timestamp ?? 0) - (prev?.timestamp ?? 0)),
    modelChanged: `${message.provider}/${message.model}` !== prev.modelKey,
  };
}

function asPreviousRequest(message: any, reportedCache: boolean): PreviousRequest | undefined {
  const usage = message.usage;
  if (!usage) return undefined;
  const promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  if (promptTokens <= 0) return undefined;
  return {
    promptTokens,
    modelKey: `${message.provider}/${message.model}`,
    timestamp: message.timestamp ?? Date.now(),
    reportedCache:
      reportedCache || (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) > 0,
  };
}

function scan(entries: SessionEntry[], models: ModelPriceSource) {
  let prev: PreviousRequest | undefined;
  const totals: CacheWasteTotals = { missedTokens: 0, missedCost: 0, missCount: 0 };
  for (const entry of entries) {
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      // The context legitimately changed; the next turn's prompt is new content,
      // not re-billed content. Model switches are NOT exempt: they re-bill the
      // full prompt and should be counted.
      prev = undefined;
      continue;
    }
    if (entry.type === "message" && entry.message?.role === "assistant") {
      const miss = detectMiss(prev, entry.message, models);
      if (miss) {
        totals.missedTokens += miss.missedTokens;
        totals.missedCost += miss.missedCost;
        totals.missCount += 1;
      }
      prev = asPreviousRequest(entry.message, prev?.reportedCache ?? false) ?? prev;
    }
  }
  return { totals };
}

/**
 * Cumulative cache waste across a session: prompt tokens that should have been
 * cache reads (they were in the previous turn's prompt) but were re-billed.
 */
export function computeCacheWaste(
  entries: SessionEntry[],
  models: ModelPriceSource,
): CacheWasteTotals {
  return scan(entries, models).totals;
}
