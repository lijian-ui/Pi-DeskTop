/**
 * TinyFish adapter — search + browser-rendered page extraction.
 *
 * Verified against the live API (2026-09-01):
 *  - GET https://api.search.tinyfish.ai?query=...&location=US&language=en
 *      header X-API-Key
 *      → { query, results: [{ position, site_name, snippet, title, url, date? }] }
 *  - POST https://api.fetch.tinyfish.ai   header X-API-Key
 *      body { urls: [...] }  (up to 10 per request)
 *      → { results: [{ url, final_url, title, description, language, text }] }
 *
 * Notes:
 *  - Search and Fetch are free (no credits); only Agent/Browser bill.
 *  - Fetch renders in a real browser, so JS-driven SPAs come back as text
 *    where a plain HTTP client would only see an empty shell. It is also slow:
 *    ~110s per-URL backend budget, so callers need a generous timeout.
 *  - Auth uses `X-API-Key`, NOT `Authorization: Bearer`.
 */
import { businessError, requestJson } from "../http";
import {
  PROVIDER_CONSOLE_URLS,
  WebSearchError,
  type FetchedPage,
  type ProviderConfig,
  type SearchOptions,
  type SearchOutcome,
} from "../types";

const SEARCH_URL = "https://api.search.tinyfish.ai";
const FETCH_URL = "https://api.fetch.tinyfish.ai";
const LABEL = "TinyFish";
const CONSOLE_URL = PROVIDER_CONSOLE_URLS.tinyfish;

function headers(cfg: ProviderConfig): Record<string, string> {
  return { "X-API-Key": cfg.apiKey?.trim() ?? "", Accept: "application/json" };
}

export async function searchTinyFish(
  opts: SearchOptions,
  cfg: ProviderConfig,
  timeoutMs: number,
): Promise<SearchOutcome> {
  const params = new URLSearchParams({
    query: opts.query,
    location: "CN",
    language: "zh",
  });

  const data = await requestJson<any>({
    url: `${SEARCH_URL}?${params.toString()}`,
    method: "GET",
    headers: headers(cfg),
    timeoutMs,
    signal: opts.signal,
    provider: LABEL,
    consoleUrl: CONSOLE_URL,
    inspect: (body) => {
      if (!body || !Array.isArray(body.results)) {
        throw businessError("network", true, `${LABEL} 返回了意外的响应结构。`);
      }
    },
  });

  const results = (data.results as any[]) ?? [];
  return {
    query: opts.query,
    backend: "tinyfish",
    total: results.length,
    results: results.map((it: any) => ({
      title: String(it?.title ?? "").trim(),
      url: String(it?.url ?? "").trim(),
      snippet: String(it?.snippet ?? "").trim(),
      siteName: it?.site_name ? String(it.site_name) : undefined,
      publishedAt: it?.date ? String(it.date) : undefined,
      score: typeof it?.position === "number" ? it.position : undefined,
    })),
  };
}

export async function fetchTinyFish(
  url: string,
  cfg: ProviderConfig,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<FetchedPage> {
  const data = await requestJson<any>({
    url: FETCH_URL,
    method: "POST",
    headers: { ...headers(cfg), "Content-Type": "application/json" },
    body: { urls: [url] },
    timeoutMs,
    signal,
    provider: LABEL,
    consoleUrl: CONSOLE_URL,
    inspect: (body) => {
      if (!body || !Array.isArray(body.results)) {
        throw businessError("network", true, `${LABEL} 返回了意外的响应结构。`);
      }
    },
  });

  const first = (data.results as any[])?.[0];
  const text = String(first?.text ?? "");
  if (!text.trim()) {
    throw new WebSearchError(
      "bad_request",
      false,
      `${LABEL} 未能提取到该页面的正文内容。`,
    );
  }

  return {
    url,
    finalUrl: first?.final_url || first?.url || url,
    title: first?.title ? String(first.title) : undefined,
    text,
    backend: "tinyfish",
    truncated: false, // caller applies maxFetchChars
  };
}
