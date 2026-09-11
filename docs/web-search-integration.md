# Web 搜索能力集成方案（Web Search）

> 状态：设计稿，未开发。
> **核心原则：不修改 Pi 任何源码。** 本方案 100% 建立在 Pi 官方公开的扩展面上。
>
> 结论先行：Pi **原生没有 web 搜索能力**（内置工具仅 `read/bash/edit/write/grep/find/ls`），
> 但 Pi 提供了**一等公民的扩展机制**——自定义工具注册、20+ 生命周期事件钩子、
> Provider 注入、消息注入。web 搜索可以作为一个**普通扩展**接入，无需 patch、无需 fork。
>
> 本方案 = **注册 `web_search` / `web_fetch` 两个自定义工具（主路径）**
> + **`input` 事件主动检索兜底（弱工具调用模型救星）**
> + **结构化结果 + 引用规范（自然语言反馈）**。

---

## 1. Pi 扩展能力盘点

> 所有结论来自 `node_modules/@earendil-works/pi-coding-agent/docs/`（v0.84.2）与 dist 类型定义。

### 1.1 四类官方扩展接口

| 接口 | 入口 | 能力 | 本方案是否使用 |
|---|---|---|---|
| **Extension 扩展** | `pi.registerTool()` / `pi.on()` / `pi.registerCommand()` 等 | 注册 LLM 可调用工具、订阅生命周期事件、注入消息、改 system prompt | ✅ **主路径** |
| **SDK 层注入** | `createAgentSession({ customTools: [...] })` | 直接注入工具对象（source 标记为 `sdk`） | ⚪ 备选 |
| **事件钩子链** | 20+ 事件，见 1.2 | 拦截输入、改上下文、阻断/改写工具、改写最终消息 | ✅ **兜底路径** |
| **Provider 注入** | `pi.registerProvider()` | 注册/覆盖模型供应商，可拦截请求 | ❌ 不适用（过载） |

扩展的三种加载方式（本项目已验证可行的是第一种）：

```
① extensionFactories 内联注入   ← 项目已在用（soulExtension / rulesExtension）
② additionalExtensionPaths       ← 文件路径，jiti 即时编译 TS
③ 自动发现 ~/.pi/agent/extensions/*.ts  ← 需写盘，不采用
```

### 1.2 关键事件钩子（可拦截点）

按一次请求的时序排列，`★` 为本方案会用到的：

```
用户输入
  ├─★ input                 拦截/改写用户输入，可 { action: "transform" | "handled" }
  ├─★ before_agent_start    ★注入一条 message（缓存安全）；⚠️返回 systemPrompt（缓存杀手）
  ├─ agent_start
  ├─ 每轮 LLM 调用：
  │   ├─ turn_start
  │   ├─  context          深拷贝消息数组，可增删改（⚠️改中间 history = 缓存失效，勿用于注入）
  │   ├─ before_provider_headers / before_provider_request / after_provider_response
  │   ├─ tool_execution_start
  │   ├─★ tool_call        可 { block: true } 阻断，可改 event.input
  │   ├─ tool_execution_update
  │   ├─★ tool_result      可改写 content / details / isError
  │   └─ turn_end
  ├─★ message_end          可 { message } 替换终稿（必须同 role）
  └─ agent_end / agent_settled
```

**关键能力**：`pi.sendMessage()` / `pi.sendUserMessage()` 允许扩展主动向会话注入消息，
并可用 `deliverAs: "steer" | "followUp" | "nextTurn"` 控制投递时机。

### 1.3 Pi 内置工具清单（确认无 web 能力）

`read` `bash` `edit` `write` `grep` `find` `ls` —— 全部为本地文件系统操作，无网络检索。

---

## 2. 桌面端现有集成点（证据）

> 以下行号基于当前 `src/main/pi/session-manager.ts`。

| 关注点 | 位置 | 现状 |
|---|---|---|
| 会话创建 | `:952-961` | `createAgentSessionServices({ cwd, modelRuntime, resourceLoaderOptions })` |
| **扩展注入点** | `:955-958` | `extensionFactories: [soulExtension, rulesExtension]` ← **在此追加** |
| 上下文文件 | `:959` | `agentsFilesOverride: createContextFilesOverride()` |
| Runtime 包装 | `:964-975` | `createAgentSessionRuntime(...)` |
| 定时任务路径 | `:2277-2281` | 复用同一 `services`（扩展自动生效，无需重复注入） |
| **工具白名单** | `:1956-1971` | `applyUnitActiveTools()` 自动把**非内置工具全量并入**白名单 |
| 事件转发 | `:1109-1156` | `session.subscribe()` → `wc.send("pi:event", { sessionPath, cwd, event })` |
| HTTP 客户端先例 | `package-manager.ts:92,133` | 主进程直接用原生 `fetch` |
| 配置先例 | `im/im-config.ts`、`tts/tts-service.ts:17` | 独立 `*-config.json` + `read*/write*` 函数对 |

### 2.1 为什么自定义工具能自动生效

```ts
// session-manager.ts:1962-1969
const allNames = (session as any).getAllTools?.()?.map((t: any) => t.name) ?? [];
const extNames = allNames.filter((n: string) => !ALL_BUILTIN_TOOLS.includes(n));
session.setActiveToolsByName([...builtinTools, ...extNames]);
```

