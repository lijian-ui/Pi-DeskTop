# Pi Desktop 代码审查报告：性能瓶颈与潜在 Bug

> 审查范围：`src/main`（会话/终端/进程管理）、`src/renderer`（状态层/聊天链路/UI）、`src/preload`（IPC 桥）
> 日期：2026-07-31
> 结论：整体架构清晰（cwd 级并发模型、single-flight 缓存、per-session 绑定都做得扎实），但存在 **1 个会直接卡 UI 的流式渲染瓶颈** 和 **若干并发/状态竞态 Bug**，建议按优先级处理。

---

## ✅ 修复记录

| 项 | 状态 | 说明 |
|----|------|------|
| P0-1 流式渲染 memo | ✅ 已修复（12:45） | Markdown/消息组件 memo + 模块级插件常量 + 空 delta 短路 |
| P2-11 硬编码 getProviders | ✅ 已修复（12:50） | 死代码，删除 IPC handler + preload + 类型声明 |
| P2-12 deleteSession 无保护 | ✅ 已修复（12:50） | 主进程拒绝删除运行中会话（仅查 runningPath），渲染层补 catch |
| P2-13 流式事件双重序列化 | ✅ 已修复（12:50） | 删 serializeEvent，直接传引用（IPC 自身结构化克隆） |
| P2-14 watcher 全目录链 | ✅ 已修复（12:50） | 只 watch agentDir + cwd + 存在 context 文件的祖先 |
| P2-15 队列依赖 agent_settled | ✅ 确认无 bug | SDK `agent-session.js:761` 在每条 prompt 的 finally 都 emit agent_settled，逐条消化成立 |
| P2-16 切视图卸载 ChatPanel | ✅ 已修复（12:50） | ChatPanel 常驻 + CSS 隐藏切换，滚动位置/流式保留 |
| P2-17 activate 不重绑 | ✅ 已修复（12:50） | 抽 bindEventTargets 复用；tray/dialog 改动态解析当前窗口 |
| P1-2 runningPath 竞态 | ✅ 已修复（13:15） | `RuntimeUnit.runSeq` 序号 + prompt finally 归属校验；abort 不再清 runningPath（统一由 prompt finally 负责） |
| P1-3 debounce 跨 cwd 丢失 | ✅ 已修复（13:15） | `contextFileDebounce` 改 `Map<cwd, timer>` |
| P1-4 getState 深拷贝 | ✅ 已修复（13:15） | 去掉 JSON 深拷贝，直接返回引用（IPC 自动克隆） |
| P1-5 bash 正则重编译 | ✅ 已修复（13:15） | `compileBashPatterns()` 预编译，config 变更时重建；非法 pattern 编译期丢弃 |
| P1-6 message_end 全量 load | ✅ 已修复（13:15） | `scheduleSessionListReload()` 500ms 节流合并 burst |
| P1-7 文件预览无虚拟化 | ✅ 已修复（13:15） | >800 行启用行窗口虚拟化（固定行高 19.2px + overscan 50）；`lines` split 改 useMemo；`lineOf` 改计数扫描 |
| P1-8 搜索乱序竞态 | ✅ 已修复（13:15） | AtFilePicker 搜索加序列号守卫，过期回复丢弃 |
| P1-9 searchWorkspace 无取消 | ✅ 已修复（13:15） | 3s 时间预算 + `event.sender.isDestroyed()` 提前中断 |
| P1-10 终端复用忽略 cwd | ✅ 已修复（13:15） | TerminalHandle 记录 cwd，复用条件加 `resolve(cwd)` 一致校验 |

---

## 🔴 P0 — 必须修复

### 1. 流式输出时聊天列表全量重渲染（无 memo），长会话直接卡死

**链路（每个 token 触发一次）：**

```
IPC pi:event (message_update)
  → useAgentSession.reduceMessageEvent()  msgs.map() 全量数组复制  O(n)
  → session.mutateBuffer()                new Map(messagesByPath)  O(会话数) + setMessages() 又一次 set
  → MessageList 重渲染（订阅 s.messages）
  → 所有可见 UserMessage / AssistantMessage / ToolExecution 重渲染 —— 全部无 React.memo
  → 每条消息的 <Markdown> 重新执行 ReactMarkdown 解析 + rehype-highlight 高亮
```

