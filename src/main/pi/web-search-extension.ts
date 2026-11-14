/**
 * Pi inline extension: registers `web_search` and `web_fetch` tools.
 *
 * Design constraints honored (see docs/web-search-integration.md §6, cache):
 *  - Tools are registered via `pi.registerTool()` from the extension factory, so
 *    they land in Pi's tool list WITHOUT touching Pi source. The `promptSnippet`
 *    goes into the static system prompt section, which Pi rebuilds only when the
 *    tool set changes — not per turn — so there is zero per-turn cache cost.
 *  - NO `before_agent_start` / `context` rewrite is used: that would mutate the
 *    per-turn prefix and invalidate the prompt cache on every call.
 *  - Gate: when the feature is disabled or no search provider has a key, the
 *    tools are simply not registered (CowAgent's `is_available()` pattern) so
 *    the model never wastes a call on a doomed tool. A runtime guard inside
 *    `execute` still protects against a config change made without a reload.
 *
 * All network/SSRF/normalize/fallback logic lives in ./websearch (Pi-agnostic).
 *
 * 工具定义经 `webSearchToolDefs()` 导出同源复用：subagent 子会话是独立的
 * createAgentSession，拿不到父会话的 inline 扩展 —— runner.ts 按角色白名单把
 * 同一批定义经 `customTools` 注入子会话（门控口径完全一致）。
 */
import { Type } from "typebox";
import {
  defineTool,
  type AgentToolResult,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { readWebSearchConfigSync, usableSearchProviders } from "../websearch/config";
import { search, fetchPage } from "../websearch/index";
import { WebSearchError, type SearchResult } from "../websearch/types";

interface SearchDetails {
  query: string;
  backend: string;
  total: number;
  count: number;
  results: SearchResult[];
}

interface FetchDetails {
  url: string;
  finalUrl?: string;
  backend: string;
  truncated: boolean;
  chars: number;
}

const searchParams = Type.Object(
  {
    query: Type.String({ description: "Search query; describe what you want to find in natural language" }),
    count: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 10, description: "Number of results to return (default 5)" }),
    ),
    freshness: Type.Optional(
      Type.String({
        enum: ["noLimit", "oneDay", "oneWeek", "oneMonth", "oneYear"],
        description: "Time range: noLimit=any, oneDay=last day, oneWeek=last week, oneMonth=last month, oneYear=last year",
      }),
    ),
  },
  { additionalProperties: false },
);

const fetchParams = Type.Object(
  {
    url: Type.String({ description: "URL of the web page to fetch (only http / https)" }),
    max_chars: Type.Optional(
      Type.Integer({
        minimum: 500,
        maximum: 200_000,
        description: "Maximum number of characters of body text to return (default comes from config; the tail is dropped beyond that)",
      }),
    ),
  },
  { additionalProperties: false },
);

function textContent(text: string): TextContentLike[] {
  return [{ type: "text", text }];
}

// Structural alias — avoids importing TextContent from the nested @earendil-works/pi-ai
// package (not hoisted to the project root). `{ type: "text", text }` is contextually
// typed against AgentToolResult["content"] so the literal is accepted.
type TextContentLike = { type: "text"; text: string };

function formatSearch(query: string, backend: string, total: number, results: SearchDetails["results"]): string {
  const head = `Web search results (query="${query}", source: ${backend}, ${total} total, showing ${results.length}):\n`;
  const body = results
    .map((r, i) => {
      const meta = [r.siteName, r.publishedAt].filter(Boolean).join(" · ");
      const metaLine = meta ? `    (${meta})\n` : "";
      return `[${i + 1}] ${r.title}\n    URL: ${r.url}\n${metaLine}    ${r.snippet}\n`;
    })
    .join("\n");
  return `${head}\n${body}\nWhen citing, use the [index](url) form, e.g. [1](${results[0]?.url ?? ""}). Do not invent URLs.`;
}

const webSearchTool = defineTool({
  name: "web_search",
  label: "Web 搜索",
  description:
    "Search the public internet for real-time information; returns a ranked list of results with title, URL, and snippet. " +
    "Use it when training data may be stale: news, docs, library versions, prices, APIs, error messages.",
  promptSnippet:
    "Search the web for real-time information (news, docs, facts); returns ranked results with snippets and URLs.",
  promptGuidelines: [
    // "何时搜索"已在 description（"Use it when training data may be stale…"）。
    "After web_search, call web_fetch on the 1-3 most relevant URLs to read full content before answering; snippets alone may be outdated or inaccurate.",
    "Cite every fact with [n](url) using the result index and URL. Never invent URLs.",
  ],
  parameters: searchParams,
  execute: async (_id, params, signal): Promise<AgentToolResult<SearchDetails>> => {
    const live = readWebSearchConfigSync();
    if (!live.enabled || usableSearchProviders(live).length === 0) {
      throw new WebSearchError("bad_request", false, "Web search is currently disabled or has no provider configured.");
    }
    const outcome = await search(params.query, signal);
    const results = outcome.results;
    return {
      content: textContent(
        formatSearch(outcome.query, outcome.backend, outcome.total ?? results.length, results),
      ),
      details: {
        query: outcome.query,
        backend: outcome.backend,
        total: outcome.total ?? results.length,
        count: results.length,
        results,
      },
    };
  },
});

const webFetchTool = defineTool({
  name: "web_fetch",
  label: "Web 抓取",
  description:
    "Fetch the full text of a web page by URL (converted to markdown) for in-depth reading. A URL is required — get it from web_search results or from the user.",
  promptSnippet: "Fetch the full text (markdown) of a web page by URL for in-depth reading.",
  promptGuidelines: [
    // "读全文/在 web_search 后调用"已在 description 与 web_search 的 guidelines 各声明一次。
    "Fetch 1-3 URLs at most; avoid fetching many pages at once to conserve context.",
  ],
  parameters: fetchParams,
  execute: async (_id, params, signal): Promise<AgentToolResult<FetchDetails>> => {
    const live = readWebSearchConfigSync();
    if (!live.enabled) {
      throw new WebSearchError("bad_request", false, "Web fetch is currently disabled.");
    }
    // Budget is governed solely by the static "抓取最大字符" cap. The
    // model may request fewer chars via max_chars, but never more.
    const budget = Math.min(live.maxFetchChars, params.max_chars ?? Number.MAX_SAFE_INTEGER);
    const page = await fetchPage(params.url, signal, budget);
    return {
      content: textContent(
        `Fetched: ${page.finalUrl ?? page.url} (source ${page.backend})\n\n${page.text}`,
      ),
      details: {
        url: page.url,
        finalUrl: page.finalUrl,
        backend: page.backend,
        truncated: page.truncated,
        chars: page.text.length,
      },
    };
  },
});

/**
 * 按配置门控返回可用 web 工具定义 —— 父会话（inline 扩展注册）与 subagent
 * 子会话（customTools 注入）共用这一份口径：web_search 要「总开关 + 至少一个
 * 有 key 的提供商」，web_fetch 只要总开关（本地兜底解析，不依赖 key）。
 */
export function webSearchToolDefs(): ToolDefinition[] {
  const cfg = readWebSearchConfigSync();
  if (!cfg.enabled) return []; // 总开关关 → 一个都不注册
  const defs: ToolDefinition[] = [];
  if (usableSearchProviders(cfg).length > 0) defs.push(webSearchTool);
  defs.push(webFetchTool);
  return defs;
}

export const webSearchExtension: InlineExtension = {
  name: "web-search",
  factory: (pi) => {
    for (const def of webSearchToolDefs()) pi.registerTool(def);
  },
};
