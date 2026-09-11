/**
 * Web search / fetch — shared types.
 *
 * Output is normalized across providers so the extension layer never has to
 * know which backend served a call. Every provider adapter maps its own field
 * names into `SearchResult` / `FetchedPage`.
 */

/** One search hit, normalized. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  siteName?: string;
  publishedAt?: string;
  score?: number;
}

/** Normalized outcome of a search call. */
export interface SearchOutcome {
  query: string;
  /** Which backend actually served the call (after fallback). */
  backend: string;
  total?: number;
  results: SearchResult[];
}

/** Extracted page content. */
export interface FetchedPage {
  url: string;
  /** Final URL after redirects, when the backend reports it. */
  finalUrl?: string;
  title?: string;
  /** Markdown (preferred) or stripped text. */
  text: string;
  /** Which backend produced it: anysearch | tinyfish | local. */
  backend: string;
  /** True when `text` was cut short by a limit. */
  truncated: boolean;
}

export interface SearchOptions {
  query: string;
  /** Desired result count. Providers clamp to their own limits. */
  count?: number;
  /** Normalized recency vocabulary; each provider translates it. */
  freshness?: Freshness;
  signal?: AbortSignal;
}

/**
 * Shared recency vocabulary. Providers disagree on both the field name and
 * the accepted values, so adapters translate rather than pass through:
 *  - bocha:   `freshness` accepts these tokens directly
 *  - tavily:  `days` (integer) or `time_range`
 *  - tinyfish / anysearch: no recency filter — ignored
 */
export type Freshness = "noLimit" | "oneDay" | "oneWeek" | "oneMonth" | "oneYear";

/** Provider ids that can serve `web_search`. */
export type SearchProviderId = "anysearch" | "tinyfish" | "tavily" | "bocha";

/** Provider ids that can serve `web_fetch`. */
export type FetchProviderId = "anysearch" | "tinyfish" | "local" | "electron";

export type ProviderId = SearchProviderId | FetchProviderId;

/** Why a provider won (or lost) the routing decision. Logged on every call. */
export type ResolutionReason =
  | "caller-requested"
  | "configured-primary"
  | "auto-fallback";

/** Credentials + enable flag for a single provider. */
export interface ProviderConfig {
  apiKey: string;
  enabled: boolean;
}

export interface WebSearchConfig {
  /** Master switch. Off ⇒ tools are not registered at all. */
  enabled: boolean;
  /** Preferred search backend. Falls back along PROVIDER_ORDER on failure. */
  provider: SearchProviderId;
  /** Per-provider credentials. A provider without a usable key is skipped. */
  searchProviders: Record<SearchProviderId, ProviderConfig>;
  /** Preferred fetch backend. "local" fetches from the desktop process. */
  fetchProvider: FetchProviderId;
  /** Search results returned per call (1-10). */
  resultCount: number;
  /** Per-provider search timeout. */
  timeoutMs: number;
  /** Fetch timeout — browser-rendering backends are slow (up to ~110s/URL). */
  fetchTimeoutMs: number;
  /** Hard cap on extracted page characters handed to the model. */
  maxFetchChars: number;
  /** Block requests to private/loopback/link-local addresses (SSRF guard). */
  ssrfProtection: boolean;
  /** Render JS-heavy SPAs (今日头条 / 公众号壳 / Vue / React) with the bundled
   *  headless Chromium when plain-HTTP backends return only a shell. */
  electronRender: boolean;
  /** Hosts exempt from the SSRF guard (local dev servers). Hostnames only. */
  internalHostAllowlist: string[];
}

/**
 * Error carrying a machine-readable kind so the fallback chain can decide
 * whether trying another provider is worth it.
 *
 * `retryable` is false for credential/quota failures: switching backends would
 * only repeat the same outcome, so those surface to the model immediately.
 */
export type SearchErrorKind =
  | "auth"
  | "quota"
  | "rate_limit"
  | "timeout"
  | "network"
  | "bad_request";

export class WebSearchError extends Error {
  constructor(
    readonly kind: SearchErrorKind,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "WebSearchError";
  }
}

/** Canonical search fallback order (Chinese/global quality + reliability). */
export const SEARCH_PROVIDER_ORDER: readonly SearchProviderId[] = [
  "anysearch",
  "tinyfish",
  "tavily",
  "bocha",
];

/** Fetch fallback order. `electron` renders JS-heavy SPAs via headless Chromium;
 *  `local` stays the final no-dependency resort (plain HTTP, no rendering). */
export const FETCH_PROVIDER_ORDER: readonly FetchProviderId[] = [
  "anysearch",
  "tinyfish",
  "electron",
  "local",
];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anysearch: "AnySearch",
  tinyfish: "TinyFish",
  tavily: "Tavily",
  bocha: "博查",
  local: "本地抓取",
  electron: "浏览器渲染",
};

/** Human-readable URLs for the "top up / check usage" hints in errors. */
export const PROVIDER_CONSOLE_URLS: Record<ProviderId, string> = {
  anysearch: "https://www.anysearch.com/console/api-keys",
  tinyfish: "https://agent.tinyfish.ai/api-keys",
  tavily: "https://app.tavily.com/home",
  bocha: "https://open.bochaai.com/api-keys",
  local: "",
  electron: "",
};