**涉及文件：**
- `src/renderer/hooks/useAgentSession.ts` L74-88（`message_update` 每次全量 map）
- `src/renderer/store/session-store.ts` L469-482（`mutateBuffer` 全量复制 Map + 双次 set）
- `src/renderer/chat/MessageList.tsx` L252-272（无 memo 的列表渲染）
- `src/renderer/chat/AssistantMessage.tsx` / `UserMessage.tsx` / `ToolExecution.tsx` / `Markdown.tsx`（**均未用 `React.memo`**）

**影响：** 可见 50 条消息时，每个流式 token 都要重跑几十次 Markdown 解析 + 语法高亮 + Mermaid 判定，长时间回答（尤其含大代码块）时主线程持续高负载，UI 掉帧、输入卡顿。这是本代码库最大的性能瓶颈。

**建议：**
1. `Markdown` 用 `memo()` 包一层（content 不变则跳过解析）——收益最大、改动最小。
2. `AssistantMessage` / `UserMessage` / `ToolExecution` 用 `memo` + 自定义比较器：只比较实际渲染字段（`content`、`thinking`、`isStreaming`、`timestamp`、`stoppedByUser`、`toolExecutions` 的引用/长度），忽略每次 set 产生的新对象。
3. 更彻底：把正在流式的那一条消息单独渲染，历史消息全部 memo；或对 `mutateBuffer` 做"仅当 delta 非空时 set"。

---

## 🟡 P1 — 应该修复

### 2. `prompt()` / `abort()` 的 runningPath 竞态（unbalanced finally）

**位置：** `src/main/pi/session-manager.ts` L919-926、L949-958

两个方法都在 `finally` 里无条件 `unit.runningPath = null`。场景：

1. 任务 A 在 cwd X 运行 → 用户点停止 → `abort()` 清空 `runningPath`
2. 用户立即发送任务 B（同 cwd 同会话，busy 检查通过）
3. **A 的 `prompt()` finally 执行，把 B 的 `runningPath` 清掉**
4. 结果：状态栏/停止按钮消失；此时再发任务 C 会绕过 busy 检查，同一 cwd 双任务并发

**建议：** 用"本次任务的 token/序号"做归属校验，`finally` 里只清自己设的（`if (unit.runningPath === myPath) unit.runningPath = null`），或将 runningPath 管理收敛到单一入口方法。

### 3. 全局 `contextFileDebounce` 导致跨 cwd 的 AGENTS.md 失效丢失

**位置：** `src/main/pi/session-manager.ts` L539、L720-733

`contextFileDebounce` 是**单实例**。两个不同 workspace 的 AGENTS.md/CLAUDE.md 在 300ms 窗口内先后修改时，前一个 cwd 的回调被 `clearTimeout` 取消 → **前一个 cwd 的 services 缓存永远不失效**，该工作区继续用旧上下文注入模型。

**建议：** debounce 改为 `Map<cwd, timer>`。

### 4. `getState()` 每次 IPC 全量深拷贝整个消息历史

**位置：** `src/main/pi/session-manager.ts` L1648-1656

`JSON.parse(JSON.stringify({ ... messages }))` 把 SDK 全部消息深拷贝一次，随后 Electron IPC 结构化克隆又拷贝一次——双重开销。会话越大越慢，而 `reloadMessages`（切换会话/刷新）、`createNew`、`handleSelectModel` 都会调用。

**建议：** 只返回渲染所需的最小投影（`id/role/content/thinking/stopReason/timestamp` + toolExecutions 摘要），或直接返回引用交给 IPC 克隆。

### 5. `evaluateBash` 每次命令都重新编译全部正则

**位置：** `src/main/pi/session-manager.ts` L1137-1160

blacklist（约 60 条）+ whitelist 每次 bash 调用都 `new RegExp(...)` 全量重编译。预编译为模块级缓存即可（config 变更时重建）。

### 6. 消息结束触发的 `load()` 全量扫描会话

