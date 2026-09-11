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
 */
import { Type } from "typebox";
import {
  defineTool,
  type AgentToolResult,
  type InlineExtension,
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
    query: Type.String({ description: "搜索查询，用自然语言描述你想查找的信息" }),
    count: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 10, description: "返回结果数量（默认 5）" }),
    ),
    freshness: Type.Optional(
      Type.String({
        enum: ["noLimit", "oneDay", "oneWeek", "oneMonth", "oneYear"],
        description: "时间范围：noLimit=不限, oneDay=近一天, oneWeek=近一周, oneMonth=近一月, oneYear=近一年",
      }),
    ),
  },
  { additionalProperties: false },
);

const fetchParams = Type.Object(
  {
    url: Type.String({ description: "要抓取的网页 URL（仅支持 http / https）" }),
    max_chars: Type.Optional(
      Type.Integer({
        minimum: 500,
        maximum: 200_000,
        description: "返回正文的最大字符数（默认由配置决定，超出部分丢弃尾部）",
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
  const head = `Web 搜索结果（query="${query}"，来源：${backend}，共 ${total} 条，展示 ${results.length} 条）：\n`;
  const body = results
    .map((r, i) => {
      const meta = [r.siteName, r.publishedAt].filter(Boolean).join(" · ");
      const metaLine = meta ? `    （${meta}）\n` : "";
      return `[${i + 1}] ${r.title}\n    URL: ${r.url}\n${metaLine}    ${r.snippet}\n`;
    })
    .join("\n");
  return `${head}\n${body}\n引用时请以 [序号](url) 形式标注，例如 [1](${results[0]?.url ?? ""})。不要编造 URL。`;
}

export const webSearchExtension: InlineExtension = {
  name: "web-search",
  factory: (pi) => {
    const cfg = readWebSearchConfigSync();
    if (!cfg.enabled) return; // master switch off → no tools registered at all

    const hasSearch = usableSearchProviders(cfg).length > 0;
    // web_fetch is always available when the feature is on (local fallback exists).
    const hasFetch = true;

    if (hasSearch) {
      pi.registerTool(
        defineTool({
          name: "web_search",
          label: "Web 搜索",
          description:
            "在公开互联网上搜索实时信息，返回带标题、URL 和摘要的排序结果列表。" +
            "用于训练数据可能过时的内容：新闻、文档、库版本、价格、API、报错等。",
          promptSnippet:
            "Search the web for real-time information (news, docs, facts); returns ranked results with snippets and URLs.",
          promptGuidelines: [
            "Use web_search when the answer depends on current or external facts (news, docs, versions, prices, APIs, errors).",
            "After web_search, call web_fetch on the 1-3 most relevant URLs to read full content before answering; snippets alone may be outdated or inaccurate.",
            "Cite every fact with [n](url) using the result index and URL. Never invent URLs.",
          ],
          parameters: searchParams,
          execute: async (_id, params, signal): Promise<AgentToolResult<SearchDetails>> => {
            const live = readWebSearchConfigSync();
            if (!live.enabled || usableSearchProviders(live).length === 0) {
              throw new WebSearchError("bad_request", false, "Web 搜索当前未启用或未配置 provider。");
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
        }),
      );
    }

    if (hasFetch) {
      pi.registerTool(
        defineTool({
          name: "web_fetch",
          label: "Web 抓取",
          description:
            "按 URL 抓取网页全文（转为 markdown 文本）供深入阅读。须先有 URL——来自 web_search 结果或用户直接给出。",
          promptSnippet: "Fetch the full text (markdown) of a web page by URL for in-depth reading.",
          promptGuidelines: [
            "web_fetch reads the FULL page text for a URL — call it after web_search to read the source in depth.",
            "Fetch 1-3 URLs at most; avoid fetching many pages at once to conserve context.",
          ],
          parameters: fetchParams,
          execute: async (
            _id,
            params,
            signal,
          ): Promise<AgentToolResult<FetchDetails>> => {
            const live = readWebSearchConfigSync();
            if (!live.enabled) {
              throw new WebSearchError("bad_request", false, "Web 抓取当前未启用。");
            }
            // Budget is governed solely by the static "抓取最大字符" cap. The
            // model may request fewer chars via max_chars, but never more.
            const budget = Math.min(live.maxFetchChars, params.max_chars ?? Number.MAX_SAFE_INTEGER);
            const page = await fetchPage(params.url, signal, budget);
            return {
              content: textContent(
                `已抓取：${page.finalUrl ?? page.url}（来源 ${page.backend}）\n\n${page.text}`,
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
        }),
      );
    }
  },
};
