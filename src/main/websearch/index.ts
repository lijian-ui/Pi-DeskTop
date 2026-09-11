/**
 * Unified web-search entry point.
 *
 * Responsibilities:
 *  - Read config on every call (so setting changes apply without a session
 *    reload) and short-circuit when the feature is off.
 *  - Route a `web_search` / `web_fetch` call across the configured providers in
 *    a deterministic fallback order, classifying errors so non-retryable ones
 *    (bad key / out of quota) surface to the model immediately instead of
 *    burning every other provider on the same doomed call.
 *  - Guard `web_fetch` against SSRF (model-supplied URLs) and de-duplicate
 *    repeat fetches with a small TTL+LRU cache — repeats would otherwise cost
 *    8-12K tokens each and, on a small model, trip auto-compaction.
 *  - Cap returned text to a caller-supplied budget (default `maxFetchChars`),
 *    dropping the tail rather than inserting a "[truncated]" placeholder that
 *    would itself consume context.
 *
 * This module is Pi-agnostic: it takes plain strings/AbortSignals and returns
 * normalized shapes. The Pi extension owns all tool/event wiring.
 */
import { WebSearchError, type FetchedPage, type SearchOptions, type SearchOutcome } from "./types";
import {
  SEARCH_PROVIDER_ORDER,
  FETCH_PROVIDER_ORDER,
  readWebSearchConfigSync,
  usableSearchProviders,
  type SearchProviderId,
  type FetchProviderId,
  type WebSearchConfig,
} from "./config";
import { assertUrlSafe, safeFetch } from "./url-safety";
import { pageCache } from "./cache";
import { searchAnySearch, fetchAnySearch } from "./providers/anysearch";
import { searchTinyFish, fetchTinyFish } from "./providers/tinyfish";
import { searchTavily } from "./providers/tavily";
import { searchBocha } from "./providers/bocha";
import { fetchElectron, SPA_FALLBACK_MIN } from "./electron-render";

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function callSearch(
  id: SearchProviderId,
  cfg: WebSearchConfig,
  opts: SearchOptions,
): Promise<SearchOutcome> {
  const pc = cfg.searchProviders[id];
  switch (id) {
    case "anysearch":
      return searchAnySearch(opts, pc, cfg.timeoutMs);
    case "tinyfish":
      return searchTinyFish(opts, pc, cfg.timeoutMs);
    case "tavily":
      return searchTavily(opts, pc, cfg.timeoutMs);
    case "bocha":
      return searchBocha(opts, pc, cfg.timeoutMs);
  }
}

/** Preferred provider first, then the rest in canonical order (usable only). */
function searchOrder(cfg: WebSearchConfig): SearchProviderId[] {
  const usable = new Set(usableSearchProviders(cfg));
  const preferred = cfg.provider;
  const ordered: SearchProviderId[] = [];
  if (usable.has(preferred)) ordered.push(preferred);
  for (const id of SEARCH_PROVIDER_ORDER) {
    if (usable.has(id) && id !== preferred) ordered.push(id);
  }
  return ordered;
}