**位置：** `src/renderer/hooks/useAgentSession.ts` L195-198

每个 `message_end` 都调 `useSessionStore.load()` → 主进程 `listSessions()` 遍历所有会话目录读文件头。会话多时，**每次回复结束都做全量磁盘 IO**。

**建议：** 只增量更新当前会话的 `messageCount/firstMessage/modified`，或对 `load()` 做节流（如 1s）。

### 7. FilePreviewPanel 大文件逐行渲染，无虚拟化

**位置：** `src/renderer/chat/FilePreviewPanel.tsx` L359-379

文本模式下 `lines.map(...)` 为**每一行**渲染一个 flex 行 div。1MB 上限的文本 ≈ 上万行 DOM，打开大文件直接卡。另有 `lineOf()`（L80-81）`content.slice(0, charIndex).split("\n")`——每次选择都做 O(n) 大数组分配。

**建议：** 虚拟滚动（行窗口渲染）；`lineOf` 改为预计算行偏移数组或计数扫描。

### 8. AtFilePicker 搜索结果乱序竞态

**位置：** `src/renderer/chat/AtFilePicker.tsx` L92-111

debounce timer 被 clear 只取消"未发出"的请求；**已在途的 IPC 请求回来后会无条件 `setResults`**，可能把旧查询结果覆盖到新查询上（输入 200ms 内连打两字即触发）。

**建议：** 请求序列号守卫（只接受最新请求的结果）或 AbortController。

### 9. `pi:searchWorkspace` 无取消 / 无超时

**位置：** `src/main/ipc-handlers.ts` L367-415

DFS 深度 8，无超时、无取消。大仓库一次搜索可长时间占用主进程磁盘 IO；连续输入时多个搜索叠加。

**建议：** 加超时（如 3s）与"新请求抢占旧请求"标志；`sender` 销毁时中止。

### 10. TerminalManager `create()` 复用逻辑忽略 cwd

**位置：** `src/main/pi/terminal-manager.ts` L98-100

只要 shell 相同就复用现有 PTY，**即使调用方传了不同的 cwd**。用户切换到另一 workspace 后打开终端，仍附着在旧工作目录；且 TerminalPanel 常驻（`attachPty` 只在挂载/切 shell 时跑），切 workspace 后终端不会重定向。

**建议：** `create()` 比较 cwd，不一致则重建 PTY；或在渲染层监听 cwd 变化显式重建。

---

## 💭 P2 — 值得注意

### 11. `pi:getProviders` 硬编码 `"openai"`

`src/main/ipc-handlers.ts` L117：写死 openai，未走 `getAllProvidersInfo()`。若该接口已被 ModelsPage 取代，建议删除以免误导。

### 12. `deleteSession` 无运行态保护

`src/main/pi/session-manager.ts` L1329-1342：可删除**正在运行**的会话文件——Windows 上大概率 EPERM 被吞，但一旦成功会破坏流式写入。建议先检查 `runningPath`。

### 13. 流式事件双重序列化

`session-manager.ts` L1865-1867：每个流式事件 `JSON.parse(JSON.stringify(event))` 后经 IPC 再克隆一次。高频率事件可改浅拷贝白名单字段。

### 14. 每个 workspace 的 fs.watch 覆盖整条目录链

`session-manager.ts` L686-718：从 cwd 到 fs root 每层装一个 watcher。多 workspace 时句柄数 = Σ目录深度，Windows 上句柄资源吃紧。可只 watch「cwd + agentDir + 实际存在 AGENTS.md 的祖先目录」。

### 15. 队列消化依赖 `agent_settled` 事件

`useAgentSession.ts` L255-258：`drainQueue()` 每次只取 `messageQueue[0]`，靠下一个 `agent_settled` 事件驱动。**需确认 SDK 的 `agent_settled` 是否每条 prompt 结束都触发**；若只在全部收敛时触发一次，队列会只发第一条、其余卡死。

### 16. 主视图切换卸载 ChatPanel，滚动位置丢失

