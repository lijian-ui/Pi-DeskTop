# ask_user_question 功能开发文档（pi-desktop）

> 状态：**v1 —— 已实现**（主进程 + 渲染端落地，双 `tsc` 静态检查 EXIT=0；待用户 rebuild 实机验证）
> 参考实现：[`@juicesharp/rpiv-ask-user-question`](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question) v2.9.0（MIT）——**仅借鉴 schema / 校验 / envelope / details 设计，不引入该包、不装任何扩展**。
> 四象限拍板（2026-09-03 用户定案，详见 §7）：
> ① **UI 形态** = 类似消息列队的样式，在输入框上方弹出（与 BashApproval 同槽位）；
> ② **功能范围** = 完整档（单选/多选 + 选项说明 + 自由输入行 + 每题备注 + 选项 markdown preview + 全局备注 + 统一提交/取消）；
> ③ **挂载范围** = 与 Todo 一致，仅普通/空间会话挂，定时任务会话不挂；
> ④ **取消语义** = 声明式 DECLINE（模型收到标准"用户已取消"文案，自行降级）。

---

## 0. 集成方式（定案）

**第一方代码内联集成，与 `todoExtension`、`webSearchExtension`、`createSubagentExtension` 完全同一机制**：

- `ask_user_question` 是 pi-desktop **自己代码库里的常驻工具扩展**（`src/main/pi/ask-user/`），随桌面应用构建发布；
- 经 `extensionFactories` 注入 SDK（`session-manager.ts:1103` **普通会话数组**），**定时任务数组（:2592）不动**——cron 运行没有人在屏幕前作答；
- 由 `askuser-config.json`（`~/.pi/agent/`，与 `todo-config.json`/`websearch-config.json` 同模式）的 `enabled` 做总开关（**默认开**），关掉时工具根本不注册；扩展在每次 execute 时同步重读该文件，改配置免 reload。

> **为什么走扩展机制而非别的通道**：`pi.registerTool` 只存在于 extension factory 内（SDK 约束，webSearch/todo/子代理已验证）——这是**不动 SDK 源码**（项目铁律）前提下给模型加工具的唯一入口。

---

## 1. 功能定义

### 1.1 它是什么

模型在执行过程中**暂停**，向用户提出 1-4 个结构化问题（每题 2-4 个带说明的选项，单选或 `multiSelect` 多选）；桌面端在**输入框上方**弹出一张问卷卡片（消息列队样式，可排队）；用户作答（或整体取消）后，答案以结构化 envelope 回传模型，agent loop 继续。

与既有机制的区分：

| | 聊天文本直接问 | Bash 审批 | ask_user_question |
|---|---|---|---|
| 时机 | 任意 | 模型要跑危险命令 | 需求含糊、缺决策无法继续 |
| 阻塞 | 不阻塞（异步看） | 阻塞到放行/拒绝 | 阻塞到作答/取消 |
| 答案形态 | 自由文本 | 二元放行 | 结构化：多选一/多选多/自由输入 + 备注 |
| 用户价值 | — | 安全护栏 | 决策外包：不替用户猜偏好/方案 |

### 1.2 用户价值

- **决策不靠猜**：模型把含糊需求、方案取舍、偏好选择明确抛给用户，避免在错误方向上烧 token。
- **对比真实产物**：选项可带 markdown `preview`（界面原型/代码片段/配置示例），选中即渲染预览，用户比较的是真实产物而非标签文字。
- **低配模型友好**：决策外包给用户 + 描述里写清调用时机，Qwen3-4B 这类小模型也能正确使用。

---

## 2. 总体架构：execute 同步等待 + 自有 IPC 卡片队列

```
┌──────────── 主进程 ─────────────────────────────────────────────┐
│  session-manager.ts                                              │
│   普通会话 extensionFactories: […, todoExtension,                │
│                                  createAskUserExtension(          │
│                                     () => this.webContents)]      │
│        └─ ask-user-extension.ts（InlineExtension）                │
│             ├─ registerTool(ask_user_question)                    │
│             │   execute: 校验 → 取 sessionPath → hasActive 守卫    │
│             │     → id=uuid → send("pi:askUserPrompt", …)         │
│             │     → await waitForAnswer(id, sessionPath, signal)  │
│             │         ║  resolve 于：① 用户作答/取消（registry）    │
│             │         ║             ② ctx.signal abort            │
│             │         ║             ③ 10 分钟超时                 │
│             │     → 非用户路径补发 "pi:askUserClosed" 让卡片消失    │
│             │     → buildEnvelope(answered|DECLINE) 返回给模型     │
│             └─ ask-user-registry.ts（pendingBySession Map）        │
│  ipc-handlers: pi:askUserAnswer → tryAnswerAskUser → resolve       │
└──────────────────────────────────────────────────────────────────┘
          │ webContents.send("pi:askUserPrompt", {id, sessionPath, questions})
          ▼
┌──────────── 渲染进程 ────────────────────────────────────────────┐
│  askUser-store.ts（cards: id → {payload, drafts[], globalNote,    │
│                                 submitting}）                     │
│  AskUserPanel.tsx（ChatComposer 内、<BashApprovalModal/> 旁，      │
│    输入框上方）→ 仅渲染 sessionPath === currentPath 的那张卡       │
│    → 作答/取消 invoke("pi:askUserAnswer", payload)                 │
└──────────────────────────────────────────────────────────────────┘
```

