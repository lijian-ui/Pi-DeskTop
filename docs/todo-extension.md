# Todo 功能开发文档（pi-desktop）

> 状态：**v4.2 —— 已实现**（v4.1 经用户实机验证并反馈按钮位置；§3/§6 为落地代码）
> 参考实现：[`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo)（MIT）——**仅借鉴状态机与快照设计，不引入该包、不装任何扩展**。
> v3 变更（2026-09-03）：Q2/Q3/Q4 定案——`todo.enabled` **默认开**；面板改为**聊天区右侧独立栏**（非消息区上方细条）；定时任务会话**不挂**该工具。
> v4 变更（2026-09-03）：Q1/Q5/Q6 默认项获批，按 §9 全部落地。实现清单：`src/main/pi/todo/`（todo-state.ts 纯逻辑 + todo-extension.ts 工具 + todo-config.ts 开关）、`src/shared/todo-types.ts`（双端共享类型）、主进程 `session-manager.ts` 普通会话数组接线 + `pi:getTodoSnapshot` IPC、渲染端 `todo-store.ts` + `ui-store.todoPanelOpen` + `ChatPanel` 双列 + `TodoPanel.tsx/css` + `useAgentSession` 事件触发。**注意**：落地配置为独立 `todo-config.json`（`~/.pi/agent/`，默认 `{ enabled: true }`），与 websearch-config.json 同模式——不走 settings.json（文档 §0 早期表述以此为准）。
> v4.1 变更（2026-09-03）：修复"面板关闭后无法重开"——关闭态渲染 34px rail 重开按钮；`todo-store` 增 per-session `dismissed` 标记，用户手动关闭后模型更新不再 auto-open 弹回（详见 §6.2）。

## 0. 集成方式（v2 定案）

**第一方代码内联集成，与 `webSearchExtension`、`createSubagentExtension` 完全同一机制**：

- Todo 是 pi-desktop **自己代码库里的一个常驻工具扩展**（`src/main/pi/todo/`），随桌面应用构建发布；
- 经 `resourceLoaderOptions.extensionFactories` 注入 SDK（`session-manager.ts:1101` 普通会话 / `:2590` 定时任务），**不是**可从扩展商店安装/卸载的包，不走 `pi install`；
- 由 `todo-config.json`（`~/.pi/agent/`，与 `websearch-config.json` 同模式，独立于 settings.json）的 `enabled` 做总开关（**默认开**，§8 Q2 定案；可整体关闭），关掉时工具根本不注册（对齐 webSearch 的 master-switch 模式，模型不会空调用）。

> 为什么"模型可见"仍然要过扩展机制：SDK 中 `pi.registerTool` 只存在于 extension factory 内（`web-search-extension.ts` 已验证），这是**不动 SDK 源码**（项目铁律）前提下给模型加工具的唯一入口。webSearch、子代理、定时任务、soul 全部如此——所以"第一方内联扩展"就是本项目的"桌面直接集成"。

---

## 1. 功能定义

### 1.1 它是什么

给 Agent 会话加一张**实时任务清单**：模型把多步工作拆成 todo 项，执行中用 `todo` 工具自行增删改、标记进度（`pending → in_progress → completed`）；桌面端在**聊天区右侧**渲染只读面板（§6.2），用户随时可见进度。

与 Plan（计划模式）互补而非替代：

| | Plan（计划模式） | Todo |
|---|---|---|
| 时机 | 执行**前**，需用户批准 | 执行**中**，模型自维护 |
| 交互 | 用户批准/驳回方案 | 用户只读进度 |
| 变化 | 静态提案 | 活状态，随执行实时变更 |
| 依赖 | 无 | `blockedBy` 表达任务依赖 |

### 1.2 用户价值

- **长任务防丢失**：几十轮工具调用中模型不会忘了要干啥，清单是它的外部记忆。
- **进度透明**：随时能看"卡在第几步、被谁阻塞"。
- **扛压缩/重载**：快照内联在对话历史里（§4），compact 后清单不丢。

---

## 2. 总体架构（v2：无内存 store、无新推送通道）

```
┌──────────── 主进程 ────────────────────────────────┐
│  session-manager.ts                                 │
│   extensionFactories: [... webSearchExtension,      │
│                              todoExtension  ← 新增] │
│        └─ todoExtension (InlineExtension)           │
│             ├─ registerTool(todo)  （无状态工具）     │
│             │   execute:                            │
│             │    ctx.sessionManager.getBranch()      │
│             │      → replayTodo() 重建当前快照        │
│             │      → 纯 reducer 应用变更              │
│             │      → 返回 AgentToolResult            │
│             │        content = 文本摘要（给模型）       │
│             │        details = 完整快照（落盘+给UI）   │
│             └─ （无需生命周期 hook——状态在对话里）      │
│                                                      │
│  IPC: pi:getTodoSnapshot(sessionPath)               │
│       → 扫该会话 .jsonl 最后一条 todo details         │
└────────────────────────────────────────────────────┘
          │ 现有 pi:event（tool 条目按 sessionPath 累积）
          ▼
┌──────────── 渲染进程 ─────────────────────────────┐
│  useAgentSession.onEvent → 当前会话出现 todo 工具活动 │
│      → todo-store.ts fetchTodo(currentPath)         │
│          （IPC 拉一次全量快照，天然兜底重启/压缩）      │
│      → ChatPanel 右侧 TodoPanel.tsx（只读栏）        │
└────────────────────────────────────────────────────┘
```

**为什么这样设计**（对齐 webSearch 的"无状态"哲学）：

1. **状态权威 = 对话历史本身**。每次成功调用都把全量快照写进 `details` 随 `.jsonl` 落盘；重建只靠 `ctx.sessionManager.getBranch()` 回放（`getBranch`/`getSessionFile` 已在 SDK `ReadonlySessionManager` 上验证）。**主进程无需维护 Map，天然跨重启、跨 compact、跨会话切换**。
2. **不新增推送通道**。渲染端本来就在按 sessionPath 累积每条 tool 事件；看到 todo 工具活动后调一次轻量 IPC 拉快照即可。避免"onSnapshot 回调 + 广播频控 + 窗口生命周期"一整层新基建。
3. **面板只读、无编辑按钮**。编辑权完全归模型（与 rpiv-todo 一致）。

> 代价：每次 execute 重扫 branch。todo 变更频率低（一轮几次），branch 扫描按最后一条命中即返回，开销可忽略。

---

## 3. 文件规划（对齐 webSearch 布局）

```
src/main/pi/todo/
  todo-state.ts        // Task/TodoSnapshot/TodoAction 类型 + 纯 reducer + blockedBy 校验 + replay
  todo-extension.ts    // export const todoExtension: InlineExtension（对齐 web-search-extension.ts 结构）
                       //   + todo 参数 schema（typebox）
                       //   + execute：replay → mutate → return {content, details}
                       //   + todo.enabled 总开关，关闭则不 registerTool
  todo-config.ts       // 读写 ~/.pi/agent/todo-config.json（默认 { enabled: true }，对齐 websearch-config）
src/shared/todo-types.ts        // TodoStatus/TodoTask/TodoSnapshot（主进程 + preload + 渲染端共享）
src/main/pi/session-manager.ts  // 1 行 import + 普通会话 extensionFactories 数组（定时任务数组不动）
src/main/ipc-handlers.ts        // pi:getTodoSnapshot → 读会话文件行解析 → replay
src/preload/index.ts + src/preload/api.d.ts   // 加 getTodoSnapshot 实现与类型
src/renderer/store/todo-store.ts
src/renderer/store/ui-store.ts      // + todoPanelOpen（右侧栏显隐，对齐 terminalOpen）
src/renderer/chat/ChatPanel.tsx     // 改为 flex row：主消息列 + 右侧 TodoPanel 列
src/renderer/chat/TodoPanel.tsx + TodoPanel.module.css
src/renderer/hooks/useAgentSession.ts   // 订阅：聚焦会话有 todo 工具活动 → fetchTodo
```

### 3.1 扩展壳（真实范式，逐字段对齐 web-search-extension.ts）

```ts
// src/main/pi/todo/todo-extension.ts
import { Type } from "typebox";
import { defineTool, type AgentToolResult, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { replayTodoFromBranch, applyTodoMutation, emptyTodoState } from "./todo-state";

const todoParams = Type.Object(
  {
    action: Type.Union([
      Type.Literal("create"), Type.Literal("update"),
      Type.Literal("delete"), Type.Literal("clear"),
    ]),
    tasks: Type.Optional(Type.Array(Type.String({ maxLength: 120 }))), // create 批量内容
    id: Type.Optional(Type.String()),
    content: Type.Optional(Type.String({ maxLength: 120 })),
    status: Type.Optional(Type.Union([
      Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"),
    ])),
    blockedBy: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export const todoExtension: InlineExtension = {
  name: "todo",
  factory: (pi) => {
    if (!readTodoConfigSync().enabled) return; // master switch → 不注册

    pi.registerTool(
      defineTool({
        name: "todo",
        label: "任务清单",
        description:
          "维护当前任务的执行清单：把多步工作拆成任务，随执行推进更新状态（pending/in_progress/completed）。" +
          "开始复杂任务前先 create 全部步骤，每完成一步 update 到 completed。",
        promptSnippet:
          "Maintain a live task checklist for multi-step work: create items upfront, then update their status as you go.",
        promptGuidelines: [
          "对需要 3 步以上的任务，先调用 todo 工具建立完整清单，再逐步执行并同步更新状态。",
          "一次 update 只改一个任务；任务完成立即标记 completed，不要攒到最后。",
        ],
        parameters: todoParams,
        execute: async (_id, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<TodoSnapshot>> => {
          const branch = ctx.sessionManager.getBranch();          // 对话分支（含上次快照）
          const prev = replayTodoFromBranch(branch) ?? emptyTodoState();
          const result = applyTodoMutation(prev, params);          // 纯函数；失败返回 {error}
          if (result.error) {
            return { content: textContent(result.error), details: prev }; // 状态不变，模型自纠
          }
          return {
            content: textContent(renderTodoSummary(result.state)),
            details: result.state,                                 // 完整快照 → 落盘 + 供 UI
          };
        },
      }),
    );
  },
};
```

> `TextContentLike` 类型别名技巧照抄 `web-search-extension.ts:74-81`（避免 import 嵌套包类型）。SDK 字段均已核对：`ToolDefinition{name,label,description,promptSnippet,promptGuidelines,parameters,executionMode,execute}`；`AgentToolResult<T> = { content, details, usage?, terminate? }`。

### 3.2 session-manager.ts 接线（仅两处）

```ts
// import 区（对齐既有 soul/rules/webSearch 常量）
import { todoExtension } from "./todo/todo-extension";

// :1101 普通会话（挂 todo）
extensionFactories: [soulExtension, rulesExtension, webSearchExtension,
                     createSubagentExtension(() => this.webContents, () => this.modelRuntime),
                     todoExtension],
// :2590 定时任务会话（Q4 已定案：不挂 todo，保持原数组不变）
```

---

## 4. 持久化：快照内联 + last-write-wins 回放（沿用 rpiv 核心设计）

每次成功的 `todo` 工具结果把**完整状态快照**塞进 `details`，随会话 `.jsonl` 落盘：

```jsonc
{ "type": "tool_result", "toolName": "todo",
  "content": [{ "type": "text", "text": "✓ 已创建 3 项（0/3）…" }],
  "details": { "tasks": [...], "nextId": 7 } }
```

- **回放**：`replayTodoFromBranch(branch)` 取**最后一条** `toolName === "todo"` 的 `details`（last-write-wins）。读取 `getBranch()` 即可，天然覆盖 `session_start`/`session_compact`/`/reload`/重启后首开——**不需要注册任何生命周期 hook**。
- **约束**：单会话任务 ≤ 20、单条文本 ≤ 120 字符（schema 内 `maxLength` 强制）；超限拒绝并提示先 `clear`/删已完成，控制 token 成本。

---

## 5. 状态机与依赖校验（todo-state.ts，纯函数、可单测）

- 4 态：`pending → in_progress → completed`；`deleted` 是墓碑（保留 `blockedBy` 历史引用，不真删）。

  ```
  pending     → in_progress | completed | deleted
  in_progress → completed   | pending   | deleted
  completed   → in_progress | pending   | deleted
  deleted     →（不可恢复）
  ```

- `blockedBy` 写入前校验（一次 `update` 里全部验证，任一失败整单拒绝、状态不变）：
  1. 引用不存在的任务 id → 拒；
  2. 引用已 `deleted` 任务 → 拒；
  3. 自环 `A blockedBy A` → 拒；
  4. 成环 `A→B→C→A`（`detectCycle`，对 blockedBy 有向图 DFS）→ 拒。
- 失败信息经工具 `content` 内联返回给模型（能读到并自纠），**不抛异常**、不打断对话。

---

## 6. 渲染端

### 6.1 todo-store.ts（zustand）

```ts
// todos: Record<sessionPath, TodoSnapshot | null>
// actions:
//   fetchTodo(path)     // window.piDesk.getTodoSnapshot(path) → 写 store
//   clearTodo(path)     // 会话删除/关闭清理
```

触发：`useAgentSession.onEvent` 里检测**当前聚焦会话**出现 todo 工具相关条目（`tool_call`/`tool_result` 带 `todo`）→ `fetchTodo(currentPath)`。会话切换/加载时对目标 path 也补一次 `fetchTodo`（重启兜底 + 右侧栏跟随会话显示各自清单）。

### 6.2 TodoPanel.tsx（+ module.css）—— 聊天区右侧独立栏（Q3 定案）

**布局落点**：`ChatPanel` 内部改为横向两列——左列 = 现有内容（空态/消息列表 + ChatComposer），右列 = `TodoPanel`。右列**只在聊天视图存在**（ChatPanel 随 `mainView==="chat"` 显隐），不污染 Settings/Skills 等页面；与 `FilePreviewPanel`/`TerminalPanel` 那种跨视图常驻列是不同语义（Todo 绑定当前会话，非全局工具区）。

**开关与尺寸**：`ui-store` 新增 `todoPanelOpen: boolean`（默认关）+ `setTodoPanelOpen`；固定宽 ~280px，不拖拽（保持简单）。面板为空或全部 `deleted` 时**整列自动隐藏**，避免常驻空列占用右侧空间（模型建了清单才出现）。

**重开入口（v4.2，Titlebar 开关）**：面板关闭后由**标题栏右侧的 Todo 按钮**（ListTodo 图标）重开——它常驻在**搜索与终端按钮中间**（`layout/Titlebar.tsx`，复用 `iconBtn`/`iconBtnActive` 样式），**仅当聚焦会话存在 live 清单时显示**（与面板"有内容才出现"对齐，无清单会话不出现、不误点），`active` 高亮即面板展开中。点击 = 开/关面板。`todo-store` 记 per-session `dismissed` 标记：**用户手动关闭（X 或按钮）后模型后续更新不再 auto-open 弹回**（尊重用户意图），按钮重开才清除标记；auto-open 只在未 dismissed 时生效。

UI（沿用 token 体系与"干净极简"偏好，无动画/无 hover 位移）：
- 面板头：`待办 2/5`（计数）+ 折叠按钮（已完成▶ / 展开▼）+ 关闭按钮。
- 行：状态点（pending=灰描边 / in_progress=绿脉冲 / completed=实心绿）+ 文本 + `blockedBy` 时右侧灰字 `↳ 依赖 #id`。
- 折叠时只显 `pending`/`in_progress`；展开全显；超 ~8 行把最早 `completed` 收起为 `+N more`。
- 只读，无编辑按钮。

### 6.3 IPC 面（新增一个）

| 通道 | 方向 | 说明 |
|---|---|---|
| `pi:getTodoSnapshot(sessionPath)` | 渲染 → 主 | `handle` 读该会话 `.jsonl` → `replayTodoFromBranch` → 返回快照或 null。主进程可直接复用 `todo-state.ts` 的 replay |

---

## 7. 低配模型适配

1. 工具描述前两行给出调用时机（§3.1），不给长篇讲解。
2. `promptGuidelines` 静态注入（随工具注册进系统提示词）——**不走 `before_agent_start` 改写**，避免每轮 prompt 缓存失效（`web-search-extension.ts` 头部注释明确此约束，必须遵守）。
3. `todo.enabled` 总开关可整体关闭（对齐 webSearch master-switch）。

---

## 8. 开放问题（全部定案）

| # | 问题 | 定案 |
|---|---|---|
| Q1 | 纯逻辑是否借鉴 rpiv-todo 的 reducer/环检测实现（MIT，文件头注明出处）？ | ✅ 借鉴算法，按本项目风格自写（2026-09-03 获批） |
| Q2 | `todo.enabled` 默认**开**还是**关**？ | ✅ **默认开**（2026-09-03 定案） |
| Q3 | 面板形态？ | ✅ **聊天区右侧独立栏**（2026-09-03 定案，见 §6.2） |
| Q4 | 定时任务会话是否也挂 `todoExtension`？ | ✅ **不挂**（2026-09-03 定案），仅普通/空间会话挂 |
| Q5 | 任务数 ≤20、文本 ≤120 的上限？ | ✅ 按建议值：schema `maxItems`/`maxLength` + reducer 双重强制（2026-09-03 获批） |
| Q6 | 渲染端快照来源用「IPC 拉取」方案（本文）可接受？ | ✅ 推荐方案；不新增推送通道（2026-09-03 获批） |

---

## 9. 实施步骤（首版）

1. `src/main/pi/todo/todo-state.ts`：类型 + reducer + 校验 + replay（纯 TS，零依赖）。
2. `src/main/pi/todo/todo-extension.ts`：对齐 `web-search-extension.ts` 范式注册工具。
3. 接线：`session-manager.ts` import + 两处数组；`ipc-types.ts`/`preload`/`ipc-handlers.ts` 加 `pi:getTodoSnapshot`。
4. 渲染端：`ui-store` 加 `todoPanelOpen` → `todo-store.ts` → `ChatPanel` 改双列 + `TodoPanel.tsx` + css → `useAgentSession` 事件触发 fetch。
5. 验证：`tsc` 双检查 → 用户 rebuild → 让模型执行多步任务观察面板逐项推进 → `/compact` 后确认清单仍在 → 重启后重开该会话确认仍在。

---

## 附录：rpiv-todo 设计要点摘录（借鉴项）

- 工具执行 = `applyTaskMutation(state, action, params)` 纯 reducer → `commitState` → 结果 `content` 给模型、`details` 全量快照。
- 重建状态 = 遍历分支取最后一条 `toolName === "todo"` 的 `details`（last-write-wins），因此扛 `/reload` 与压缩。
- 状态隔离按会话（rpiv 用 sid；本项目统一用 `sessionPath`，`getSessionFile()` 可拿）。
- 其 TUI overlay / `registerCommand("/todos")` / jiti 懒加载 / i18n 软依赖——**本项目一律不采用**（React 面板代替 TUI；命令与懒加载无必要）。