**结论：注册 `web_search` 后无需改任何白名单配置**，它会被自动识别为扩展工具并激活。

⚠️ 但 `saveActiveTools()`（`:1981`）只保留 `ALL_BUILTIN_TOOLS` 内的名字，
所以**不要**把 `web_search` 写进 `settings.json.activeTools`，否则会被过滤掉。

### 2.2 意外收获：IM 网关已预留工具名

```ts
// src/main/im/im-gateway.ts:44-46
web_fetch: "url",
web_search: "query",
```

钉钉卡片进度行的 arg key 映射已为这两个工具名预留。
**沿用 `web_search` / `web_fetch` 命名可让 IM 侧零改动直接显示友好进度文案。**

---

## 3. 注入方案

采用 **A（主）+ B（兜底）+ C（增强）** 三层组合。

### 方案 A：注册自定义工具 —— 主路径

模型自主判断何时搜索、可多轮迭代、可组合（`搜索 → 抓取 → 综合`）。

**注入位置**：`src/main/pi/session-manager.ts:956`

```ts
import { webSearchExtension } from "./web-search-extension";

servicesPromise = createAgentSessionServices({
  cwd,
  modelRuntime: this.modelRuntime!,
  resourceLoaderOptions: {
    extensionFactories: [soulExtension, rulesExtension, webSearchExtension], // ← 追加
    agentsFilesOverride: createContextFilesOverride(),
  },
});
```

**扩展骨架**：新建 `src/main/pi/web-search-extension.ts`

```ts
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { search, fetchPage } from "../websearch";

export const webSearchExtension: InlineExtension = {
  name: "web-search",
  factory: (pi) => {
    // ---- 工具 1：搜索 ----
    pi.registerTool({
      name: "web_search",
      label: "Web Search",
      description:
        "Search the web for up-to-date information. Returns titles, URLs, snippets " +
        "and publish dates. Use when the answer requires information you may not " +
        "know, or when the user asks about recent events.",
      promptSnippet: "Search the web for current information",
      promptGuidelines: [
        "Use web_search when the user asks about recent events, versions, prices, " +
        "or anything that may have changed after your knowledge cutoff.",
        "After web_search, call web_fetch on the most relevant URLs to read full " +
        "content before answering.",
        "Always cite sources with [n](url) markdown links when answering from " +
        "web_search or web_fetch results.",
      ],
      parameters: Type.Object({
        query: Type.String({ description: "Search query, natural language" }),
        count: Type.Optional(Type.Number({ description: "Results to return, 1-10, default 5" })),
        freshness: Type.Optional(
          Type.Union([
            Type.Literal("day"), Type.Literal("week"),
            Type.Literal("month"), Type.Literal("year"),
          ], { description: "Restrict results by recency" }),
        ),
      }),

      async execute(_toolCallId, params, signal, onUpdate, _ctx) {
        onUpdate?.({ content: [{ type: "text", text: `Searching: ${params.query}` }] });

        const results = await search({
          query: params.query,
          count: Math.min(Math.max(params.count ?? 5, 1), 10),
          freshness: params.freshness,
          signal,                       // ← 用户按 Esc 可中断
        });

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `No results for "${params.query}". Try a different query.` }],
            details: { query: params.query, count: 0 },
          };
        }

        return {
          content: [{ type: "text", text: formatResults(results) }],
          details: { query: params.query, results },   // details 供渲染/状态重建
        };
      },
    });

    // ---- 工具 2：抓正文 ----
    pi.registerTool({
      name: "web_fetch",
      label: "Web Fetch",
      description:
        "Fetch a web page and return its main content as markdown. Use after " +
        "web_search to read the full text of a promising result.",
      parameters: Type.Object({
        url: Type.String({ description: "Absolute http(s) URL" }),
        maxChars: Type.Optional(Type.Number({ description: "Truncate to N chars, default 12000" })),
      }),
      async execute(_toolCallId, params, signal) {
        const page = await fetchPage({
          url: params.url,
          maxChars: params.maxChars ?? 12000,
          signal,
        });
        return {
          content: [{ type: "text", text: page.text }],
          details: { url: params.url, title: page.title, truncated: page.truncated },
        };
      },
    });
  },
};
```

**结果格式化**（给 LLM 看的纯文本，同时便于模型抽取引用）：

```ts
function formatResults(results: SearchResult[]): string {
  const lines = [`Found ${results.length} results:`, ""];
  results.forEach((r, i) => {
    lines.push(`[${i + 1}] ${r.title}`);
    lines.push(`    URL: ${r.url}`);
    if (r.publishedAt) lines.push(`    Date: ${r.publishedAt}`);
    lines.push(`    ${r.snippet.replace(/\s+/g, " ").trim()}`);
    lines.push("");
  });
  lines.push(
    "Instructions: answer the user's question using these results.",
    "Cite each claim with [n](url). If results are insufficient, say so plainly",
    "instead of filling gaps from memory.",
  );
  return lines.join("\n");
}
```

> 注意：`execute` 里**抛异常**才会置 `isError: true`；返回值里带 `isError` 字段无效。

### 方案 B：`input` 事件主动检索 —— 弱工具调用模型兜底

