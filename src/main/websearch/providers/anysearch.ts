/**
 * AnySearch adapter — search + page extraction.
 *
 * Verified against the live API (2026-09-01):
 *  - POST https://api.anysearch.com/v1/search
 *      body { query, max_results (1-10), format: "json", tag?, zone?, language? }
 *      → { code: 0, data: { results: [{ title, url, snippet, content }],
 *                           metadata: { total_results } } }
 *  - POST https://api.anysearch.com/v1/extract
 *      body { url }
 *      → { code: 0, data: { url, title, content } }   content is Markdown
 *
 * Notes:
 *  - `code` 0 means success; any other value is a business error on HTTP 200.
 *  - Works anonymously (no key) at lower rate limits; the Authorization header
 *    is only sent when a key is configured.
 *  - Extraction output is capped at ~50k chars server-side, and only supports
 *    HTML / plain text / JSON / Markdown (no PDF or Office documents).
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

const API_BASE = "https://api.anysearch.com";
const LABEL = "AnySearch";
const CONSOLE_URL = PROVIDER_CONSOLE_URLS.anysearch;

function headers(cfg: ProviderConfig): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const key = cfg.apiKey?.trim();
  if (key) h.Authorization = `Bearer ${key}`;
  return h;
}

/** AnySearch reports success as `code: 0`, not 200. */
function assertOk(data: any): void {
  const code = data?.code;
  if (code !== undefined && code !== null && code !== 0) {
    const msg = data?.message || "未知错误";
    const retryable = code === 429 || Number(code) >= 500;
    throw businessError(
      retryable ? "rate_limit" : "bad_request",
      retryable,
      `${LABEL} 返回错误（code=${code}）：${msg}`,
    );
  }
}

export async function searchAnySearch(
  opts: SearchOptions,
  cfg: ProviderConfig,
  timeoutMs: number,
): Promise<SearchOutcome> {
  // AnySearch accepts 1-10 results regardless of what the tool schema allows.
  const maxResults = Math.min(10, Math.max(1, Math.trunc(opts.count ?? 5)));

  const data = await requestJson<any>({
    url: `${API_BASE}/v1/search`,
    method: "POST",
    headers: headers(cfg),
    body: { query: opts.query, max_results: maxResults, format: "json" },
    timeoutMs,
    signal: opts.signal,
    provider: LABEL,
    consoleUrl: CONSOLE_URL,
    inspect: assertOk,
  });

  const body = data?.data ?? {};
  const results = Array.isArray(body.results) ? body.results : [];

  return {
    query: opts.query,
    backend: "anysearch",
    total: (body.metadata as any)?.total_results ?? results.length,
    results: results.map((it: any) => ({
      title: String(it?.title ?? "").trim(),
      url: String(it?.url ?? "").trim(),
      // `snippet` is the short form; `content` is the same text with extras.
      snippet: String(it?.snippet ?? it?.content ?? "").trim(),
    })),
  };
}

export async function fetchAnySearch(
  url: string,
  cfg: ProviderConfig,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<FetchedPage> {
  const data = await requestJson<any>({
    url: `${API_BASE}/v1/extract`,
    method: "POST",
    headers: headers(cfg),
    body: { url },
    timeoutMs,
    signal,
    provider: LABEL,
    consoleUrl: CONSOLE_URL,
    inspect: assertOk,
  });

  const body = data?.data ?? {};
  const text = String(body?.content ?? "");
  if (!text.trim()) {
    throw new WebSearchError(
      "bad_request",
      false,
      `${LABEL} 未能提取到该页面的正文内容（可能是不支持的格式，如 PDF）。`,
    );
  }

  return {
    url,
    finalUrl: body?.url || url,
    title: body?.title ? String(body.title) : undefined,
    text,
    backend: "anysearch",
    truncated: false, // server caps at ~50k; caller applies its own limit
  };
}
