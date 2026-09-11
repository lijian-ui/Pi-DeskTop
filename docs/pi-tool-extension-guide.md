# 桌面端工具 / 扩展开发指南（pi-desktop · Pi 双通道机制）

> 状态：**v1 —— 已定稿**（2026-09-04，沉淀自 ask_user_question / todo / web-search / subagent 四次一线集成）
> 适用读者：在 pi-desktop 里给 Pi 模型新增第一方工具的开发者。
> 一句话主旨：**在动手写 `registerTool` 之前，先理解工具的每一条信息走哪个通道、会被 LLM 以什么形态看到**——这决定模型"想得起来用、用得对、守纪律"。
> 依据版本：`@earendil-works/pi-coding-agent` v0.84.4（只读，勿改 `node_modules`）。
> 配套功能文档：`todo-extension.md`、`ask-user-extension.md`、`web-search-integration.md`。

---

## 0. TL;DR（30 秒版）

- 一个工具的信息走**两个通道**：① 系统提示词文字段（`Available tools` + `Guidelines`，教模型**何时用、守什么规矩**）；② 每轮 API 请求的 `tools` JSON Schema（教模型**怎么调**、做硬校验）。
- `promptSnippet` → `Available tools` 段出现一行 `工具名: 一句话`；**省略则不出现**（SDK #2285，不回退到 description）。
- `promptGuidelines` → 追加到 `Guidelines` 段；**平铺无前缀，每条必须自含工具名**（写 "Use ask_user_question when…"，不许写 "Use this tool when…"）。
- 新工具默认**必须给齐 snippet + guidelines**；只在工具 active 时贡献，不激活 = 零占用。
- 落地动作：建扩展 → 挂 `extensionFactories` → 配 enabled 开关 →（要 UI 交互则接 IPC 五落盘点）→ 双 `tsc` 静态检查 → 交付用户 rebuild。

---

## 1. 认知框架：工具的"双通道"长什么样

```
                 ┌────────────────────────── 一个工具 ──────────────────────────┐
                 │                                                             │
  ┌──────────────▼──────────────┐                       ┌──────────────────────▼───────┐
  │ 通道 A · 系统提示词（文本）   │                       │ 通道 B · API tools 参数（JSON） │
  │                            │                       │                              │
  │ Available tools 段          │                       │ tools: [{                   │
  │   name: 一句话（promptSnippet）│   ← 触发/存在性      │   name: "ask_user_question", │
  │ Guidelines 段               │                       │   description: "…",         │
  │   · 每条自含工具名的要点      │   ← 纪律/策略          │   parameters: { JSON Schema }│
  │     （promptGuidelines）     │                       │ }]                          │
  └────────────────────────────┘                       └──────────────────────────────┘
           每请求重发、随系统提示词                      随每个请求的 tools 参数下发，不进提示词
```

| 维度 | 通道 A · 系统提示词 | 通道 B · API Schema |
|---|---|---|
| 承载字段 | `promptSnippet` / `promptGuidelines` | `description` / `parameters` / `execute` |
| 模型看到形态 | 系统提示词里的一行 / 几条要点（自然语言） | `tools` 参数里的完整 JSON Schema |
| 解决什么 | **想起来调 + 调得聪明**（存在性、触发、纪律） | **调得对**（参数契约、硬校验、执行） |
| 何时生效 | 工具在 active 集时贡献（激活即注入） | 工具被注册即可被调用（随请求下发） |
| 成本 | 每个请求都重发，故必须一行级极简 | 长 JSON，模型决策时不逐条精读 |

> 结论：**通道 B 是"能力"，通道 A 是"使用策略"。** 一个 Schema 写得再完美，也解决不了模型"这轮有几十个工具、想不起用你"和"会用但不按团队纪律用"的问题——那正是通道 A 的活。

---

## 2. 通道 A 详解（系统提示词）

### 2.1 `promptSnippet` → `Available tools` 段