项目接入了 `qwen3.5-4b` / `gemma` 等小模型，function calling 稳定性不足。
提供**不依赖工具调用**的检索路径：用户消息进来时先判定是否需要联网，
主动搜一次，把结果作为上下文塞进 `before_agent_start`，模型只负责"读材料作答"。

```ts
pi.on("input", async (event, ctx) => {
  if (event.source === "extension") return { action: "continue" };
  if (ctx.mode === "print") return { action: "continue" };

  const decision = await shouldSearch(event.text);   // 见 4.4 判定器
  if (!decision.need) return { action: "continue" };

  // 异步检索：不阻塞输入框，结果就绪后注入
  void search({ query: decision.query, count: 5, signal: ctx.signal })
    .then((results) => {
      if (results.length === 0) return;
      // 连 query 一起暂存：before_agent_start handler 拿不到此处的 decision 闭包
      pendingContext = { query: decision.query, text: formatResults(results) };
    })
    .catch(() => { pendingContext = null });
  return { action: "continue" };
});

pi.on("before_agent_start", (event) => {
  if (!pendingContext) return;
  const { query, text } = pendingContext;
  pendingContext = null;                              // 一次性消费

  // ⚠️ 严禁在此返回 systemPrompt。
  //    系统提示词位于请求最前，每轮搜索结果不同 ⇒ 其后整段 history 的 KV 全部重算，
  //    缓存命中率归零。只返回 message：它被 push 到消息数组末尾
  //    （agent-session.js:886，在 userContent 之后），其前所有内容仍是未变前缀
  //    ⇒ 缓存满命中。grounding 规则因此必须随 message 下发，而非塞进 system prompt。
  return {
    message: {
      customType: "web-search-context",
      content:
        `<web_search_results query="${escapeAttr(query)}">\n${text}\n</web_search_results>\n` +
        WEB_GROUNDING_RULES,
      display: true,
    },
  };
});
```

> **为什么原稿写 `systemPrompt` 是错的**：`before_agent_start` 的 systemPrompt 覆盖是**逐轮**
> 生效的（agent-session.js:901-908 每轮写入，:753 在 `finally` 里重置）。内容静态时无害
> （项目现有 `rulesExtension` 即如此，rules.md 不变则前缀不变）；但搜索结果**每轮都不同**，
> 逐轮改前缀头 ⇒ 每轮让整段对话历史重算。

**A/B 互斥**：设置项 `websearch.mode = "tool" | "inject" | "off"`。
`"tool"` 只注册工具；`"inject"` 只走 B（并把 `web_search` 从 active tools 移除）；
`"off"` 整个扩展不注入。默认按模型能力自动选择（见 4.4）。

### 方案 C：`tool_result` 后处理 —— 上下文预算控制（增强）

搜索结果直接进上下文会快速撑爆窗口（项目跑小模型，上下文更紧张）。
在 `tool_result` 里做统一裁剪：

```ts
pi.on("tool_result", async (event) => {
  if (event.toolName !== "web_search" && event.toolName !== "web_fetch") return;

  const budget = await getContextBudget();        // 按模型 contextWindow 动态算
  const text = extractText(event.content);
  if (Buffer.byteLength(text, "utf-8") <= budget) return;

  return {
    content: [{ type: "text", text: truncate(text, budget) + "\n[truncated to fit context budget]" }],
    details: { ...event.details, truncated: true },
  };
});
```

---

## 4. Web 搜索 API 接入

### 4.1 Provider 抽象层

新建 `src/main/websearch/`（对齐 `im/` `tts/` 的模块约定）。

```
src/main/websearch/
├── types.ts               # SearchResult / SearchOptions / Provider 接口
├── config.ts              # ~/.pi/agent/websearch-config.json 读写
├── providers/
│   ├── bocha.ts           # 博查（默认）：国内连通好，中文实时质量最佳（见 9.5）
│   ├── qianfan.ts         # 百度千帆：热点新闻强
│   ├── zhipu.ts           # 智谱：长文强
│   ├── tavily.ts          # 专为 LLM 设计，直接返回去重正文（海外场景）
│   ├── brave.ts           # Brave Search API
│   ├── searxng.ts         # 自建实例，免费无 key，隐私友好
│   └── jina-reader.ts     # r.jina.ai，URL → markdown 正文抓取
├── url-safety.ts          # SSRF 防护 + 重定向逐跳校验（见 9.2-8）
├── index.ts               # search() / fetchPage() 统一入口 + 降级链
├── cache.ts               # fetch 结果 LRU 去重（见 9.4-2）
└── budget.ts              # 上下文预算计算
```

> Provider 排序依据 CowAgent 实测注释（`web_search.py:37-40`）：中文实时质量 +
> 相关性综合，bocha > qianfan > zhipu > linkai。

```ts
// types.ts
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  score?: number;
}

export interface SearchProvider {
  id: string;
  label: string;
  requiresApiKey: boolean;
  search(opts: SearchOptions): Promise<SearchResult[]>;
}

export interface SearchOptions {
  query: string;
  count?: number;
  /** 归一化时间过滤词汇，各 provider 内部翻译（见 9.2-6） */
  freshness?: "noLimit" | "oneDay" | "oneWeek" | "oneMonth" | "oneYear";
  signal?: AbortSignal;
}
```

### 4.2 配置项

`~/.pi/agent/websearch-config.json`