### 为什么"暂停"可行（调研核心结论）

rpiv 并没有发明暂停机制——它利用 SDK 工具 `execute` 的**异步等待语义**：`execute` 内 `await` 一个用户交互 Promise，用户在宿主界面作答/取消后才 resolve 返回 tool result，**agent loop 自然停在原地**。本实现沿用同一语义，只是把"宿主界面"换成我们自己的 IPC 卡片：

- 主进程 `execute` 里 `await waitForAnswer(...)`，期间 agent loop 阻塞、模型不发新动作；
- 渲染端作答 → `invoke("pi:askUserAnswer")` → registry 找到该 id → resolve → envelope 返回 → 模型继续。

### 终止安全（三路 resolve）

`execute` 等待的 Promise 只可能被三件事 resolve，**杜绝 agent loop 永久挂起**：

1. **用户作答/取消**：renderer 提交 `pi:askUserAnswer`（registry 先删条目再 resolve）；
2. **abort**：`ctx.signal`（停止按钮/会话 teardown/切会话）→ `clearAskUserForSession` → settle `{cancelled:true}`；
3. **10 分钟超时**：渲染端已死/用户走开时兜底（对齐 bash 审批 5 分钟超时的安全网思路，问卷更复杂故取 10 分钟）。

2/3 两路都会在 settle 后补发 `pi:askUserClosed`，渲染端据此丢弃可能还挂着的卡片（ghost 清理）。

---

## 3. 调研结论摘要（rpiv 与桌面的差异）

rpiv v2.9.0 问卷交互按宿主分三条路：

1. **TUI**：`ctx.ui.custom()` 渲染问卷组件；
2. **RPC**：`ctx.ui.select()/input()` 逐个弹原生对话框；
3. **非交互**：`reconcile` 在 `before_agent_start` 把工具从 active tools 摘掉（无 UI 环境不暴露）。

**pi-desktop 的实情（SDK v0.84.4 已核实）**：桌面是 headless Electron 嵌 SDK，`createAgentSessionServices` options **没有 UI 注入点**，runner 默认 `mode="print"`、`ui = noOpUIContext`、`hasUI = false`。noOp 的 `custom/select/input` 全部 `async () => undefined` —— 意味着若不补 IPC 通道，rpiv 的 TUI/RPC 两路在桌面**全走不通**（execute 会立刻拿到 `undefined`，"看似成功实为空"）。因此必须自研回传通道，复用 BashApproval 的 `webContents.send → invoke → resolve` 模式（区别：Bash 是"放行/拒绝"二元，这里是结构化问卷，且按 sessionPath 路由、每个会话同时最多一张卡）。

**可照搬部分全部照搬**：schema 硬上限、保留词守卫、校验顺序、envelope 文案结构、`details` 落盘结构（与 Todo 同款"结果内联可回放"哲学），均忠实移植并注明 MIT 出处。

---

## 4. 文件规划（已全部落地）

```
src/shared/ask-user-types.ts          // 双端共享纯类型 + 上限常量 + IPC payload + isAskUserResult 守卫
src/main/pi/ask-user/
  ask-user-core.ts                    // typebox schema + 运行时校验 + envelope 构建（纯逻辑，零 SDK，MIT 注明）
  ask-user-registry.ts                // pendingBySession Map（key=sessionPath）+ register/tryAnswer/clear
  ask-user-config.ts                  // ~/.pi/agent/askuser-config.json，默认 { enabled: true }
  ask-user-extension.ts               // createAskUserExtension(getWebContents) → registerTool + execute + waitForAnswer
src/main/ipc-handlers.ts              // ipcMain.handle("pi:askUserAnswer", …) → tryAnswerAskUser
src/main/pi/session-manager.ts        // import + 普通会话数组(:1103) 追加 createAskUserExtension
src/preload/index.ts + api.d.ts       // onAskUserPrompt / onAskUserClosed / answerAskUserQuestion
src/renderer/store/askUser-store.ts   // 卡片 + 草稿 + submit/cancel
src/renderer/chat/AskUserPanel.tsx + AskUserPanel.module.css   // 队列式问卷卡 UI
src/renderer/chat/ChatComposer.tsx    // <AskUserPanel /> 挂载于 <BashApprovalModal /> 旁
```