- 带 snippet 的工具，在系统提示词的 `Available tools` 段得到一行：`工具名: snippet 文本`。
- **SDK #2285 起：省略 `promptSnippet` 的工具不进该段**（旧版回退 description 的行为已取消）。→ 想要模型"看见"你的工具，这字段必给。
- 写法：**一句话、英文亦可**（如 todo：`"Maintain a live task checklist for multi-step work: create items up front, update their status as you go."`）。它是索引式摘要，成本约等于无，重在"低扫描成本触发"。

### 2.2 `promptGuidelines` → `Guidelines` 段

- 追加为 `Guidelines` 段里的要点 bullet，**只在工具 active 时**包含。
- **硬规则：bullets 平铺追加、不带工具名前缀、不做分组**（SDK docs/extensions.md:1375）——因此**每条必须自己写出工具名**：
  - ✅ `"需要 3 步以上的工作，先调用 todo create 建立完整清单…"`
  - ❌ `"Use this tool when…"`（LLM 无法知道 this 指谁）
- 用途：承载 schema 放不下的**策略与习惯**——调用时机、顺序约束、禁止事项（参考已落地扩展的范例见 §5）。

### 2.3 三条必须记住的 SDK 行为

1. **省略 snippet = 模型在系统提示词里看不到这个工具**（只在 API schema 层可调）——默认不要省略。
2. **激活带 snippet/guidelines 的工具会重建系统提示词**，可能破坏 provider 侧 prompt-cache 前缀（SDK docs/extensions.md:2396）——**懒加载/低频工具建议只依赖 description、不带 prompt 元数据**；常驻工具则无此顾虑。
3. **guidelines 只在 active 时贡献**：不激活 = 提示词与 schema 双零占用；反之改 active 集 = 系统提示词重建（与 2 同源）。

---

## 3. 通道 B 详解（API tools JSON Schema）

- SDK 在每个 API 请求的 `tools` 参数里带上已注册工具的完整定义（`name`/`description`/`parameters`），**不进系统提示词文本**。
- `parameters` 用 JSON Schema（本项目经 `Type.Box` / zod / typebox 风格 schema 定义），承担**硬校验**：
  - 字段必填/可选、类型、`minItems/maxItems` 上下限；
  - 语义保留词（如 ask_user 的 `RESERVED_LABELS`）与校验顺序（如 reserved_label 先于 duplicate_option_label）也在此层实现。
- 模型靠它做**结构化调用**；`execute` 收到的是已过 schema 的参数。

---

## 4. 为什么 Pi 要拆成两段（设计动机）

1. **Schema 解决不了"存在性/触发"**：一回合几十个工具，模型不会逐条精读长 JSON；`Available tools` 里那行 snippet 是近乎零成本的索引式触发提示，显著降低"漏调/想不起来"。
2. **自然语言指令的服从权重高于 JSON**：`Guidelines` 里的纪律要点（"先建清单再逐步同步"）比埋在 parameters.description 里有效得多。
3. **token 预算**：系统提示词**每个请求都重发**——只允许 snippet 一行、无 snippet 不进段（#2285），防止工具名刷屏污染提示词。
4. **激活即注入**：只有 active 工具贡献 prompt 元数据，天然做到"不激活 = 零占用"。
5. **缓存纪律**：提示词任何改动（含激活带元数据工具）都可能破 prompt-cache → 常驻工具给齐元数据、懒加载工具别给。

---

## 5. pi-desktop 现状对照（已挂载扩展 × 注入范围）

普通/空间会话数组（`session-manager.ts:1103`）：

```ts
extensionFactories: [soulExtension, rulesExtension, webSearchExtension,
  createSubagentExtension(() => this.webContents, () => this.modelRuntime),
  todoExtension, createAskUserExtension(() => this.webContents)],
```

定时任务会话数组（`session-manager.ts:2592`，**注意差异**）：

