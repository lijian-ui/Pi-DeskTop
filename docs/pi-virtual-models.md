# Pi 虚拟模型与自动模型路由（Virtual Models & Auto Model Routing）

> 状态：**未开发**（仅调研记录，2026-10-02）。SDK 侧能力已确认存在于 `pi-coding-agent@1.0.0`，桌面端**尚未接入**。
> 主题：Pi 的「虚拟模型」机制——把一个"可被选中的模型"在**每次请求前**路由到不同的物理模型；以及它与两层重试机制配合，实现"重试失败后自动换模型继续干活"。
> 适用：日后想给桌面端加「自动降级 / 按任务路由 / 成本优化 / 过载自动切换」时，先读这篇再决定做不做。

---

## 1. 结论速览

| 能力 | SDK 是否支持 | 桌面端现状 |
|---|---|---|
| 虚拟模型（选中后按请求路由到物理模型） | ✅ 有，标记 experimental | ❌ 未接入 |
| 429 / 5xx / 网络错误自动重试 | ✅ 默认开启（3 次退避） | ✅ 已生效，UI 有"重试中"状态 |
| 重试耗尽后**自动换模型**再试 | ⚠️ 无内置，但虚拟模型的 `route()` 就是官方给的钩子 | ❌ 未接入 |
| 分类器模型（如 Jev）用于路由决策 | ✅ 有，`ModelRuntime.classify()` | ❌ 未接入 |

**一句话**：SDK 不会自动换模型；但只要你注册一个虚拟模型，`route()` 在**每次重试前都会被重新调用**并带上失败现场，就能自己实现自动切换。

---

## 2. 虚拟模型是什么

被用户选中的"模型"其实是一个代理条目，请求发出去之前先问它这次该用哪个真实模型：

```
用户选 jev/auto:high
      ↓  每个请求前
route(request, ctx)          ← reason: user / continuation / retry / direct
      ↓  返回 { model, thinkingLevel, state? }
物理模型（真正发请求）
      ↓
assistant 消息只记录物理模型
footer: "auto • high → gpt-5.6-luna • medium"
```

- **选择（selection）** 记在 `model_change` / `thinking_level_change` 条目里，`ctx.model` 可见。
- **派发（dispatch）** 记在每条 assistant 消息的 `provider` / `api` / `model` / `thinkingLevel` 上。
- 供应商只会收到物理模型，所以跨模型重放会话与手动切模型等价。
- 会话恢复时从最新的 `model_change` 还原虚拟选择；若该虚拟模型已注销，则回退到最后实际应答的物理模型。

---

## 3. 关键 API

| API | 位置 |
|---|---|
| `pi.registerVirtualModel(def)` / `pi.unregisterVirtualModel(provider, id)` | ExtensionAPI（`dist/core/extensions/loader.js`） |
| `modelRuntime.registerVirtualModel(def)` / `unregisterVirtualModel(...)` | `dist/core/model-runtime.d.ts` |
| 类型 `VirtualModelDefinition` / `ModelRoute` / `ModelRouteRequest` | `dist/core/virtual-models.d.ts`，包根 `dist/index.d.ts` 已导出 |
| 常量 `VIRTUAL_MODEL_API = "pi-virtual"`、`VIRTUAL_MODEL_STATE_ENTRY = "pi.virtual-model-state"` | 同上 |

`VirtualModelDefinition` 字段：

| 字段 | 说明 |
|---|---|
| `provider` | 挂靠的 provider id，可以是任意 id（含已有物理模型的 provider） |
| `id` | 模型 id，**不能与同 provider 的物理模型同 id** |
| `name` | 展示名 |
| `thinkingLevels` | 可选档位，默认 `["off"]` |
| `contextWindow` / `maxTokens` | 首次响应前展示用；之后改用实际应答物理模型的限制 |
| `input` | 默认文本 + 图片 |
| `route(request, ctx)` | **核心**：返回 `{ model, thinkingLevel, state? }` |

约束：不能路由到另一个虚拟模型；`route()` 抛错、或返回无凭证的模型 → 该请求直接以错误结束。

---

## 4. `route()` 的契约

`request` 字段：

| 字段 | 含义 |
|---|---|
| `model` / `thinkingLevel` | 被选中的虚拟模型与档位 |
| `reason` | 本次请求为何发起（见下表） |
| `previous` | `messages` 里最近一次成功响应用的物理模型与档位 |
| `failed` | **仅 `retry`**：失败请求的物理模型、档位、assistant `message`（含 `stopReason` / `errorMessage`）。路由本身失败时不存在 |
| `state` | 本会话分支上存的 router 状态 |
| `messages` / `signal` | 本次对话内容 / 中止信号 |

