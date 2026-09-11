# Pi 会话模型选择：机制与踩坑（Model Selection Pitfalls）

> 状态：**已修复**（2026-09-04，主进程 `session-manager.ts` 多处改动，双端 tsc EXIT=0，待 rebuild 验证）。
> 主题：为什么"新建任务 → 先选模型 → 发首条消息"这个最基础的交互曾反复失灵——根因不在 UI，而在 **Pi SDK 的默认模型解析机制** 与桌面端的 **services 缓存 / deferred 暂存** 三处叠加。
> 适用：任何"让新会话使用指定模型"的场景（新建任务、定时任务、IM 迁移、fork），以及排查"UI 显示 A、实际对话用 B"类问题。

---

## 1. 背景：涉及的交互路径

| 路径 | 触发点 | 模型从哪来 |
|---|---|---|
| 会话中切换 | 点模型 pill → 下拉选 | 直接 apply 到当前 unit 的 live session（不读默认） |
| 新建空任务，发消息前选 | 点「新建任务」→ 选模型 → 发首条消息 | **deferred：先 stash，首条消息建会话时套用** ← 所有 bug 都出在这 |
| 切回历史会话 | switchSession / newSession | 用 unit.defaultModel 回灌 |
| 新建会话不选模型 | 任何新会话 | SDK 初始模型解析（settings 全局默认 或 兜底） |

> 铁律背景：任务目录懒加载——空任务（未发首条消息）**不允许建任何磁盘目录**，因此"选模型"时世界上不存在会话，只能暂存（`pendingTaskDefaults`）。

---

## 2. "默认模型"到底有几层？（先建立心智模型）

| 层 | 载体 | 谁在读写 | 坑 |
|---|---|---|---|
| ① 全局默认（磁盘） | `~/.pi/agent/settings.json` 的 `defaultProvider` / `defaultModel` | `persistDefaultModel()` 只**写文件** | SDK 建新会话**不读这个文件**，读的是内存 SettingsManager（见 ②） |
| ② 内存 SettingsManager | services 里的 `settingsManager`，随 `servicesByCwd` 缓存 | SDK `findInitialModel` 真正读它 | **首次建会话时加载一次，之后永不刷新** → persist 后内存仍旧 → 陈旧默认 |
| ③ unit 记账 | `unit.defaultModel`（桌面端 per-unit） | switchSession / newSession 回灌 | 只覆盖"本 unit"，不是全局 |
| ④ deferred stash | `pendingTaskDefaults: Map<cwd, {provider, modelId}>` | 空任务选模型时暂存；首条消息套用 | 应用时机/方式错就静默丢 |

**一句话**：磁盘 ≠ 内存；文件改了 ≠ SDK 知道了。这是整串 bug 的第一性根因。

---

## 3. SDK 内部机制（读源码确认的事实，勿凭猜）

### 3.1 新会话初始模型的优先级（`dist/core/model-resolver.js` 的 `findInitialModel`）

```
1. 显式 model 选项        ← 最高，唯一能绕过一切默认的手段
2. scopedModels[0]        ← 若调用方传了 scoped 模型
3. settings 默认          ← 仅当 hasConfiguredAuth(provider) == true 才被采纳
4. 兜底 snapshot[0]       ← 前三条都不满足时取可用模型列表第一个
```

推论：
- **想让新会话用指定模型，最稳 = 创建时经 `createAgentSessionFromServices({ model })` 显式注入**，别指望 settings 默认。
- settings 默认只是"尽力而为"：provider 不被 SDK 认可"已配置 auth"时会被静默跳过、落到兜底。

### 3.2 `configuredProviders` / `hasConfiguredAuth` 是不可靠的运行时快照

- 快照在 `ModelRuntime.create()` 时构建。
- 对 custom-models.json 运行时注册的 provider（`registerProvider` + `setRuntimeApiKey`），快照**不一定刷新** → `hasConfiguredAuth()` 可能 false。
- 实测：`~/.pi/agent/auth.json` 里明明有该 provider 的 key，SDK 仍判定 false。
- 后果：`findInitialModel` 第 3 步跳过 settings 默认 → 落到第 4 步兜底 = 可用列表**第一个**模型（lm-studio 恰好是 qwen3.5-4b / gemma，于是表现为"莫名其妙被某固定模型回复"）。

### 3.3 `session.setModel` 带 auth 门槛（`dist/core/agent-session.js`）

- 类方法 `setModel`：内部先 `await checkAuth(provider)`，不过就 **throw "No API key"**；某些封装层则**静默 return false**。
- 对运行时注册的 custom provider，这道判定不可靠 → **throw 或静默不生效都常见**。
- 教训：`try/catch` 吞掉 + fire-and-forget（不 await）双管齐下时 = 模型没切且无任何报错，UI 却可能已显示新模型 → 最阴的失败形态。

### 3.4 绕过门槛的强制通道（可安全使用）

```ts
session.agent.state.model = model;          // 与 SDK 自身赋值同一路径
session.sessionManager?.appendModelChange?.(model.provider, model.id); // 落盘 model_change
```

- SDK 自己的 `agent-session-runtime.js` 也在这么用（169 行附近），非 hack。
- 前提：`model` 必须来自 `modelRuntime.getModel(provider, modelId)`（含完整 config），不能用裸 `{id}`。
- 桌面端已封装为 `applyModelToUnit()`：先走标准 `setModel` + **回读校验** `session.model.id/provider`，失败才走强制通道。

---

## 4. 三个 bug 时间线（现象 → 根因 → 修法）