```json
{
  "enabled": true,
  "mode": "auto",
  "provider": "bocha",
  "apiKey": "",
  "endpoint": "",
  "resultCount": 5,
  "timeoutMs": 15000,
  "freshness": "noLimit",
  "safeSearch": true,
  "domainAllowlist": [],
  "domainBlocklist": [],
  "fetchEnabled": true,
  "maxFetchChars": 12000,
  "contextBudgetRatio": 0.08,
  "ssrfProtection": true,
  "internalHostAllowlist": ["localhost", "127.0.0.1"]
}
```

> `ssrfProtection` 默认 **true**（与 CowAgent 相反——它没有本地 dev server 约束，
> 而我们要防网页内容提示词注入诱导的内网探测，见 9.3-2）。
> 确实需要抓本地服务时，把 host 加进 `internalHostAllowlist` 而非全局关闭。

读写函数沿用现有约定：

```ts
// config.ts
export function readWebSearchConfig(): WebSearchConfig { /* 同 im-config.ts 模式 */ }
export async function writeWebSearchConfig(c: WebSearchConfig): Promise<void> { ... }
```

> API key 明文落 `~/.pi/agent/`（与 `auth.json` / `im-config.json` 同盘同权限）。
> 若未来要求更高，可改用 Electron `safeStorage` 加密，但会与"配置可手工编辑"冲突，暂不做。

### 4.3 统一入口与降级链

```ts
// index.ts
export async function search(opts: SearchOptions): Promise<SearchResult[]> {
  const cfg = readWebSearchConfig();
  if (!cfg.enabled) throw new Error("Web search is disabled");

  const chain = [cfg.provider, ...FALLBACK_PROVIDERS];   // 主 provider 失败自动降级
  const errors: string[] = [];

  for (const id of chain) {
    const provider = PROVIDERS[id];
    if (!provider || (provider.requiresApiKey && !cfg.apiKey && id !== "searxng")) continue;
    try {
      const results = await withTimeout(
        provider.search({ ...opts, cfg }),
        cfg.timeoutMs,
        opts.signal,
      );
      return applyDomainFilters(results, cfg).slice(0, opts.count ?? cfg.resultCount);
    } catch (e: any) {
      if (e.name === "AbortError") throw e;             // 用户取消不降级，直接上抛
      // 任何失败都换下一家继续：每个 provider 是独立账号，单家
      // key 失效 / 配额耗尽 / 5xx 不代表其他家不可用，多试一家往往能成。
      errors.push(`${id}: ${e.message ?? e}`);
    }
  }
  throw new Error(`All search providers failed — ${errors.join("; ")}`);
}
```

**错误分类**（借鉴 CowAgent `web_search.py:268-275`，避免"换家重试"撞上不可恢复错误）：

```ts
// types.ts
export type SearchErrorKind = "auth" | "quota" | "rate_limit" | "timeout" | "network" | "bad_request";

export class SearchError extends Error {
  constructor(
    readonly kind: SearchErrorKind,
    /**
     * retryable 仅用于日志/可观测区分（限流/超时/网络 vs 凭据/配额），
     * 不再决定降级与否——所有非用户取消的错误都会继续尝试下一家 provider，
     * 因为各家是独立账号。
     */
    readonly retryable: boolean,
    message: string,
  ) { super(message); }
}
```

| HTTP | kind | retryable | 给模型的文案要点 |
|---|---|---|---|
| 401 | `auth` | ❌ | key 无效，请用户去设置页更新 |
| 403 | `quota` | ❌ | 余额不足（博查常见）+ 充值链接 |
| 402 | `quota` | ❌ | 配额耗尽 |
| 429 | `rate_limit` | ✅ | 换下一家 provider |
| 超时 | `timeout` | ✅ | 换下一家 |
| 连接失败 | `network` | ✅ | 换下一家 |

**关键设计**：
- `signal` 贯穿 `fetch`（用户按 Esc 立即中断，对齐 `ctx.signal` 语义）
- 超时用 `AbortSignal.timeout()` + 显式 `AbortController`，不被 provider 内部吞掉
- 失败**抛异常**而非返回空数组——让 LLM 明确知道搜索失败，可以换查询词重试，
  而不是误以为"网上没有这个信息"
- 路由决策必打日志（`provider / reason / available / query`），多 provider 排障唯一依据

### 4.4 是否需要联网：判定器

B 方案的核心。三级判定，从廉到贵：

```ts
async function shouldSearch(text: string): Promise<{ need: boolean; query: string }> {
  // ① 显式触发：用户带关键词
  if (/^(搜|搜索|查一下|查查|联网|网上)/.test(text.trim())) {
    return { need: true, query: stripTrigger(text) };
  }
  // ② 规则命中：时效性信号词 + 疑问句
  if (TIME_SENSITIVE_RE.test(text) && text.length > 8) {
    return { need: true, query: text };
  }
  // ③ 兜底：不猜。交给模型自己调工具（A 方案），避免误触发成本
  return { need: false, query: text };
}
const TIME_SENSITIVE_RE =
  /(最新|最近|今年|今天|昨天|本周|本月|现在|当前|多少钱|价格|版本|什么时候|如何安装|报错|怎么解决)/;
```

**A/B 自动选择**（`mode: "auto"` 时）：

| 判据 | 选择 |
|---|---|
| 模型 `input` 含 `tool` 能力且上下文 ≥ 16K | A（工具） |
| 小模型 / 本地模型 / 未声明工具能力 | B（注入） |
| 用户手动指定 | 用户优先 |