`MainPanel.tsx` L46-54：切到设置/技能视图时 ChatPanel 卸载，切回后 MessageList 重挂载并 `scrollTop = scrollHeight` 跳到底部。会话消息已存 store 不丢，但阅读位置丢失。

### 17. `app.on("activate")` 重建窗口不重绑事件目标

`src/main/index.ts` L38-42：正常流程不可达（close 被拦截隐藏到托盘），但若走到，新窗口不会重新 `setEventTarget`/`registerIpcHandlers`，dialog 会挂到已销毁窗口。

---

## ✅ 做得好的地方（值得保持）

- **cwd 级并发模型 + per-session 归属**：`units` Map + `runningPath` 串行化 + services 按 cwd 缓存复用，`createAgentSessionServices` 的同步重活只在首次构建，设计正确。
- **context-usage 的 single-flight + tombstone**：`contextUsageLoadPromise` 共享加载、`deletedContextUsageIds` 防止复活、一次性孤儿 GC——并发正确性考虑得很细。
- **bash 守卫的 per-unit 隔离**：`allowAllSession`/`pendingBashRequests` 按 cwd 隔离，黑名单先于白名单执行，denial 计数防模型死循环。
- **消息缓冲双写**：背景会话实时累积到 `messagesByPath`，聚焦时零重载——流式体验设计良好。
- **懒加载意识**：MessageList 窗口化渲染、文件树逐级加载 + 1000 上限、1MB/10MB 文件预览上限、`searchWorkspace` 深度上限，都有防护。
- **终端常驻 + 隐藏不卸载**：PTY 生命周期管理（显式 kill / onExit 清理 / dispose 兜底）正确。

---

## 优先处理顺序建议

1. **P0-1 流式渲染 memo 化**（收益最大，改动集中）→ 顺带 P1-4（getState 投影）
2. **P1-2 runningPath 竞态** + **P1-3 debounce 按 cwd**
3. 其余按投入产出比排期；P2 项可随重构顺带清理

---

# 第二轮审查（Round 2，2026-07-31 13:45）

> 覆盖：设置面板（SettingsPanel/AddProviderPicker/ModelsPage/ContextPage/SoulSettings/SecurityPage/ThemeSettings）、主进程杂项（app-updater/menu/soul/soul-extension）、技能与自动化（SkillsPanel/SkillDetailModal/AutomatePage）、安全交互（BashApprovalModal/bashGuard-store/update-store/ThemeProvider/AboutDialog）。

## 🔴 R2-1 — Bash 黑名单可被命令拼接绕过（安全）

**位置：** `SecurityPage.tsx` L10-88（默认黑名单）+ `session-manager.ts` `evaluateBash`（`^(?:pattern)$` 整行锚定）

黑名单 pattern 全部以 `^(?:…)$` 精确匹配**整条命令**，但 `\S*` 不能跨分隔符：

```
rm -rf / && echo hi        ← 不匹配（`/\S*` 停在空格处，`&& echo hi` 破坏 $ 锚点）
rm -rf /tmp; ls            ← 不匹配
rm -rf /tmp | cat          ← 不匹配
```

产品承诺是「黑名单 always enforced，即使 YOLO 模式」——但拼接命令让黑名单形同虚设，YOLO 下 `rm -rf / && echo hi` 会直接执行。

**修复建议：** `evaluateBash` 先把命令按 `&&` / `||` / `;` / `|` / 换行拆成命令段，**每段独立跑黑名单**（白名单仍按整行）。拆段对 ask 模式无副作用（合法命令各段都不命中黑名单）。

## 🟡 R2-2 — ModelsPage provider 级删除是死代码

**位置：** `ModelsPage.tsx` L38、L98-112、L235-243

`pendingDelete` 从没有任何地方 `setPendingDelete(row)`——provider 行上没有删除按钮，删除确认弹窗永远不弹。用户**无法删除整个自定义 provider**（只能删单个模型）。要么补行内删除入口，要么删掉这段死代码。

## 🟡 R2-3 — Bash 审批弹窗单槽覆盖并发请求

**位置：** `BashApprovalModal.tsx` L16-25 + `bashGuard-store.ts` `setPending`