export async function search(query: string, signal?: AbortSignal): Promise<SearchOutcome> {
  const cfg = readWebSearchConfigSync();
  if (!cfg.enabled) {
    throw new WebSearchError("bad_request", false, "Web 搜索功能未启用。");
  }
  const order = searchOrder(cfg);
  if (order.length === 0) {
    throw new WebSearchError(
      "auth",
      false,
      "未配置任何可用的搜索 provider，请在设置中填入 API key。",
    );
  }

  const opts: SearchOptions = { query, count: cfg.resultCount, signal };
  let lastError: unknown;
  for (const id of order) {
    try {
      return await callSearch(id, cfg, opts);
    } catch (err) {
      if (isUserAbort(err)) throw err;
      // Fall through to the next provider on ANY failure: each provider is a
      // separate account, so a bad key / quota / 5xx on one does not imply the
      // others are down. Only a user-initiated abort stops the chain.
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new WebSearchError("network", true, "所有搜索 provider 均失败。");
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

function callFetch(
  id: FetchProviderId,
  url: string,
  cfg: WebSearchConfig,
  signal?: AbortSignal,
): Promise<FetchedPage> {
  switch (id) {
    case "anysearch":
      return fetchAnySearch(url, cfg.searchProviders.anysearch, cfg.fetchTimeoutMs, signal);
    case "tinyfish":
      return fetchTinyFish(url, cfg.searchProviders.tinyfish, cfg.fetchTimeoutMs, signal);
    case "electron":
      return fetchElectron(
        url,
        { ssrfEnabled: cfg.ssrfProtection, allowlist: cfg.internalHostAllowlist },
        cfg.fetchTimeoutMs,
        signal,
      );
    case "local":
      return fetchLocal(url, cfg, signal);
  }
}

function fetchOrder(cfg: WebSearchConfig): FetchProviderId[] {
  const has = (id: FetchProviderId): boolean =>
    id === "local" ||
    (id === "electron" && cfg.electronRender !== false) ||
    (id === "anysearch" && cfg.searchProviders.anysearch?.enabled && !!cfg.searchProviders.anysearch?.apiKey?.trim()) ||
    (id === "tinyfish" && cfg.searchProviders.tinyfish?.enabled && !!cfg.searchProviders.tinyfish?.apiKey?.trim());
  const preferred = cfg.fetchProvider;
  const ordered: FetchProviderId[] = [];
  if (has(preferred)) ordered.push(preferred);
  for (const id of FETCH_PROVIDER_ORDER) {
    if (has(id) && id !== preferred) ordered.push(id);
  }
  return ordered;
}

/**
 * Fetch a page and return its text, capped at `maxChars` (tail dropped, no
 * placeholder). `maxChars` defaults to config.maxFetchChars but the caller may
 * pass a tighter budget derived from the live context window.
 */
export async function fetchPage(
  url: string,
  signal?: AbortSignal,
  maxChars?: number,
): Promise<FetchedPage> {
  const cfg = readWebSearchConfigSync();
  if (!cfg.enabled) {
    throw new WebSearchError("bad_request", false, "Web 抓取功能未启用。");
  }

  await assertUrlSafe(url, {
    enabled: cfg.ssrfProtection,
    allowlist: cfg.internalHostAllowlist,
  });

  const cached = pageCache.get(url);
  const cap = maxChars ?? cfg.maxFetchChars;

  if (cached !== undefined) {
    const trimmed = trimToChars(cached.text, cap);
    return {
      url,
      finalUrl: cached.finalUrl ?? url,
      title: cached.title,
      text: trimmed.text,
      backend: `${cached.backend}(cache)`,
      truncated: trimmed.truncated,
    };
  }

  let lastError: unknown;
  let bestShort: FetchedPage | null = null;
  const order = fetchOrder(cfg);
  for (const id of order) {
    try {
      const page = await callFetch(id, url, cfg, signal);
      const trimmed = trimToChars(page.text, cap);
      // A real body is long enough to read; cache + return immediately.
      if (trimmed.text.length >= SPA_FALLBACK_MIN) {
        pageCache.set(url, page);
        return { ...page, text: trimmed.text, truncated: trimmed.truncated };
      }
      // Too short ⇒ likely an SPA shell. Keep the longest attempt as a fallback.
      if (!bestShort || trimmed.text.length > bestShort.text.length) {
        bestShort = { ...page, text: trimmed.text, truncated: trimmed.truncated };
      }
    } catch (err) {
      if (isUserAbort(err)) throw err;
      lastError = err;
    }
  }

  // Every plain-HTTP backend returned only a shell or failed ⇒ try headless
  // Chromium once. Skipped if the user disabled it or already tried it in `order`.
  if (cfg.electronRender !== false && !order.includes("electron")) {
    try {
      const page = await fetchElectron(
        url,
        { ssrfEnabled: cfg.ssrfProtection, allowlist: cfg.internalHostAllowlist },
        cfg.fetchTimeoutMs,
        signal,
      );
      const trimmed = trimToChars(page.text, cap);
      pageCache.set(url, page);
      return { ...page, text: trimmed.text, truncated: trimmed.truncated };
    } catch (err) {
      if (isUserAbort(err)) throw err;
      lastError = err;
    }
  }

  // Return the longest shell we got rather than erroring on a genuinely short page.
  if (bestShort) return bestShort;
  throw lastError instanceof Error
    ? lastError
    : new WebSearchError("network", true, "所有抓取 provider 均失败。");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isUserAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

// ---------------------------------------------------------------------------
// Connectivity test (settings page "测试" button)
// ---------------------------------------------------------------------------

export interface ProviderTestResult {
  id: SearchProviderId;
  ok: boolean;
  backend?: string;
  error?: string;
}

/** Probe every configured search provider once; never throws. */
export async function testProviders(): Promise<ProviderTestResult[]> {
  const cfg = readWebSearchConfigSync();
  const usable = usableSearchProviders(cfg);
  const results: ProviderTestResult[] = [];
  const signal = AbortSignal.timeout(Math.min(8_000, cfg.timeoutMs));
  for (const id of usable) {
    try {
      const out = await callSearch(id, cfg, { query: "connectivity test", count: 1, signal });
      results.push({ id, ok: true, backend: out.backend });
    } catch (err) {
      results.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (results.length === 0) {
    results.push({ id: cfg.provider, ok: false, error: "未配置任何可用 provider。" });
  }
  return results;
}

export function trimToChars(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  // Drop the tail. No "[truncated]" placeholder — it would cost context while
  // adding no signal.
  return { text: text.slice(0, maxChars), truncated: true };
}

/**
 * Last-resort fetch using the desktop process directly. Renders are handled by
 * the cloud backends (anysearch/tinyfish); here we only do a guarded GET and a
 * crude HTML→text strip. Intentionally minimal: it exists so the tool never
 * dies when every remote backend is down, not to match their quality.
 */
async function fetchLocal(
  url: string,
  cfg: WebSearchConfig,
  signal?: AbortSignal,
): Promise<FetchedPage> {
  const { response } = await safeFetch(
    url,
    { enabled: cfg.ssrfProtection, allowlist: cfg.internalHostAllowlist },
    { signal },
    cfg.fetchTimeoutMs,
  );
  const raw = await response.text();
  const text = stripHtml(raw);
  if (!text.trim()) {
    throw new WebSearchError("bad_request", false, "本地抓取未能提取到正文内容。");
  }
  return {
    url,
    finalUrl: response.url || url,
    title: undefined,
    text,
    backend: "local",
    truncated: false,
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