### 4.5 结果如何变成自然语言

**不做二次 LLM 摘要**（省一次 API 调用、省延迟、避免摘要幻觉），
而是把结构化结果 + 引用规范交给主模型一次成文：

1. 工具返回 `[n] title / URL / Date / snippet` 的紧凑文本
2. `promptGuidelines` 注入引用规范（见方案 A 代码）
3. `before_agent_start`（B 方案）追加 `<web_search_results>` 包裹块 +  grounding 规则
4. 主模型生成带 `[n](url)` 链接的自然语言回答

渲染层无需改动：`message_update` 的 `text_delta` 已逐字转发到 UI，
markdown 链接由现有渲染器处理。

---

## 5. 桌面端接线清单

| # | 改动 | 文件 | 说明 |
|---|---|---|---|
| 1 | 新建搜索模块 | `src/main/websearch/*` | Provider 抽象 + 配置 + 降级链 |
| 2 | 新建扩展 | `src/main/pi/web-search-extension.ts` | `webSearchExtension: InlineExtension` |
| 3 | **注入扩展** | `src/main/pi/session-manager.ts:956` | `extensionFactories` 追加一项 |
| 4 | 配置失效 | 同文件 | 配置变更时 `servicesByCwd.clear()` |
| 5 | IPC 通道 | `src/main/ipc-handlers.ts` + `src/shared/ipc-types.ts` | `pi:getWebSearchConfig` / `pi:saveWebSearchConfig` / `pi:testWebSearch` |
| 6 | preload 暴露 | `src/preload/index.ts` | 对齐 `im-config` 写法 |
| 7 | 设置页 UI | `src/renderer/pages/settings/` | 开关 + provider 选择 + key + 测试按钮 |
| 8 | 工具卡片（可选） | 渲染层 tool 渲染分支 | 搜索结果显示为来源列表 |

**不需要改动**：工具白名单（自动并入）、事件转发（复用 `pi:event`）、
IM 卡片（`im-gateway.ts:44-46` 已预留 `web_search`/`web_fetch`）。

**定时任务**：`:2277` 复用同一 `services`，扩展自动生效，无需额外注入。

---

## 6. 缓存命中率影响评估（关键约束）

LLM 前缀缓存的命中条件是：**请求 token 序列与上一次请求共享最长公共前缀**。
所以"改在哪"远比"改多少"重要——落在前缀**中间**的改动，会让它**之后的所有内容**全部失效。

Pi 单次请求的结构（`agent-session.js:875-915`）：

```
[system prompt]                      ← 前缀头，最敏感
[history messages ...]               ← 最长的一段，缓存收益主要在这里
[new user message]
[before_agent_start 注入的 message]   ← 尾部，改动零代价
```

### 6.1 四种注入方式的分级结论

| 注入方式 | 落在哪 | 缓存影响 | 结论 |
|---|---|---|---|
| **A：`registerTool` + `promptSnippet`/`promptGuidelines`** | system prompt 内 | 仅会话首次冷启动一次 | ✅ 放心做 |
| **B-正确：`before_agent_start` → `message`** | 消息数组末尾 | **零影响** | ✅ 放心做 |
| **B-错误：`before_agent_start` → `systemPrompt`** | 前缀头 | 每轮 history 全量重算 | ❌ 禁止 |
| **`context` 事件注入 / 过滤** | 中间 history | 自改动点起全部失效，且每轮触发 | ❌ 已撤回 |

### 6.2 方案 A 为什么几乎免费

`_rebuildSystemPrompt(toolNames)` 只在**工具集变化时**调用（`agent-session.js:643`、`:1778`），
不是每轮重建。新增两个工具后系统提示词只多出 200-400 token（一行 toolSnippet + 若干
promptGuidelines + JSON Schema），付一次冷启动代价后，整个会话内前缀恒定 ⇒ 持续满命中。

### 6.3 两个外部约束（与本方案无关，但解读数据时必须先排除）

1. **Pi 不主动下发 `cache_control` 断点**：`dist/` 内 grep 不到 `cache_control`
   （仅 `model-config.js:85` 有 `cacheControlFormat: "anthropic"` 配置项）
   ⇒ 缓存完全依赖服务端自动前缀匹配。
2. **TTL 是硬约束**：`CACHE_TTL_MS`（`dist/core/cache-stats.d.ts`）按 Anthropic 默认 5 分钟计，
   空闲超时照样失效。测本方案影响时必须保证两次请求间隔 < TTL，否则测到的是 TTL 失效。

### 6.4 真正的隐藏成本：压缩被提前触发

`shouldCompact()` 判据为 `contextTokens > contextWindow - reserveTokens`
（`compaction.js:160-164`，`reserveTokens` 默认 16384，见 `settings-manager.js:518`）。

一次 `web_search` 回 5 条摘要 ≈ 2-4K token，一次 `web_fetch` 整页 ≈ 8-12K token。
项目主跑 `qwen3.5-4b` / `gemma` 这类小上下文模型，注入 3-4 次即可顶到阈值。

> **压缩 = 历史整体被摘要重写 = 缓存 100% 归零 + 一次额外摘要 LLM 调用。**

这项开销远大于 6.1 中任何一项，是本方案唯一需要认真对待的缓存成本。