### Bug 1：空任务切模型，pill 不刷新
- 现象：新建任务后选模型，界面毫无反应（主进程其实已记住）。
- 根因：切完刷新全靠 `getState(cwd)` 回读；空任务无 unit → 返回 `model: null` → store 不更新。
- 修法：`getState` 兜底查 `pendingTaskDefaults`，经 `modelForDisplay()` 解析成与 `session.model` 同构的 `{id, provider, name}`。

### Bug 2：选 lm-studio 的模型，发消息却全走 qwen3.5-4b
- 现象：settings 全局默认已 persist 成 gemma，实测 4 个会话的 assistant 消息全部 qwen。
- 根因：`applyPendingTaskDefaults` 里 `session.setModel(m)` **未 await**（SDK setModel 是 async，auth 通过后才真正换 state.model）+ auth 门槛 throw 被 `try/catch` 吞掉 → 首条消息比模型切换先跑 → 落到兜底模型。
- 修法：应用逻辑异步化 + 统一走 `applyModelToUnit`（回读校验 + 强制通道），失败只告警不打断建会话。

### Bug 3：选 deepseek，发消息仍 gemma（跨渠道必现，最有迷惑性）
- 现象：settings.json 在 11:55:03 persist 成 deepseek；会话 11:55:06 创建，创建瞬间的 `model_change` 却记 gemma，全程无 deepseek 记录。
- 根因①（主）：`servicesByCwd` 缓存的 services（含内存 SettingsManager）建于 11:49，之后**从不刷新**；`persistDefaultModel` 只写文件 → `findInitialModel` 永远读到陈旧的 gemma 默认。lm-studio 看起来"正常"纯属陈旧默认碰巧是 gemma。
- 根因②：事后 `setModel` 补救链路脆弱（受 auth 门槛 + 时序影响）。
- 修法（双管齐下）：
  1. `ensureUnit` 建会话**之前**读 stash，经 `createAgentSessionFromServices({ model })` 直接注入 → 会话出生即正确；用 **one-shot 变量**（首次建会话后清空），防 /new、fork 重调工厂时错误沿用最初 stash。
  2. `persistDefaultModel` 写文件后调 `syncCachedDefaultModel()`，把新默认同步进**所有缓存 services 的内存 SettingsManager** → 此后任何新会话立即吃新默认。

---

## 5. 防错清单（铁律，开发时对照）

1. **会话创建时要指定模型** → 一律经 `createAgentSessionFromServices({ model })` 显式透传，**不要依赖 settings 默认**（第 3.1 节：默认只是尽力而为）。
2. **persist 全局默认后** → 必须 `syncCachedDefaultModel()` 刷内存，否则新会话吃陈旧默认（Bug 3 根因①）。
3. **任何 `setModel` 应用后要立刻发消息/校验** → 必须 `await` + **回读 `session.model`（id+provider 双比对）**；不生效或抛错 → 走 `agent.state.model` 强制通道（`applyModelToUnit`）。
4. **deferred stash 只给首次建会话** → one-shot 消费（可变量，用完即弃），防止 factory 重调（/new、fork、resume）误用。
5. **空任务 UI 回读** → `getState` 必须兜底 `pendingTaskDefaults`，返回形状 `{id, provider, name?}`，与 `session.model` 同构（键名错位会显示成 `lm-studio/`）。
6. **SDK 的 `setModel` / `setThinkingLevel` 都是 async 且状态在 await 后才切换** → 凡"建会话后立刻发消息"路径都必须 await，fire-and-forget = 静默用错模型。
7. **验证手段**：会话文件首条 `model_change` 记录即"创建时实际生效的模型"——`~/.pi/agent/sessions/<escaped-cwd>/*.jsonl` 里 `type == "model_change"` 的行是硬证据；`settings.json` 的 `defaultModel` 只证明"写进去了"，不证明"会话吃到了"。
8. **改完主进程** → `tsc -p tsconfig.node.json --noEmit`；rebuild 前彻底退出旧实例（托盘 + 任务管理器结束 electron），否则"改了没生效 / bug 仍在"都是旧进程假象。

---

## 6. 关键代码位置

主进程 `src/main/pi/session-manager.ts`（改动全部集中于此）：

| 符号 | 行号 | 职责 |
|---|---|---|
| `pendingTaskDefaults` / `isDeferredTask` | 876 / 889 | 空任务 stash 与判定 |
| `applyPendingTaskDefaults` | 899 | 首条消息时应用 stash（async + 校验） |
| `ensureUnit`（stash → model 注入） | ~1174–1239 | 建会话前把 stash 模型透传 `createAgentSessionFromServices({ model })`，one-shot |
| `setModel` | 2151 | IPC 入口：deferred 分支 stash；正常分支记账 + applyModelToUnit + persist + 广播 |
| `persistDefaultModel` / `syncCachedDefaultModel` | 2270 / 2294 | 写文件 + **同步内存 SettingsManager** |
| `applyModelToUnit` | 2327 | 标准 setModel + 回读校验，失败走 `agent.state.model` 强制通道 |
| `modelForDisplay` / `getState` | 3415 / 3425 | 兜底 pendingTaskDefaults，返回与 `session.model` 同构形状 |

参考用 SDK（**只读勿改**）：`node_modules/@earendil-works/pi-coding-agent/dist/core/`
`model-resolver.js`（findInitialModel 优先级）、`model-runtime.js`（configuredProviders / checkAuth）、`agent-session.js`（setModel auth 门槛）、`agent-session-runtime.js`（`agent.state.model` 直写的官方用法）。