### 4.1 关键实现要点

**schema 硬上限（typebox，工具边界强拒）**：`questions` 1–4；`header` ≤16 字符；选项 `label` ≤60 字符；每题 `options` 2–4 个；`multiSelect`/`preview` 可选。

**运行时校验顺序（忠实镜像 rpiv）**：`no_questions` → `too_many_questions` → `duplicate_question` → `empty_options` → **`reserved_label` 先于 `duplicate_option_label`**。保留词 = `["Other", "Type something.", "Next"]`——UI 会自动追加"自定义回答"行，模型若自己写等价标签会撞车。

**decline / envelope 文案（中文，随 Todo 惯例）**：
- 取消：`用户已取消作答（未回答任何问题）。不要假设答案，请按你的最佳判断继续，或向用户说明你需要的决策。`
- 已回答：`用户已回答你的问题： "Q"=A。选中预览：…。用户备注：…。 全局备注：…。 现在可以带着用户的回答继续。`
- `details` = `AskUserResult{answers[], cancelled, globalNote?}` 随 tool result 落盘（同 Todo 快照回放哲学）。

**execute 全流程**（错误全部经工具 content 内联返回，不抛异常）：
1. `enabled` 关 → 内联提示改用聊天文本；
2. `validateAskUserQuestionnaire` 失败 → 内联错误串；
3. `ctx.sessionManager.getSessionFile()` 为空 → 内联提示；
4. `hasActiveAskUser(sessionPath)` → 该会话已有问卷在等，拒重复；
5. 发 `pi:askUserPrompt`（webContents 未就绪 → 内联提示）；
6. `await waitForAnswer(id, sessionPath, ctx.signal)`；
7. 非用户路径补发 `pi:askUserClosed`；最后 `buildAskUserToolResult(buildAskUserEnvelope(result, typed), result)`。

**waitForAnswer**：`registerAskUser` 的 resolve 包一层标 `answeredByUser: true`；`signal` 已 abort 立即走 onAbort，否则注册 `once` 监听；`setTimeout(ASK_USER_TIMEOUT_MS = 10min)` 兜底；三路共用 `settle()` 幂等收口（清 timer、摘监听、resolve 一次）。

---

## 5. IPC 面（共 3 条）

| 通道 | 方向 | 载荷 | 说明 |
|---|---|---|---|
| `pi:askUserPrompt` | 主 → 渲染（send） | `{id, sessionPath, questions}` | 问卷到达，渲染端入队（仅焦会话的那张显示） |
| `pi:askUserAnswer` | 渲染 → 主（invoke/handle） | `{id, cancelled, answers?, globalNote?}` | 用户作答或取消；返回 boolean（false = ghost，已在他处 settle） |
| `pi:askUserClosed` | 主 → 渲染（send） | `{id}` | 无用户动作关闭（abort/超时），丢弃卡片 |

---

## 6. 渲染端

### 6.1 askUser-store.ts（zustand）

- `cards: Record<id, {payload, drafts[], globalNote, submitting}>`；草稿按卡片存，**切会话/切页不丢半成品**。
- `upsert`：同 id 已存在则**不覆盖**（防刷新把用户正在填的草稿冲掉）；`onAskUserClosed` → `remove`。
- `submit(id)`：由草稿构建答案数组 → 全部未答且无全局备注时**等价于取消**（`cancelled:true`、不带 answers）→ `answerAskUserQuestion` → `finally remove`（IPC 返回 false 说明是 ghost，卡片也该丢）。
- `cancel(id)`：`{id, cancelled:true}`（已写的全局备注仍随 payload 传给主进程，落 `details` 供回放）→ `finally remove`。
- 单选 → option label（选中项带 preview 时回传）；多选 → labels；"自定义回答"有字 → `kind:"custom"` 优先于选项；每题 `notes` 非空 → `answer.notes`。

### 6.2 AskUserPanel.tsx（队列式卡片，输入框上方）

- **挂载点**：`ChatComposer.tsx` 顶层 `<div className={styles.composer}>` 内、`<BashApprovalModal />` 正下方——即**消息区与输入框之间、输入框上方**的浮层槽位（Bash 审批同款）。
- **路由**：仅渲染 `sessionPath === currentPath` 的卡片；平行会话各自持卡（store 里待答/被 closed）。
- **完整档能力**：每题 2–4 个原生 radio/checkbox 选项（选中态品牌绿描边）；选项下说明文字；单选选中带 `preview` 的项渲染 `<Markdown>` 预览框；"自定义回答…"自由输入行（进入后清空选项勾选）；每题 StickyNote 备注（图标亮起表示已写）；页脚"添加整体备注"折叠 textarea；`N/M 已作答` 进度、放弃按钮、主色"提交回答"按钮；header 右侧 X = 放弃（DECLINE），header 内 HelpCircle + "模型正在等待你的回答" + N 个问题 badge。
- **CSS**：`AskUserPanel.module.css` 全量走 token 体系（`--bg-base-secondary` 面板、`--bg-overlay-l1/l2` 行与 hover、`--bg-base-tertiary` textarea、`--border-neutral-l1/l2/l3`、`--text-default/secondary/tertiary`、`--text-brand`/`--border-brand`/`--bg-brand` + `--icon-onbrand` 提交钮、`--body-xs/sm/md/base-font-size`、`--font-weight-medium`、`--radius-*`/`--spacer-*`），暗/亮自动适配；**无入场动画、hover 无位移**（仅边框/背景/阴影反馈，符合项目 UI 偏好）。