缓解（已同步调整排期，见第 8 节）：

- 方案 C（`tool_result` 预算裁剪）**从 P5 提前到 P1**，与工具同期上线，不要等膨胀后再补。
- 裁剪时直接丢弃尾部，**不要保留"[已截断]"占位说明**——占位文本本身也计入上下文。
- 进阶（可选）：仅当上下文逼近压缩阈值时，才在 `context` 事件里把**较早的**搜索结果
  降级为 `标题 + URL` 一行、丢弃摘要正文。此举改中间 history、损失一次缓存命中，
  但换来的上下文空间可推迟压缩——**推迟一次压缩的收益远大于一次未命中**，净收益为正。
  **必须条件触发，不可每轮执行。**

### 6.5 可观测性：Pi 自带缓存未命中检测（可直接做 A/B）

`dist/core/cache-stats.d.ts` 已暴露完整统计能力：

| 导出 | 用途 |
|---|---|
| `detectCacheMiss(entries, message, models)` | 检测刚完成的 assistant 消息是否未命中 |
| `collectCacheMisses(entries, models)` | 汇总整个会话的未命中，按 assistant 消息索引 |
| `computeCacheWaste(entries, models)` | 累计 `missedTokens` / `missedCost` / `missCount` |
| `CacheMiss` | 含 `missedTokens`、`missedCost`、`idleMs`、`modelChanged` |

- **上线前后跑同一组对话脚本对比 `computeCacheWaste()`**，用真实数字回答
  "有没有破坏命中率"，无需靠推理。
- `modelChanged` 字段说明**切模型也会计为未命中**——A/B 时必须固定模型，否则数据被污染。
- `idleMs` 用于识别 TTL 超时导致的失效，应与真实未命中区分。

**验收补充项**：总开关 `off` 与 `on` 两态下，同一脚本的 `missedTokens` 增量应停留在
"会话首次冷启动"量级（数百 token），**不随轮次线性增长**。
若观察到线性增长，说明有代码在逐轮改前缀头，回到 6.1 排查。

---

## 7. 技术风险与回退

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | **小模型工具调用不稳定** | 模型不调 / 参数错 | B 方案兜底；`prepareArguments()` 兼容旧字段名；`promptGuidelines` 显式指明工具名 |
| R2 | **上下文膨胀** | 撑爆窗口触发 compaction | `tool_result` 按 8% 上下文预算裁剪；`web_fetch` 默认截断 12K 字符 |
| R3 | **主进程阻塞** | UI 卡死 | 全链路 async + `signal`；`ensureUnit` 已 single-flight，扩展不引入同步 I/O |
| R4 | **Provider 限流/不可用** | 搜索失败 | 多 provider 降级链；超时 15s；失败抛错让模型换词重试 |
| R5 | **扩展热更新** | 改配置不生效 | 配置在 `execute` 内实时读取（不放闭包缓存）；`switch` provider 时 `servicesByCwd.clear()` |
| R6 | **白名单被覆盖** | 工具消失 | 不写入 `settings.json.activeTools`（会被 `saveActiveTools` 过滤） |
| R7 | **提示词膨胀** | `promptGuidelines` 挤占 | 控制在 3 条以内，且每条必须点名工具（Pi 文档明确要求） |
| R8 | **隐私外泄** | 本地代码片段被发到搜索引擎 | 仅在 B 方案用 query 检索（不含文件内容）；提供域名黑名单 + 总开关 |
| R9 | **Pi 版本升级破坏扩展 API** | 功能失效 | 锁 `@earendil-works/pi-coding-agent` 精确版本；扩展工厂整体 try/catch，失败只降级本功能 |
| R10 | **缓存命中率被破坏** | 每轮重算 history，成本与延迟上升 | 禁止在 `before_agent_start` 返回 `systemPrompt`；禁止用 `context` 事件注入；只走尾部 `message` 注入（见第 6 节） |
| R11 | **压缩被提前触发** | 缓存归零 + 额外摘要调用（比 R10 更贵） | `tool_result` 预算裁剪提前到 P1；接近阈值时才做历史结果降级（见 6.4） |
| R12 | **SSRF：网页内容提示词注入，诱导 fetch 内网地址** | 探测内网 / 读云元数据（`169.254.169.254`） | `url-safety.ts` 默认开启；`redirect: "manual"` 逐跳重校验；内网访问走显式 host 白名单而非全局关闭（见 9.2-8、9.3-2） |
| R13 | **网页正文不截断**（CowAgent 同款漏洞） | 单次 8-12K token 灌入，小模型窗口直接顶满 | `web_fetch` 抽完正文立即按 `maxFetchChars` 截断，**文档与网页两条分支都要截**（见 9.3-1） |
| R14 | **同 URL 重复 fetch** | 重复占上下文，与 R11 叠加 | `cache.ts` LRU 去重（见 9.4-2） |

**降级链路（逐级后退，任何一级失败都自动后退）**：

```
总开关 off          → 扩展不注入，行为与今天完全一致
  ↓ 开
provider 全部失败   → 抛错，模型看到"搜索失败"，自行改用已有知识作答（并说明未联网）
  ↓
上下文超预算        → 截断，标注 [truncated]
  ↓
扩展加载异常        → try/catch 吞掉，日志告警，Pi 其余功能不受影响
```