| `reason` | 对应请求 |
|---|---|
| `user` | 用户消息后的首个请求（含 steering、follow-up） |
| `continuation` | agent loop 内的其他请求（如工具结果之后） |
| `retry` | 失败后的自动重试，**以及上下文溢出压缩后的重试** |
| `direct` | agent loop 之外的请求（如压缩摘要、扩展调 `streamSimple()`） |

**`state` 机制**：`route()` 可额外返回 `state`（必须 JSON 可序列化），Pi 存在会话分支上，下次作为 `request.state` 传回。跟随会话树、能扛 compaction。返回 `undefined` 或 `request.state` 本身表示保持原状。`direct` 请求无状态。

---

## 5. 核心：重试时自动换模型

这是本次调研的主要目的。链路：

```
请求失败 → auto retry（retry.maxRetries 次）
        → 每次重试前重新调用 route({ reason: "retry", failed: {...} })
        → route 可返回另一个模型
```

官方文档原话（`pi-coding-agent/docs/virtual-models.md`）：

> A retry can also switch to another model, for example when `failed.message.errorMessage` reports that a provider is overloaded or the context overflowed.

骨架示意：

```ts
pi.registerVirtualModel({
  provider: "router",
  id: "auto",
  name: "Auto",
  thinkingLevels: ["low", "high"],
  route(request, ctx) {
    // 默认沿用失败/上一个模型 —— 保住 prompt cache
    if (request.reason === "retry") {
      const err = request.failed?.message.errorMessage ?? "";
      if (/overloaded|rate.?limit|429|5\d\d/i.test(err)) {
        return {
          model: ctx.modelRegistry.find("anthropic", "claude-haiku-4-5")!,
          thinkingLevel: "medium",
        };
      }
      return {
        model: request.failed!.model,
        thinkingLevel: request.failed!.thinkingLevel ?? "medium",
      };
    }
    const id = request.thinkingLevel === "high" ? "claude-sonnet-4-5" : "claude-haiku-4-5";
    return { model: ctx.modelRegistry.find("anthropic", id)!, thinkingLevel: "medium" };
  },
});
```

要点：

- `retry.maxRetries: 3` + route 重算 ⇒ 理论上 3 次重试可落到 3 个不同模型。
- `reason: "retry"` 也覆盖 **compaction 之后的溢出重试**，可借机切到上下文窗口更大的模型。
- **换模型 = prompt cache 失效**（官方明确）。所以默认应返回 `failed` 保持在原模型，仅在确实过载/溢出时才换。
- 必须由**用户选中虚拟模型**才生效。直接选物理模型时根本没有 `route()`，重试只能同一模型硬扛。

---

## 6. 背景：两层重试机制（`route` 的上游）

### 6.1 Agent 级重试（默认开，429 走这里）

| 设置 | 默认 | 说明 |
|---|---|---|
| `retry.enabled` | `true` | 总开关 |
| `retry.maxRetries` | `3` | 最多重试次数（首次不算） |
| `retry.baseDelayMs` | `2000` | 退避基数 |
| `retry.maxAgentDelayMs` | `60000` | 单次 delay 上限 |

退避：`baseDelayMs * 2^(attempt-1)`，夹到 `maxAgentDelayMs` → 实际 **2s → 4s → 8s**。

- **可重试**：`rate limit` / `too many requests` / `429` / `overloaded` / `500,502,503,504,520,524` / `service unavailable` / `internal error` / `network error` / `ECONNREFUSED` / `fetch failed` / `getaddrinfo` / `ENOTFOUND` / `EAI_AGAIN` / `socket hang up` / `timeout` / `terminated` / `websocket closed` / `stream ended before message_stop` / `http2 request did not get a response` 等（正则匹配错误文本）。
- **不重试**：配额/账单耗尽类 —— `insufficient_quota`、`out of budget`、`quota exceeded`、`billing`、`subscription_sharing_usage_limit_exceeded`，以及 OpenCode 的 `GoUsageLimitError` / `FreeUsageLimitError`（**它们也是 429，但属账户/订阅上限，不是瞬时限流**）。用户 abort 永不重试。
- **上下文溢出**不算普通重试，走 compact-and-retry，只有一次机会。
- 事件：`auto_retry_start { attempt, maxAttempts, delayMs, errorMessage }` / `auto_retry_end { success, attempt, finalError? }`。
- 运行时控制（RPC）：`set_auto_retry { enabled }` / `abort_retry`。