---

## 7. 开放问题（全部定案）

| # | 问题 | 定案 |
|---|---|---|
| Q1 | 桌面端问卷 UI 用什么形态？ | ✅ **消息列队样式，输入框上方弹出**（与 BashApproval 同槽，2026-09-03 拍板） |
| Q2 | 功能范围取哪档？ | ✅ **完整档**（单选/多选 + 说明 + 自由输入 + 备注 + preview + 全局备注 + 统一提交/取消，2026-09-03 拍板） |
| Q3 | 哪些会话挂该工具？ | ✅ **与 Todo 一致**：仅普通/空间会话（`session-manager.ts:1103`），定时任务会话不挂（:2592 不动） |
| Q4 | 取消/关窗时模型收到什么？ | ✅ **声明式 DECLINE**：标准"用户已取消作答…自行判断"文案，模型自行降级（不注入额外追问） |

---

## 8. 低配模型适配

1. 工具描述前两行交代时机（含糊/需决策/选项对比时用），并列出 4 条用法红线：不要自写 Other/Type something. 等保留词标签、多选设 `multiSelect`、`preview` 仅单选、**不要背靠背堆多次调用**（一次问完；运行时还有同会话 `hasActiveAskUser` 守卫拒重复）。
2. `promptSnippet`/`promptGuidelines` 静态注入（随注册进系统提示词）——**不走 `before_agent_start` 改写**，避免每轮 prompt 缓存失效（web-search-extension.ts 头部注释明确此约束）。
3. `enabled` 总开关（`askuser-config.json`）可整体关闭，与 todo/websearch master-switch 对齐。

---

## 9. 验证指引（用户 rebuild 后手测）

类型检查已通过（主进程 `tsc -p tsconfig.node.json --noEmit`、渲染端 `tsc -p tsconfig.json --noEmit` 均 EXIT=0）。按项目铁律**未跑任何 build/dev/打包**，请用户 rebuild 后按序验证：

1. **基本问答**：让模型执行含糊任务（如"帮我把日志系统改成双写，方案你定"）→ 应弹出问卷卡，答完提交 → 模型按答案继续；
2. **preview**：某题单选且选项带 markdown 示例 → 选中该项出现预览框；
3. **多选 / 自定义 / 备注 / 全局备注**：分别验证入 envelope（可让模型复述收到的答案核对格式）；
4. **DECLINE**：点 X 或"放弃" → 模型应收到取消文案并自行降级继续，卡片消失；
5. **终止安全**：卡片挂着时点停止 → 卡片消失、loop 不挂；卡片挂着不动 10 分钟 → 自动取消；
6. **并发隔离**：两个会话并行各触发一次 → 各自只在自己窗口显示自己的卡，互不干扰；同会话重复触发被拒；
7. **挂载范围**：定时任务运行中模型不持有该工具（无卡片）；
8. **开关**：`~/.pi/agent/askuser-config.json` 改 `enabled:false` → 模型调用时收到"未启用，改用聊天文本"提示。

---

## 附录：rpiv-ask-user-question 设计要点摘录（借鉴项）

- 工具执行 = 校验问卷 → 宿主 UI 呈现 → `await` 用户作答 → 结构化答案组 envelope 返回模型；**不是**伪造"暂停/恢复"API。
- Schema 用 typebox 硬上限（数量/长度），模型超限请求在工具边界被拒并内联报错，模型自纠。
- 运行时保留词守卫（`Other`/`Type something.`/`Next`）且**先于**重复标签校验——UI 自动追加自由输入行，模型不得自造。
- 取消语义 = 声明式：给模型一句标准话术（不假设答案），把"要不要继续"交给模型判断。
- `details` 落结构化结果（同本项目 Todo 的"快照内联"哲学）——取消/备注等旁路信息也能随历史回放。
- 其 TUI overlay / RPC select / 非交互 reconcile 摘除——**本项目一律不采用**：桌面无 ctx.ui，自研 IPC 卡片队列（§2）；reconcile 摘除方案对 headless 桌面无意义（用户本来就在屏幕前）。
