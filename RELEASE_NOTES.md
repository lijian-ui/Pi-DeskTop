# Pi Desktop v0.7.0 Release Notes

## 本版概要

- **子代理（Subagent）系统**：LLM 可将子任务委派给专门的子代理执行，支持单次 / 并行 / 链式调用，自带递归护栏与工具白名单。
- **委派引导**：系统提示词注入可用角色清单 + 委派准则，强化 subagent 工具描述，并新增 `/subagent` 命令（裸命令列出所有可用角色）。
- **并发执行**：同一轮可同时委派多个子代理（并行上限 4），修复了并发机制下的深度计数误判 bug。
- **渲染端进度面板**：新增 SubagentProgress 面板，实时展示各子代理的运行 / 完成状态与运行过程。

---

## 新增功能

### 1. 子代理（Subagent）系统
- 主进程注册 subagent 工具：常规会话与定时任务会话均挂载 `createSubagentExtension(webContents, getModelRuntime)`（`src/main/pi/session-manager.ts`）。
- 子代理定义：读取 `~/.pi/agent/agents/*.md`，frontmatter 含 `name` / `description` / `aliases` / `tools` / `thinking`；样例 `scout.md` / `summarizer.md` 已补全 frontmatter。
- 模型复用：子代理默认复用当前会话下拉模型（透传主进程 `modelRuntime` 到 `createAgentSession`），frontmatter `model` 字段可覆盖；`thinkingLevel` 同理。
- 指令发送：子代理指令以 user 消息形式发送（删除死代码 `systemPromptMode: replace`，`src/main/pi/subagent/agent-discovery.ts`）。
- 委派引导：
  - `before_agent_start` 钩子向系统提示词注入可用角色清单 + 委派准则（`src/main/pi/subagent/index.ts`）。
  - 强化 subagent 工具描述，提升 LLM 主动委派意愿。
  - 系统提示词「Available tools」段新增 subagent（补充 `promptSnippet` + `promptGuidelines`），使工具出现在官方工具清单中。
- `/subagent` 命令：简化为裸命令，仅列出所有可用角色，引导 LLM 自行委派（删除 `<角色> <任务>` 执行与 `list` 子命令）。
- 工具白名单：子代理仅能使用 agent-discovery 在 frontmatter 声明的 `tools`，防止越权。
- 递归护栏（结构性）：子会话创建时不挂载 subagent 扩展 → 子代理自身没有 subagent 工具 → 无法自嵌套，从根本上防止递归爆炸。

### 2. 并发执行

- 多个子任务走 `mapLimit(specs, MAX_PARALLEL=4)` 并行；LLM 可在同一轮同时委派多个子代理，SDK 以 `Promise.all` 处理同轮多 tool_call。
- 修复全局 `depth` 计数器并发 bug：删除全局深度计数（并发的兄弟任务被误判为嵌套而触发误拦），结构性递归护栏已足够，无需运行时计数。

### 3. 渲染端进度面板

- 新增 `src/renderer/components/SubagentProgress.tsx` + `.module.css` + `store/subagent-store.ts`，在 `App.tsx` 挂载，实时展示子代理的运行中 / 已完成状态与结果摘要。
- 运行过程可视化（本版新增）：子代理每步工具调用（`tool_call` / `tool_result`）实时以步骤列表展示在面板内（显示工具名 + 参数摘要 + 结果摘要），让主会话清楚「子代理在干什么」；按决策只显示工具级、不含思考过程、本会话内即时展示不落盘。

---

## 修复与体验优化
- **subagent 不工作修复**：
  - 样例 `scout.md` / `summarizer.md` 此前缺失 frontmatter → 重写补全，确保被 agent-discovery 正确识别。
  - 子代理调不了模型（runner 漏传 `modelRuntime`）→ 透传主进程 `modelRuntime` getter 到子会话，子代理即可复用当前模型与密钥。
- **缓存命中率**：本次改动注入内容稳定、工具定义为静态一次性变化，不会破坏 LLM 的提示词缓存命中率（纯调研结论，无行为变更）。
- **子代理进度面板不显示（根因修复）**：`createSubagentExtension` 原在 `ensureUnit()` 内用 `this.webContents` 的当前值（管理器初始化早于 `setEventTarget` 赋值，故为 `null`）捕获进 `sendEvent` 闭包，导致默认 chat 会话的所有进度事件被 `null?.send()` 静默丢弃、面板永不刷新。改为发送时惰性取 `getWebContents()`（与 `getModelRuntime` 同款 getter 模式）并加 `isDestroyed()` 防护，同时兼容窗口重建后的 webContents 切换。
- **子代理运行步骤（工具级过程）不显示（根因修复）**：进度面板本版新增了「每步工具调用 / 参数 / 结果摘要」的步骤列表，但初版用 `session.subscribe()` 监听 `tool_call` / `tool_result`，实测步骤始终为空。经排查 SDK（`@earendil-works/pi-coding-agent` 只读）确认：`tool_call` / `tool_result` 并不在 `AgentSession` 的订阅事件流里广播，而是仅经 `Agent` 的 `beforeToolCall` / `afterToolCall` 拦截点（SDK 内部据此向扩展转发工具事件）。因此改为在子会话 `session.agent.beforeToolCall` / `afterToolCall` 上挂转发钩子（保留原钩子语义、不拦截工具结果），将每一步工具名 / 参数摘要 / 结果摘要以 `subagent_step` 事件推到渲染端。主进程 `tsc -p tsconfig.node.json --noEmit` 通过。后续实机验证仍有用户反馈「日志显示 hook 触发、面板却不显示步骤」：根因在**渲染端** `src/renderer/store/subagent-store.ts` 的 `init()` 事件处理链只接了 `subagent_start` / `subagent_done` / `subagent_error` 三个分支、**漏接 `subagent_step`**，且 `subagent_start` 创建的 run 未初始化 `steps:[]`，导致主进程发出的步骤事件被整体忽略、`r.steps` 恒为 `undefined`、组件渲染条件不成立。补充 `subagent_step` 分支（upsert push `{kind,tool,label,detail,isError}` 到对应 run）并在 `subagent_start` 初始化 `steps:[]`，渲染端 `tsc -p tsconfig.json --noEmit` 通过。

---

- **子代理运行时停止按钮无法中断（根因修复）**：主进程 `session-manager.ts` 的 `abort(cwd)` 仅 `unit.runtime.session?.abort()` 中断主会话，而子代理是 `runOne()` 内独立 `AgentSession`（`await session.prompt()`），不在 `units` 体系内，停止按钮够不到 → 子代理继续跑完。修复：`runner.ts` 用 module 级 `Map<runId,{session,cwd}>` 登记活动子会话（创建后登记、`finally` 删除），导出 `abortSubagents(cwd)`；`session-manager.abort(cwd)` 末尾调用 `abortSubagents(cwd)`（按 cwd 精确终止该会话的子代理）；`runOne` 的 catch 识别 `session.aborted` 返回「已被用户停止」文案而非失败。主进程 `tsc -p tsconfig.node.json --noEmit` 通过。

---

## 依赖与构建
- 无新增 npm 依赖，复用现有 Pi SDK 的 `createAgentSession` 与扩展机制（`src/main/pi/subagent/`）。
- 版本号仅维护在 `package.json`，`electron-builder.yml` 自动读取。



*如果使用过程中遇到任何问题，请直接到 [Issues]( 反馈。*