**验收清单**：
- [ ] `pi:getActiveTools` 返回列表含 `web_search` / `web_fetch`
- [ ] 关闭总开关后两者消失，且 Pi 原有功能无任何变化
- [ ] 搜索中按 Esc 能中断，不留悬挂 Promise
- [ ] 断网时模型收到明确错误而非空结果
- [ ] 定时任务会话可用搜索
- [ ] 钉钉 IM 侧进度行显示 `web_search <query>`
- [ ] `npx tsc -p tsconfig.node.json --noEmit` 通过
- [ ] 缓存对照：总开关 off/on 两态下同一脚本的 `missedTokens` 无线性增长（6.5）

---

## 8. 落地顺序

| 阶段 | 内容 | 依赖 |
|---|---|---|
| P0 | `types.ts` + `config.ts` + `bocha.ts` + `index.ts` + `url-safety.ts` | 无 |
| P1 | `web-search-extension.ts`（仅 A 方案）+ 注入 `:956` | P0 |
| P1 | `tool_result` 上下文预算裁剪 ⚠️**从 P5 提前**：防压缩提前触发（6.4） | P1 |
| P1 | `web_fetch` 正文截断 ⚠️**易漏**：CowAgent 就漏了（9.3-1），不可只截文档 | P1 |
| P1 | `cache.ts` fetch LRU 去重（9.4-2），防重复占上下文 | P1 |
| P2 | 设置页 UI + IPC + preload | P0 |
| P3 | B 方案兜底（`input` + `before_agent_start` **只返回 message**）+ 自动模式选择 | P1 |
| P4 | `qianfan` / `zhipu` / `tavily` / `searxng` 适配器 + 降级链 + 错误分类 | P1 |
| P5 | 缓存 A/B 验证：接 `computeCacheWaste()` 出对照数据（6.5） | P1、P2 |

> `url-safety.ts` 放 P0 而非 P4——SSRF 防护是**安全基线**，事后补等于先裸奔。
> 无 key 时不注册工具的门控（9.2-2）随 P1 扩展一起做。

**P1 完成后即可端到端可用**，P3 起均为增强。
**裁剪（原 P5）必须与 P1 同期上线**——等上下文膨胀后再补，压缩早已被触发。

---

## 9. 参考实现调研：CowAgent 的 `web_search` / `web_fetch`

调研对象：`参考项目/CowAgent/CowAgent/agent/tools/{web_search,web_fetch}/`。
这是一套已在生产跑的多 provider 搜索实现，可直接复用其**接口设计**，但有三处与其架构绑定的决策不可照搬。

### 9.1 它怎么做的

**`web_search`**（`web_search/web_search.py`）——5 个 backend 归一到同一输出形状：

| Provider | 端点 | 备注 |
|---|---|---|
| `bocha` | `api.bochaai.com/v1/web-search` | 排序第一 |
| `qianfan` | `qianfan.baidubce.com/v2/ai_search/web_search` | 百度 AI 搜索 |
| `zhipu` | `open.bigmodel.cn/api/paas/v4/web_search` | |
| `linkai` | `api.link-ai.tech/v1/plugin/execute` | 聚合兜底 |
| `anysearch` | `api.anysearch.com/v1/search` | 支持匿名额度 |

无论哪个 backend，都归一成 `{title, url, snippet, siteName, datePublished}`，外层包 `{query, backend, total, count, results}`。

**`web_fetch`**（`web_fetch/web_fetch.py`）——按 URL 后缀分流：HTML 走"抽正文"，`.pdf/.docx/.xlsx/.pptx/.md/.csv` 走"下载 + 解析"。

### 9.2 值得直接借鉴的 8 点

1. **多 provider 单一归一化 schema**
   每个 provider 的字段名都不一样（博查叫 `name/snippet/datePublished`，智谱叫 `title/content/publish_date`/`link`，千帆在 `references[]` 且 `content` 要截 200 字）。统一在一处转换，上层零适配。

2. **`is_available()` 门控**（`web_search.py:130`）
   ```python
   @staticmethod
   def is_available() -> bool:
       return bool(configured_providers())   # 无任何 key → 工具不注册
   ```
   **这比"注册了但执行时报错"好得多**：模型看不见工具就不会调，也就不会产生一次注定失败的往返。对应到 Pi：无 key 时不调 `registerTool`。

3. **`get_json_schema()` 动态裁剪**（`:135-156`）
   只有**已配置 provider ≥2 且 strategy=auto** 时，才往 schema 里加 `provider` 枚举字段。
   ```python
   if len(available) < 2:
       return schema      # 单 provider：不暴露 provider 字段，省 token
   ```
   这点与第 6 节的缓存结论直接呼应：**schema 越小越稳定，冷启动成本越低**。

4. **错误按状态码分类，且给可行动信息**（`:268-275`）
   ```python
   if resp.status_code == 403:
       return ToolResult.fail("Error: bocha API — insufficient balance. Top up at https://open.bochaai.com")
   ```
   401 / 403（余额）/ 429（限流）/ 402（配额）分开，模型能据此决定"换 provider"还是"告诉用户去充值"。**我们 4.3 节现在只抛 `All search providers failed`，太粗，需补。**

