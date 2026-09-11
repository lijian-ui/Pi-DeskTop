/**
 * Tavily adapter — LLM-oriented search that returns de-duplicated content.
 *
 * Verified against the live API (2026-09-01):
 *  - POST https://api.tavily.com/search
 *      body { api_key, query, max_results, search_depth, time_range?, days? }
 *      → { query, answer, images, results: [{ url, title, content, score,
 *                                             published_date? }] }
 *
 * Notes:
 *  - The key travels in the JSON body (`api_key`), not in a header.
 *  - Recency uses its own vocabulary: `time_range` ∈ day|week|month|year.
 *    The shared `freshness` tokens are translated here.
 *  - `content` is Tavily's own extracted snippet, usually longer and cleaner
 *    than a raw search-engine snippet.
 */
import { businessError, requestJson } from "../http";
import {
  PROVIDER_CONSOLE_URLS,
  type Freshness,
  type ProviderConfig,
  type SearchOptions,
  type SearchOutcome,
} from "../types";

const SEARCH_URL = "https://api.tavily.com/search";
const LABEL = "Tavily";
const CONSOLE_URL = PROVIDER_CONSOLE_URLS.tavily;

const TIME_RANGE: Record<Exclude<Freshness, "noLimit">, string> = {
  oneDay: "day",
  oneWeek: "week",
  oneMonth: "month",
  oneYear: "year",
};

export async function searchTavily(
  opts: SearchOptions,
  cfg: ProviderConfig,
  timeoutMs: number,
): Promise<SearchOutcome> {
  const body: Record<string, unknown> = {
    api_key: cfg.apiKey?.trim() ?? "",
    query: opts.query,
    max_results: Math.min(20, Math.max(1, Math.trunc(opts.count ?? 5))),
    search_depth: "basic",
  };
  if (opts.freshness && opts.freshness !== "noLimit") {
    body.time_range = TIME_RANGE[opts.freshness];
  }

  const data = await requestJson<any>({
    url: SEARCH_URL,
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body,
    timeoutMs,
    signal: opts.signal,
    provider: LABEL,
    consoleUrl: CONSOLE_URL,
    inspect: (payload) => {
      if (!payload || !Array.isArray(payload.results)) {
        throw businessError("network", true, `${LABEL} 返回了意外的响应结构。`);
      }
    },
  });

  const results = (data.results as any[]) ?? [];
  return {
    query: opts.query,
    backend: "tavily",
    total: results.length,
    results: results.map((it: any) => ({
      title: String(it?.title ?? "").trim(),
      url: String(it?.url ?? "").trim(),
      snippet: String(it?.content ?? "").trim(),
      publishedAt: it?.published_date ? String(it.published_date) : undefined,
      score: typeof it?.score === "number" ? it.score : undefined,
    })),
  };
}