```ts
extensionFactories: [createScheduledTaskExtension(task), rulesExtension,
  webSearchExtension, createSubagentExtension(() => this.webContents, () => this.modelRuntime)],
```

| 工具 | 扩展文件 | snippet | guidelines | 普通/空间 | 定时任务 | enabled 开关 |
|---|---|---|---|---|---|---|
| `web_search` / `web_fetch` | `web-search-extension.ts` | ✅ | ✅ | ✅ | ✅ | `websearch-config.json`（默认关，需可用 provider） |
| `subagent` | `subagent/` | ✅ | ✅ | ✅ | ✅ | —（无开关，恒注册） |
| `todo` | `todo/todo-extension.ts` | ✅（英文一句话） | ✅ 3 条（中文自含工具名） | ✅ | ❌ | `todo-config.json` |
| `ask_user_question` | `ask-user/ask-user-extension.ts` | ✅ | ✅ 3 条（中文自含工具名） | ✅ | ❌ | `askuser-config.json` |

> **开关入口（2026-09-04 起）**：「设置 → 可用工具」页面分**两段**，对应两套启停机制（新增前请先读 `src/main/pi/tool-catalog.ts`）：
> - **内置工具段**：7 个 SDK 内置工具勾选 → 写 `settings.json` `activeTools`，经 `session.setActiveToolsByName`（全量覆盖）即时生效。
> - **扩展工具段**：由 `tool-catalog.ts` 的 `FEATURES` 表驱动（**每加一个新扩展工具必须在此登记** `key`/`toolNames`/`switchable`/`configFile`），开关写各 `*-config.json` `enabled`；保存后 `PiSessionManager` 对所有 live 会话重放 active 集——config 只挡**未来注册**，已运行会话的工具靠 `disabledExtensionToolNames()` 从 active 集剔除（`applyUnitToolSet` 统一实现，saveActiveTools 与 applyUnitActiveTools 共用，勿再各自实现致分叉）。
> - subagent 在表中 `switchable: false` → 页面显示禁用态（"随应用加载，暂不支持单独关闭"）。

> **会话级工具模式（2026-09-04 起，ChatComposer 输入框上方下拉）**：极简 / 标准 / 办公是**第三层**——每个 workspace（unit/cwd）的模式，只收窄该会话的 active 集，**不写任何全局配置**：
> - 定义在 `src/main/pi/tool-catalog.ts` 的 `TOOL_MODES`：`minimal`（read/bash/write + subagent）、`standard`（全部）、`office`（标准 + 规划中的 office 能力）。
> - 最终 active 集 = （全局 `settings.activeTools` ∩ 模式内置子集）∪ （全局 config 启用的扩展 ∩ 模式 feature 允许）——全局是天花板，模式只能往下收。
> - 状态存 `settings.json` `sessionToolModes: {cwd → mode}`（unit 级字段 `toolMode`，`ensureUnit` 时恢复）；切模式走 `PiSessionManager.setSessionToolMode(cwd, mode)` → `applyUnitToolSet` 重算**该 unit** active 集。
> - 定时任务会话走独立 runtime（不经 units/applyUnitToolSet）→ **天然不受模式影响**（拍板：仅当前会话）。同一空间目录内切历史会话沿用该目录模式（unit 级语义与模型选择一致）。
> - **开发新扩展须知**：要让新工具可被「办公」模式收编，在 `FEATURES` 表登记 `key: "office"`（`TOOL_MODES.office.features` 已预留）；默认应能容忍"被极简剔除"——active 集剔除不影响注册，切回标准即恢复。

> **挂载判据（"与 Todo 一致"的决策逻辑）**：工具是否**需要屏幕前有人**？
> - todo / ask_user：天然面向人机协同（人在看面板、人会被弹窗打断）→ 定时任务（无人值守、cron 半夜跑）挂上没有意义，甚至 ask_user 会无人作答 → **不挂**。
> - web_search / subagent：纯自主能力，无人也能用 → **两处都挂**。
> - 定时任务的 rules 与 scheduledTask 同理是 cron 场景必需。

