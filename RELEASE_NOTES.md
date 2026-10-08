# Pi Desktop Release Notes

## v0.7.0 — 2026-10-08

<br />

### 🔌 MCP 集成（新）

- 挂载 SDK 内置 MCP：会话启动连接 `~/.pi/agent/mcp.json`，工具以 `mcp__<server>__<tool>` 暴露；`codemode` / `tool_search` 两条间接调用通道按需激活（用不到时零上下文开销）

- `mcp-config.json`：桌面端**总开关**（默认 ON，关闭则不注册扩展、不后台 spawn 任何子进程）+ 服务器授权白名单

- **安全：强制只读用户级** **`mcp.json`**，不读 `<项目>/.pi/mcp.json` —— 避免克隆来的仓库注入任意 stdio 命令

- 新增 MCP 设置页（`McpSettings.tsx`）+ 工具调用授权弹窗（`McpApprovalModal.tsx`，按服务器粒度、交互式会话）

- 无人值守（定时任务）会话把首个 prompt 的等待缩短到 3s，不因 MCP 连接卡住整次任务

### ⏰ schedule 工具（新）

- 新增一方 `schedule` 工具：模型可对「自动化」页面的定时任务做 CRUD，与页面共用同一持久化层，双向可见

- 暴露 interval / daily / weekly / monthly / yearly / once 六种形态（**非 cron**），与 UI 预览一致

- `schedule-config.json` 总开关（默认 ON）；**仅在普通/工作区会话挂载**，定时任务会话不挂载（避免任务再排任务）

### 🌐 browser 工具：统一动作后验信号

- `click` / `type` / `fill` / `press_key` / `navigate` 统一返回 `{ok, url, navigated, newRequests, effective, ...}`，一次调用即可判断动作是否真的生效

- **修复** **`fill`** **误报**：`fill` / `type` 改为按目标控件的 `value` / `checked` / `selectedIndex` 变化判定，新增 `valueChanged`（批量 fill 另给 `fieldsChanged`），不再把「填成功」误报成「未观察到变化」

- **`press_key`** **补后验信号**：按 Enter 触发提交跳转时返回 `navigated:true`，与 click/fill 对齐

- 批量 `fill`（`fields` 数组）、`waitFor:{url|selector,timeout}`；门禁拆出 `allowUnattendedRead`（只读动作在无人值守下豁免）；`snapshot` 增加 `excludeOccluded` 引导

### 🐛 关键修复

- **全工具 stale ctx 失效（阻塞级）**：多会话共享同一个 `ExtensionRuntime`，而会话替换（`/new`、恢复、fork）会先 `dispose()` 旧会话并**永久** `invalidate()` 该 runtime，导致所有工具调用（含内置 `read` / `bash`）统一报 `This extension ctx is stale after session replacement or reload.`。修复：**每个 session 独占自己的 runtime** —— 建新会话前先 `resourceLoader.reload()` 换新 runtime（旧 runtime 只被其自身弃用，不波及兄弟会话），并发建会话加串行锁

- **新建会话首条消息显示两条**：SDK 在首个 prompt 会把一条 `system` 消息 unshift 到 user 消息之前，渲染层误将其当作可渲染消息缓冲，打破了乐观气泡的「最后一条是 user」去重。修复：消息 reducer 只接受 `user` / `assistant` / `custom`

- **配置 BOM 隐患**：新增 `src/main/json-file.ts` 统一剥离 UTF-8 BOM，各配置读取（im / ask-user / browser / memory / send-file / todo / websearch / mcp / schedule）改走该工具，修复「Windows 记事本另存过的配置被静默回退默认值」

### 🧹 工程

- 主进程类型检查（`tsc -p tsconfig.node.json`）错误清理、移除死导入

- 文档：`docs/pi-virtual-models.md`（虚拟模型与自动模型路由**调研记录，桌面端尚未接入**）

***

### 🧠 Hermes 记忆系统（新）

- 新增 `hermes` 记忆系统：跨会话持久化的长期记忆，按项目目录隔离

- 记忆存储：Markdown 权威源 + SQLite 索引双写，前端删除同步清权威源，重启不复活

- `memory_search` 工具支持空查询（列出全部记忆），支持按会话上下文自动联想

- 移除旧的包管理模块，工具注册改为第一方扩展体系（`tool-catalog.ts` + `extensions/`）

### 🌐 托管浏览器 CDP 直连架构（新）

- 移除浏览器扩展回环桥，改为 Playwright Core + CDP 直连**托管 Chrome**，不再弹外部浏览器窗口

- 新增 `browser` 单一入口工具（`src/main/pi/browser/browser-tool.ts`）：`navigate` / `snapshot` / `click` / `fill` / `press_key` / `hover` / `window` / `tabs` / `status` / `get_cookie`

- **快照层敏感字段遮蔽**：`type=password` / `name/id` 命中 `password|passwd|card|cc-num|cvv|cvc|ssn|secret|token` 的 `<input>`，value 一律抹空并打 `valueRedacted` 标记；**增量比对也完全排除**，密码框值变没变都不会进 delta

- 登录页自动弹窗**仅限验证码/扫码/短信**场景（`isCaptchaLoginPage`）；纯用户名密码登录页不再强制弹窗，允许 LLM 自动填（密码框继续遮蔽、LLM 不可回读）

- 动作级门禁：`upload`（上传本机文件）、`evaluate`（跑任意 JS）、`press_key` 带 Ctrl/Meta/Alt 组合键**默认拒绝**，需在 `browser-config.json` 的 `guard` 段显式开启

- `browser({action:"get_cookie"})` 新增：白名单受限的 Cookie 导出，带 `valid=yes/no/unknown` 会话探活

### 💬 IM 通道升级

- **新增** **`send_file`** **一方工具**（`src/main/pi/send-file/`）：显式调用 `send_file(filePath)` 发送文件到当前 IM 会话；`sendfile-config.json` 开关

- 新增 `media-shared.ts` 集中媒体策略：`MAX_MEDIA_BYTES=5MB`、`MEDIA_FETCH_TIMEOUT_MS=30s`、重试次数、路径提取等

- 移除裸路径自动外发（`extractMediaRefs` 仅处理 Markdown 图片），解决"项目开发时文件轰炸"问题

- `ImChannelAdapter` 接口新增 `sendFile(target, filePath)` 原语，三端（QQ / 钉钉 / 微信）各自复用上传原语实现

- 桌面端 IM 文件日志系统（`logs/im-YYYY-MM-DD.log`）

- 打包版 `ffmpeg` 路径修复（`asar.unpacked` 定位），钉钉语音 / 飞书流式 / 飞书语音相关修复

### 🎨 前端 UI

- **用户消息气泡保留输入框换行**：`remark-breaks` 只对 UserMessage 生效（Assistant 回复继续按 Markdown 段落渲染）

- ArtifactCards / TerminalPanel / ToolCard / ThinkingTools / SkillInvocation 等组件重构

- 深色模式 / CSS tokens 微调

### 🧹 其他

- `.gitignore` 新增 `.trae/` / `.playwright-mcp/`

- GitHub / Gitee 远端配置清理（移除混在 origin.push 里的 Gitee URL）

***


