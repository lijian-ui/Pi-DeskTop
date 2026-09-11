/**
 * Bocha (博查) adapter — Chinese-first web search.
 *
 * Verified against the live API (2026-09-01):
 *  - POST https://api.bochaai.com/v1/web-search
 *      header Authorization: Bearer <key>
 *      body { query, count, freshness, summary }
 *      → success:  HTTP 200, { code: 200, data: { webPages: { value:
 *          [{ name, url, snippet, siteName, datePublished?, dateLastCrawled?,
 *             summary? }], totalEstimatedMatches } } }
 *      → failure:  HTTP 200, { code: "403", message: "You do not have enough
 *          money or package quota", log_id }   (business error ON 200!)
 *
 * Notes:
 *  - Success code is the INTEGER 200; failures use a string code (e.g. "403").
 *  - `freshness` tokens map 1:1 onto Bocha's vocabulary, so they pass through.
 *  - Snippet is the short form; `summary` (when requested) is richer. We prefer
 *    `summary` when present because it is far more useful to the model.
 *  - Bocha has no page-extraction endpoint, so it serves `web_search` only.
 */
import { businessError, requestJson } from "../http";
import {
  PROVIDER_CONSOLE_URLS,
  type ProviderConfig,
  type SearchOptions,
  type SearchOutcome,
} from "../types";

const SEARCH_URL = "https://api.bochaai.com/v1/web-search";
const LABEL = "博查";
const CONSOLE_URL = PROVIDER_CONSOLE_URLS.bocha;

function headers(cfg: ProviderConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${cfg.apiKey?.trim() ?? ""}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/** Bocha reports failures as a non-200 `code` riding on HTTP 200. */
function assertOk(data: any): void {
  const raw = data?.code;
  if (raw === undefined || raw === null) return; // tolerate shape without code
  if (Number(raw) === 200) return;
  const msg = data?.message || data?.msg || "未知错误";
  const retryable = Number(raw) === 429;
  throw businessError(
    retryable ? "rate_limit" : "quota",
    retryable,
    `${LABEL} 服务错误（code=${raw}）：${msg}`,
  );
}

export async function searchBocha(
  opts: SearchOptions,
  cfg: ProviderConfig,
  timeoutMs: number,
): Promise<SearchOutcome> {
  const count = Math.min(10, Math.max(1, Math.trunc(opts.count ?? 5)));

  const data = await requestJson<any>({
    url: SEARCH_URL,
    method: "POST",
    headers: headers(cfg),
    body: {
      query: opts.query,
      count,
      // Bocha accepts the shared freshness tokens verbatim.
      freshness: opts.freshness ?? "noLimit",
      summary: false,
    },
    timeoutMs,
    signal: opts.signal,
    provider: LABEL,
    consoleUrl: CONSOLE_URL,
    inspect: assertOk,
  });

  const webPages = (data?.data ?? {}).webPages ?? {};
  const pages = Array.isArray(webPages.value) ? webPages.value : [];

  return {
    query: opts.query,
    backend: "bocha",
    total: Number(webPages.totalEstimatedMatches ?? pages.length),
    results: pages.map((p: any) => ({
      title: String(p?.name ?? "").trim(),
      url: String(p?.url ?? "").trim(),
      snippet: String(p?.summary ?? p?.snippet ?? "").trim(),
      siteName: p?.siteName ? String(p.siteName) : undefined,
      publishedAt:
        p?.datePublished ?? p?.dateLastCrawled
          ? String(p.datePublished ?? p.dateLastCrawled)
          : undefined,
    })),
  };
}