5. **路由决策必打日志**（`:226-229`）
   ```python
   logger.info(f"[WebSearch] provider={provider} reason={reason} available={list(available)} query={q_preview!r} ...")
   ```
   `reason` ∈ `caller-requested` / `fixed-strategy` / `auto-fallback`。多 provider 出问题时，没有这行日志根本无法复盘。

6. **`freshness` 词汇归一化**（`:39-45`、`:421-432`）
   统一 `noLimit|oneDay|oneWeek|oneMonth|oneYear`，各 provider 内部翻译——智谱映射 `search_recency_filter`，千帆要换算成 `{"range":{"page_time":{"gte","lt"}}}` 日期区间。**这是真实的坑：各家 API 的时间过滤字段名完全不同**，不归一化的话每加一个 provider 就要改一次工具 schema。

7. **入参 clamp 而非报错**（`:317`、`:506`）
   智谱 query 上限 70 字符 → 静默截断；anysearch 上限 20 条而 schema 声明 1-50 → `min(count, 20)`。模型给越界参数不该失败。

8. **SSRF 防护 + 重定向逐跳重校验**（`web_fetch.py:129-164`）
   ```python
   response = requests.get(current, allow_redirects=False, ...)  # 关掉自动重定向
   ...
   current = requests.compat.urljoin(current, location)
   validate_url_safe(current)     # 每一跳都重新校验
   ```
   **这是真安全洞**：开着自动重定向，一个公网 URL 能 302 弹进 `127.0.0.1` 或 `169.254.169.254`（云元数据）。**我们方案目前完全没有这一项，必须补。**

### 9.3 不可照搬的 3 点（与其架构绑定）

| # | CowAgent 的做法 | 为什么我们不能照搬 |
|---|---|---|
| 1 | `_fetch_webpage()` **不对正文截断**，只有文档走 `truncate_head()`（`web_fetch.py:194`） | 他们后端是大上下文模型。我们有 qwen3.5-4b，一页正文 8-12K token 直接灌进去 → 6.4 节的压缩提前触发。这正是"容易漏的截断"，印证 P1 必须与工具同期上线 |
| 2 | SSRF **默认关闭**（`url_safety.py:26`，`web_security_ssrf_protection: false`） | 他们要访问本地 dev server / LAN 服务。桌面端 Pi 有真实的内网探测风险（网页内容可提示词注入诱导 fetch 内网地址），**我们应默认开启 + 提供内网白名单** |
| 3 | 文档下载落 `cwd/tmp` 且**成功后不清理**（`web_fetch.py:205`） | 会污染用户工作区并累积垃圾。我们应落 `~/.pi/agent/tmp/`，用完即删 |

其余差异属语言/框架层面，实现时注意即可：`requests`（同步）→ `fetch` + `AbortSignal`；手动跟随重定向在 Node 里是 `redirect: "manual"` + 自循环；Pi 的 `execute` 是 async。

### 9.4 它没做、我们需要补的 2 点

1. **引用规范注入**。它返回的只是结构化 dict，没有任何"如何引用"的指令。我们的 `promptGuidelines` 要求 `[n](url)`，这一点要保留。
2. **同 URL 去重 / LRU 缓存**。它每次 `web_fetch` 都重新请求。同一轮对话里模型对同一 URL 连抓两次，会**重复占上下文**——这正是压缩提前触发的诱因之一。加一层 `Map<url, {text, at}>` 即可。

### 9.5 对本文档的修订结论

| 项 | 原方案 | 修订 |
|---|---|---|
| 默认 provider | `tavily` | **改 `bocha`**。CowAgent 实测排序 bocha > qianfan > zhipu；且 Tavily 端点在国内连通性存疑，本项目有国内 IM 场景 |
| `freshness` 参数 | 无 | **新增**，词汇沿用 `noLimit/oneDay/oneWeek/oneMonth/oneYear`，各 provider 内部翻译（9.2-6） |
| 工具注册条件 | 无条件注册 | **无 key 时不注册**（9.2-2） |
| 错误返回 | 统一 `All providers failed` | **按 401/403/429/402 分类**（9.2-4） |
| SSRF | 缺失 | **新增**，默认开启 + 内网白名单 + 重定向逐跳校验（9.2-8） |
| fetch 去重 | 缺失 | **新增 LRU**（9.4-2） |
| 落盘位置 | 未定义 | `~/.pi/agent/tmp/`，用完即删 |

---

## 附：为什么不需要改 Pi 代码

| 需求 | Pi 官方做法 | 是否需改源码 |
|---|---|---|
| 让 LLM 能调用新能力 | `pi.registerTool()` | 否 |
| 让工具出现在系统提示词 | `promptSnippet` + `promptGuidelines` | 否 |
| 让工具进入启用列表 | `setActiveToolsByName()`（本项目已自动处理） | 否 |
| 改写用户输入 | `input` 事件 `transform` | 否 |
| 注入上下文/改提示词 | `before_agent_start` / `context` | 否 |
| 改写工具结果 | `tool_result` 事件 | 否 |
| 渲染自定义结果 | `renderCall` / `renderResult` | 否 |
| 感知中断 | `ctx.signal` / `execute` 的 `signal` 参数 | 否 |

Pi 把扩展当作**一等公民**设计，扩展 API 覆盖到工具注册、事件拦截、
消息注入、UI 渲染四个层面。本方案没有一处需要 patch、fork 或 monkey-patch。