配置开关语义：三个扩展在 factory 里先查各自 `*-config.json` 的 `enabled`，**false 时整个工具不注册**（不进提示词、API 也无 schema）；execute 内还会重读一次（防注册后中途被关）。

---

## 6. 新工具落地检查清单（可直接照做）

### 6.1 目录与文件布局

新增常驻扩展的最小布局（对照 `ask-user/`、`todo/`）：

```
src/main/pi/<feature>/
  <feature>-extension.ts   # InlineExtension + registerTool（SDK 依赖集中在这）
  <feature>-core.ts        # 纯逻辑：校验 / envelope / 状态机（不 import SDK，可单测）
  <feature>-registry.ts    # 需要跨进程等状态时：pending 注册表 / 缓存（可选）
  <feature>-config.ts      # *-config.json 读写 + enabled 默认 true
```

对应 `src/shared/<feature>-types.ts` 放双端共享类型（IPC payload 等）。

### 6.2 `registerTool` 元数据必查

```ts
pi.registerTool(defineTool({
  name: "snake_case_工具名",   // ← 模型调用名；与 InlineExtension.name（kebab-case 扩展名）区分
  label: "中文展示名",
  description: "完整中文描述：做什么 + 何时用 + 关键约束（可多行拼接）",
  promptSnippet: "一行索引式摘要（英文佳，成本极低）",
  promptGuidelines: [          // 每条自含工具名，不要 "this tool"
    "…场景，先调用 <name> …",
    "…时禁止用 <name> …",
  ],
  parameters: <JSON Schema 含硬校验 min/max / 保留词>,
  execute: async (id, params, signal, onUpdate, ctx) => AgentToolResult,
}))
```

检查项：
- [ ] **snippet + guidelines 都给**（除非是懒加载工具，见 §2.3）
- [ ] guidelines 每条**出现工具全名**（≤6 条，中文口语化即可）
- [ ] description 三要素齐全：做什么 / 何时用 / 别踩什么
- [ ] schema 硬上限（数量、长度、枚举、保留词）都校验，**校验顺序**稳定可测

### 6.3 挂载决策

- [ ] 决定挂普通数组 or 两个数组都挂：**看"是否需屏幕前有人"**（§5 判据）
- [ ] 在 `session-manager.ts` 两个 `extensionFactories` 数组之一（或都）追加，import 同步落
- [ ] 新增 `*-config.ts` + `enabled` 开关（默认 true），factory 内首行判开关
- [ ] **在 `src/main/pi/tool-catalog.ts` 的 `FEATURES` 表登记**新扩展（key / toolNames / switchable / configFile）——否则「设置 → 可用工具 → 扩展工具」段不显示、也无法从页面启停；不打算让用户单独关的（如 subagent）设 `switchable: false`
- [ ] config 有其它字段（如 websearch 的 providers）时，写 enabled 必须"读-改-写"整对象，**禁止整体覆盖**

### 6.4 需要 UI 交互？——IPC 链路五落盘点（历史踩坑：三处丢 body）

一次交互链路（如 ask_user、bash 审批）涉及 5 个落盘点，**必须逐点 grep 核对落盘**——本项目已两次出现"import 在了、方法体/注册丢了"（tsc 全绿但运行时 `is not a function` / `No handler registered`）：

| # | 落盘点 | 内容 | 丢了会怎样 |
|---|---|---|---|
| 1 | `src/main/ipc-handlers.ts` **import** | `tryAnswerXxx` 等入口 | 编译错（能抓到） |
| 2 | `src/main/ipc-handlers.ts` **`ipcMain.handle` 注册** | `pi:xxxAnswer` | `No handler registered`，主进程无人 resolve → **工具永远转圈** |
| 3 | `src/preload/index.ts` **import type** | 共享 payload 类型 | 类型缺失（能抓到） |
| 4 | `src/preload/index.ts` **`piAPI` 方法体** | `onXxxPrompt` / `answerXxx` | `window.piDesk.onXxxPrompt is not a function` → 组件抛错 → **整树白屏**（无 error boundary 时） |
| 5 | `src/preload/api.d.ts` **类型声明** | 方法签名 + payload 类型导出 | 渲染端编译错（能抓到） |