多 cwd 并发运行时，若两个工作区同时触发命令审批，后到的 `pi:bashApprovalRequest` 直接覆盖 `pending`，**前一个请求永远得不到响应** → 对应 cwd 的模型卡在等待工具结果（无超时、无取消入口）。

**修复建议：** pending 改数组/队列，弹窗逐个处理；或主进程侧对并发审批做排队（一次只发一个）。

## 🟡 R2-4 — app-updater 窗口引用不随重建更新

**位置：** `app-updater.ts` L28、L37-42

`setupAutoUpdater(win)` 只在 whenReady 调用一次，`mainWindow` 捕获创建时窗口。若窗口经 activate 重建（P2-17 修的同路径），`emitState` 因 `mainWindow.isDestroyed()` 静默丢弃——更新状态不再推送到新窗口。与 P2-17 应一致处理：`emitState` 改动态取 `BrowserWindow.getAllWindows()[0]`。

## 🟡 R2-5 — 三个保存表单缺 catch，保存失败静默

**位置：** `ContextPage.tsx` L36-54、`SoulSettings.tsx` L34-44、`SecurityPage.tsx` L114-132

`try { await save } finally { setSaving(false) }` 无 catch——IPC reject 变 unhandled rejection，用户看到按钮弹回但毫无提示，以为保存成功。建议 catch 后展示错误。

## 💭 小项

- **SettingsPanel 校验顺序混乱**（L104-111）：先算 `providerId`/`modelId` 再校验 `formName` 为空——逻辑最终正确但可读性差，易误导后续维护。
- **SettingsPanel 删除无确认**：`handleRemove` 直接删整个自定义 provider（含全部模型），无 ConfirmDialog（ModelsPage 有）。误删风险。
- **自定义/内置判断脆弱**：`handleRemove` 用 `getRegisteredProviderIds().includes(id)` 区分——若自定义 id 撞内置 id（已知坑），会误走 `deleteApiKey` 而非 `deleteCustomProvider`。
- **apiKey 明文落盘** `custom-models.json`（SettingsPanel L121 / AddProviderPicker L250）——桌面本地设计使然，但建议至少标注或后续换加密存储。
- **AddProviderPicker 编辑模式快照竞态**（L216-217）：`oldId` 取自打开弹窗时的 `editConfig` 快照，若磁盘配置在编辑期间被并发修改，`existingModels.find` 找不到 → `edited={}` 丢模型字段。低概率。
- **update-store.init 未保存 unsubscribe**（L30-34）：StrictMode 双调用会注册两个 listener（幂等，影响小）。
- **soul-extension 每轮热读 soul.md**：多 cwd 并发时每 turn 同步读文件一次，小文件可忽略。

## ✅ 做得好的

- **soul-extension 的 before_agent_start 热读**：编辑即时生效、空 soul 零残留，设计优于 services 重建方案。
- **bash 守卫 per-unit 隔离**：allowAllSession/pendingBashRequests/denialCounts 按 cwd 独立，多工作区并发互不泄漏。
- **黑名单覆盖面**：Windows/macOS/Linux 全平台（del/format/vssadmin/diskutil/tmutil…），模式编写规范。
- **menu.ts 帮助菜单动态取焦点窗口**：与窗口重建路径天然兼容。
- **SkillDetailModal / AboutDialog 的 Esc 关闭 + overlay 点击关闭**规范。

## 建议处理顺序

1. **R2-1 黑名单拆段**（安全，改动集中在 evaluateBash，建议尽快）
2. **R2-3 审批并发队列**（真实卡死场景）
3. R2-2 / R2-4 / R2-5 随 UI 调整一起做

## ✅ Round 2 修复记录（2026-07-31 14:00）