### 6.2 Provider 级重试（默认关）

| 设置 | 默认 |
|---|---|
| `retry.provider.maxRetries` | `0` |
| `retry.provider.maxRetryDelayMs` | `60000` |
| `retry.provider.timeoutMs` | 同 `httpIdleTimeoutMs`（300000） |

实现复刻 OpenAI / Anthropic SDK 的重试，但让退避可被 `AbortSignal` 打断（SDK 自带定时器不理会 abort，所以 Pi 用 `maxRetries: 0` 调 SDK，外面套自己的 helper）。官方建议**保持 0**，否则会拖住 Pi 自己处理配额/上限错误的时机。

> 附带：`Retry-After` 头优先于指数退避；无法解析的日期会退回退避（0.99.2 修复 #9571）。
> 另：MCP 资源读取 408/429/5xx 重试一次，**工具调用绝不重试**（服务端可能已执行）。

---

## 7. 与 Jev 分类器的关系（别混淆）

- **虚拟模型机制本身不依赖 Jev**。`route()` 就是个普通函数，纯 if-else / 正则也能路由，零额外凭证。
- Jev 是 TypeSafe 的**分类模型**（不对话，只回答带概率的判定），官方示例 `examples/extensions/jev-router.ts` 用它判断"这活复杂吗"再选模型。
- 分类模型的获取方式：`typesafe/jev-latest`（需 `TYPESAFE_API_KEY`）、OpenRouter `typesafe/jev-1.13`（复用 `OPENROUTER_API_KEY`）、Cloudflare / Vercel AI Gateway / OpenCode 各有继承。
- 分类模型**不出现在 `/model`**，两条到达路径：codemode 脚本的 `models.classify()`，或扩展的 `ctx.modelRegistry.classify()`。

---

## 8. 若日后要接入，需要做什么

1. **写一个虚拟模型扩展**，挂进 session-manager 的两处 `extensionFactories`（普通会话 `L1205` / 定时任务 `L3133`）；或直接用 SDK 侧 `this.modelRuntime.registerVirtualModel()`（桌面端已持有 `modelRuntime`）。
2. **确认模型选择器能列出虚拟模型**：`getProvidersCatalog()` 走 `mr.getModels(providerId)`（`session-manager.ts` `L1647`）；虚拟模型通过 `withVirtualModels()` 并入 provider catalog，但挂在"无物理模型的 provider id"下时 UI 是否正常展示需实测。
3. **决定凭证策略**：纯规则路由不需要任何新凭证；要 Jev 需先配 TypeSafe 或 OpenRouter。
4. **UI 提示**（可选）：参考 SDK footer 的 `auto • high → gpt-5.6-luna • medium` 展示当前实际派发模型；`/session` 按物理模型列成本。

## 9. 风险与成本

- 官方标记 **experimental**，API 可能变动。
- 换模型丢失 prompt cache，跨档位切换还可能丢失 thinking 签名；`continuation` / `retry` 默认应保持原模型。
- 桌面端 `useAgentSession.ts` 已消费 `auto_retry_start` / `auto_retry_end`（`setRetrying`），接入虚拟模型后 UI 无需大改。
- 定时任务 / 无人值守路径目前没有模型路由逻辑，若需要要单独考虑。

## 10. 参考（本地 SDK，1.0.0）

| 用途 | 路径（相对 `node_modules/@earendil-works/`） |
|---|---|
| 官方文档：虚拟模型 | `pi-coding-agent/docs/virtual-models.md` |
| 官方文档：分类器模型 | `pi-coding-agent/docs/models.md`（Use classifier models） |
| 官方示例：Jev 路由 | `pi-coding-agent/examples/extensions/jev-router.ts` |
| 类型定义 | `pi-coding-agent/dist/core/virtual-models.d.ts` |
| 扩展注册入口 | `pi-coding-agent/dist/core/extensions/loader.js` |
| 重试策略 | `pi-ai/dist/utils/retry.d.ts` / `retry.js`（可重试/不可重试关键词表） |
| Provider 级重试 | `pi-ai/dist/utils/provider-retry.d.ts` |
| 重试设置项 | `pi-coding-agent/docs/settings.md`（retry.* 行） |
| 重试事件 | `pi-coding-agent/docs/json.md`（Retry events） |
