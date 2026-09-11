/**
 * Web search config — read/write of `websearch-config.json`.
 *
 * Stored in the agent dir alongside `im-config.json` / `auth.json`. API keys
 * are held in plaintext by design (the user edits this file by hand); they are
 * never written to logs.
 */
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
  SEARCH_PROVIDER_ORDER,
  type SearchProviderId,
  type WebSearchConfig,
} from "./types";

const WEBSEARCH_CONFIG_FILE = "websearch-config.json";

function emptyProviderMap(): Record<SearchProviderId, { apiKey: string; enabled: boolean }> {
  return {
    anysearch: { apiKey: "", enabled: false },
    tinyfish: { apiKey: "", enabled: false },
    tavily: { apiKey: "", enabled: false },
    bocha: { apiKey: "", enabled: false },
  };
}

function defaultConfig(): WebSearchConfig {
  return {
    enabled: false,
    provider: "anysearch",
    searchProviders: emptyProviderMap(),
    fetchProvider: "anysearch",
    resultCount: 5,
    timeoutMs: 15_000,
    fetchTimeoutMs: 90_000,
    maxFetchChars: 12_000,
    ssrfProtection: true,
    electronRender: true,
    internalHostAllowlist: ["localhost", "127.0.0.1"],
  };
}

/**
 * Fill in missing fields from `defaults` so a partial or hand-edited file still
 * yields a complete config. Unknown/absent providers get empty credentials.
 */
function normalize(raw: any): WebSearchConfig {
  const d = defaultConfig();
  if (!raw || typeof raw !== "object") return d;

  const providers = emptyProviderMap();
  const rawProviders = raw.searchProviders;
  if (rawProviders && typeof rawProviders === "object") {
    for (const id of SEARCH_PROVIDER_ORDER) {
      const entry = (rawProviders as any)[id];
      if (entry && typeof entry === "object") {
        providers[id] = {
          apiKey: typeof entry.apiKey === "string" ? entry.apiKey : "",
          enabled: entry.enabled !== false,
        };
      } else if (typeof entry === "string") {
        // Tolerate the legacy flat form { bocha: "sk-..." }.
        providers[id] = { apiKey: entry, enabled: entry.length > 0 };
      }
    }
  }

  const num = (v: unknown, fallback: number, min: number, max: number): number => {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
  };

  const provider = SEARCH_PROVIDER_ORDER.includes(raw.provider)
    ? (raw.provider as SearchProviderId)
    : d.provider;

  const fetchProvider =
    raw.fetchProvider === "tinyfish" ||
    raw.fetchProvider === "local" ||
    raw.fetchProvider === "electron"
      ? raw.fetchProvider
      : d.fetchProvider;

  return {
    enabled: raw.enabled === true,
    provider,
    searchProviders: providers,
    fetchProvider,
    resultCount: num(raw.resultCount, d.resultCount, 1, 10),
    timeoutMs: num(raw.timeoutMs, d.timeoutMs, 1_000, 120_000),
    fetchTimeoutMs: num(raw.fetchTimeoutMs, d.fetchTimeoutMs, 1_000, 180_000),
    maxFetchChars: num(raw.maxFetchChars, d.maxFetchChars, 500, 200_000),
    ssrfProtection: raw.ssrfProtection !== false,
    electronRender: raw.electronRender !== false,
    internalHostAllowlist: Array.isArray(raw.internalHostAllowlist)
      ? raw.internalHostAllowlist.filter((h: unknown) => typeof h === "string")
      : d.internalHostAllowlist,
  };
}

export async function readWebSearchConfig(): Promise<WebSearchConfig> {
  try {
    const raw = await readFile(configPath(), "utf-8");
    return normalize(JSON.parse(raw));
  } catch {
    return defaultConfig();
  }
}

/**
 * Synchronous read for the tool `execute()` path, which must re-read on every
 * call so settings changes take effect without a session reload.
 */
export function readWebSearchConfigSync(): WebSearchConfig {
  try {
    return normalize(JSON.parse(readFileSync(configPath(), "utf-8")));
  } catch {
    return defaultConfig();
  }
}

export async function writeWebSearchConfig(config: WebSearchConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), "utf-8");
}

function configPath(): string {
  return join(getAgentDir(), WEBSEARCH_CONFIG_FILE);
}

/**
 * Providers with a usable key, in canonical order. Drives both the fallback
 * chain and the tool-registration gate (no usable provider ⇒ no tool).
 */
export function usableSearchProviders(
  config: WebSearchConfig,
): SearchProviderId[] {
  return SEARCH_PROVIDER_ORDER.filter(
    (id) => config.searchProviders[id]?.enabled && config.searchProviders[id]?.apiKey?.trim(),
  );
}

// Re-export shared types/constants so sibling modules can import them from this
// single root instead of reaching into ./types. Without these, `index.ts` and
// `ipc-handlers.ts` (which import WebSearchConfig / SEARCH_PROVIDER_ORDER /
// FetchProviderId from here) fail to resolve, which cascades into a broken
// main-process build.
export type { SearchProviderId, FetchProviderId, WebSearchConfig } from "./types";
export { SEARCH_PROVIDER_ORDER, FETCH_PROVIDER_ORDER } from "./types";