> ⚠️ 经验：**方法体（2、4）是 tsc 唯一抓不到的环节**——类型声明与运行时对象分离。改 preload / handler 后，对照 api.d.ts 把三处（import、方法体、声明）与 handler（import、注册）各 grep 一遍再交付。

### 6.5 渲染端（如弹 UI）

- 组件挂 ChatComposer 既有浮层槽（与 BashApprovalModal / AskUserPanel 并列），或会话面板内；样式**全走 token**（`var(--*)`，暗/亮两套来自 `tokens.css`；字号用 `--body-*-font-size`、字重 `--font-weight-medium/strong`，**无** `--font-size-13` / `--font-weight-500` 这类命名 token）。
- UI 偏好：无入场动画、hover 只阴影不位移（transition 不含 transform）。
- 状态放 zustand store（卡片/草稿），跨会话切换不丢。

### 6.6 收尾验证（项目铁律：只静态检查，不跑 build）

- [ ] 主进程：`env -u CODEBUDDY_SESSION_ID -u CLAUDE_SESSION_ID NODE_OPTIONS= npx tsc -p tsconfig.node.json --noEmit` → EXIT=0
- [ ] 渲染端：同上但 `-p tsconfig.json --noEmit` → EXIT=0
- [ ] 全链路 grep：对照 §6.4 表格把 5 个落盘点逐点确认
- [ ] 文档：`docs/<feature>-extension.md`（机制 + 拍板 + 验证指引）
- [ ] 日志：追加 `.workbuddy/memory/<YYYY-MM-DD>.md`
- **不跑** `npm run build / dev / electron-builder`——由用户 rebuild 实机验证

---

## 7. 验证方法（实机）

1. **工具可见性**：dev 会话里让模型"列出当前可调用的全部工具名称"，对照 §5 表格——普通会话应含 6 个工具的 snake_case 名；定时任务会话会话侧栏的任务里只应有 `web_search`/`web_fetch`/`subagent`（+scheduled-task 专属），**看不到** todo/ask_user_question。
2. **开关生效**：把某 `*-config.json` 的 enabled 改 false 重启，再问模型工具列表，该工具应彻底消失（提示词与 schema 双无）。
3. **交互链路**：触发一次完整流程，DevTools console 无 `is not a function` / `No handler registered`；卡片出现/消失、主进程 resolve、模型收到 envelope 继续。
4. **中断安全**：会话停止按钮 / 超时路径下工具不永久转圈（execute 的 Promise 必须由 作答 / signal abort / 超时 三路之一 resolve——参照 `ask-user-extension.ts` 的 `waitForAnswer`）。

---

## 8. SDK 依据（只读引用）

- `node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md`
  - `#1237` snippet 一行进入 Available tools；`#1720` guidelines 追加 Guidelines 段；`#2285` **省略 snippet 不进段**；`#4879` `getAllTools()` 暴露 promptGuidelines。
- `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
  - `:1373-1375` snippet / guidelines 语义 + **guidelines 平铺无前缀、每条自含工具名**；
  - `:1915-1919` 省略 snippet 不进段；guidelines 仅 active 时包含；
  - `:2396` 激活带 prompt 元数据的工具**重建系统提示词**、可能破 prompt-cache → 懒加载工具只靠 description。
- 本项目落地范本：`src/main/pi/ask-user/ask-user-extension.ts`（含 UI 交互 + 三路 resolve 的完整形态）、`src/main/pi/todo/todo-extension.ts`（纯状态工具形态）。