| 项 | 状态 | 说明 |
|----|------|------|
| R2-1 黑名单拼接绕过 | ✅ 已修复 | `evaluateBash` 整行 + 拆段双查：`splitCommandChain` 按 `&&`/`\|\|`/`;`/`\|`/换行拆段，每段独立过黑名单；先整行查保住 `curl \| sh`、fork bomb 等含分隔符的模式 |
| R2-2 ModelsPage 删除死代码 | ✅ 已修复 | provider 行加垃圾桶按钮（hover 显示，stopPropagation），接入已有的 `pendingDelete` 确认弹窗 |
| R2-3 审批单槽覆盖 | ✅ 已修复 | bashGuard-store 改 `enqueuePending`/`respondAndAdvance` + 等待队列；弹窗显示「还有 N 个待审批」 |
| R2-4 app-updater 窗口引用 | ✅ 已修复 | `emitState` 动态取 `BrowserWindow.getAllWindows()[0]`，`setupAutoUpdater()` 删参数 |
| R2-5 保存表单缺 catch | ✅ 已修复 | ContextPage / SoulSettings / SecurityPage 补 catch + error 展示 + `*.saveFailed` i18n key（中英） |

> 验证：`tsc -p tsconfig.node.json` 0 错 + `npm run typecheck` 0 错 + `npm run build` 通过。
> ⚠️ 主进程改动（R2-1/R2-4）需完整重启应用生效。

## ✅ 黑名单盘符路径盲区修复（2026-07-31 14:15）

**用户实测报告**：`rm -rf E:/mnt/e/Project/pi-desktop && echo hi` 无拦截提示、LLM 报成功。

**根因（不是拆段的 bug）**：黑名单 Unix 区只匹配 `/`/`~`/`.`/`*` 前缀，Windows 区只有 `rmdir/rd/del/format`——**缺盘符路径变体**。`E:/...` 开头四个 `rm -rf` 模式都不命中，命令根本没进拦截分支。目录实际没删是因为 `E:/mnt/e/...`（WSL 风格路径）在 Windows 上不存在，`rm -rf` 对不存在的路径静默返回 0，`&& echo hi` 照常执行。

**修复**：
1. 默认黑名单新增（主进程 + SecurityPage 两份）：`rm\s+(?:-[a-zA-Z]+\s+)*"?[A-Za-z]:\[^&|;]*`
   - 容忍任意参数顺序（`rm -r -f E:/...`）、引号内空格（`"E:/foo bar"`）、小写盘符
   - `[^&|;]*` 吃到命令分隔符为止，配合 R2-1 拆段双查
2. **`readBashGuardConfig` 改 add-only 合并**：磁盘配置自动补缺失的默认危险项，**已保存过 bash-guard.json 的用户无需手动改配置**（取舍：用户删掉的默认项会被加回，安全优先）

**验证**：12 用例全过——用户场景、`&&` 拼接、`rm -r -f`、引号空格、`D:/data` 尾部拼接全部拦截；`rm -f build/old.log`、`ls`、`git status` 不误伤（`rm -rf ./build`、`rm -rf /tmp` 由旧 `.`/`/` 模式负责，新模式不重复拦截）。

## ✅ ESLint 补全（2026-07-31 14:35）

**背景**：`npm run lint` 因缺 `eslint.config.js` 一直无法运行。

**做了什么**：
1. 装 devDeps：`eslint@9` + `@eslint/js` + `typescript-eslint` + `eslint-plugin-react-hooks` + `eslint-plugin-react-refresh` + `eslint-plugin-react`（⚠️ 必须 `--legacy-peer-deps`：`@lobehub/ui` peer 要求 react ^18 而项目是 19）
2. 写 `eslint.config.js`（flat config）：js.recommended + tseslint.recommended + React Hooks/Fast-Refresh（renderer）+ main/preload Node globals
3. 规则策略：`no-explicit-any`（SDK 未类型化，116 处）与 `react-hooks` v6 激进新规则（set-state-in-effect/refs/immutability）降为 **warning**；**error 级保留并修复** 12 处真实问题（未用变量/接口 9 处、无用赋值 2 处、空 catch 2 处）

**结果**：`npm run lint` → **0 errors / 140 warnings**（~114 any + ~14 set-state-in-effect + 6 exhaustive-deps + 其余），`--fix` 自动清 2 个。主进程 tsc + 渲染 tsc + build 全绿。

**剩余 warnings 是"可见的改进清单"**：exhaustive-deps（6 处，可逐个修）、any（渐进类型化）——不再阻塞，但随时可扫。
