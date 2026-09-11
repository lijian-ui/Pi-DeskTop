/**
 * Small TTL + LRU cache for fetched page content.
 *
 * Why it exists: a single turn often has the model fetch the same URL twice
 * (e.g. once from `web_search` results, once to verify a claim). Each fetch
 * costs 8-12K tokens of context, and on a small model that is enough to trip
 * auto-compaction — which rewrites history and drops the prompt cache entirely.
 * De-duplicating the repeat is cheaper than any truncation we could add later.
 *
 * Deliberately tiny: entries are large strings, so the cap is in entries, not
 * bytes, and eviction is plain insertion order.
 */

import { type FetchedPage } from "./types";

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private readonly map = new Map<string, Entry<T>>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;

    if (Date.now() > hit.expiresAt) {
      this.map.delete(key);
      return undefined;
    }

    // Refresh recency: Map preserves insertion order, so re-inserting moves
    // the key to the tail (most-recent) position.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: T): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    this.evict();
  }

  private evict(): void {
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done) return;
      this.map.delete(oldest.value);
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/** Shared page cache: 32 pages, 30 minutes. */
export const pageCache = new TtlCache<FetchedPage>(32, 30 * 60 * 1000);
