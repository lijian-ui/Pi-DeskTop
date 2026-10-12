# Pi Desktop Release Notes

## v0.8.0 — 2026-10-12

### 新特性

- **deferred 工具试点（按需装载）**：`browser` 与 `schedule` 在桌面普通/空间会话注册但不再常驻声明给模型——不进 `tools` 数组、不进 `<tools>`/`<rules>`，经 `tool_search` 按需装载，桌面常态首轮 prefill 减少约 3000 token。IM 与定时任务会话保持常驻 direct（无人值守场景要确定性，不走装载跳板）。`browser-config.json` / `schedule-config.json` 新增 `deferred` 字段（默认启用，写 `false` 一键回退常驻）
- **弱模型兜底（关键词自动装载）**：实测弱模型学不会「先 tool_search 再使用」两步推理。用户消息命中浏览器/定时意图关键词（打开网站、URL、每天提醒…）时，宿主直接替模型装载对应工具，本轮即可调用；正则刻意保守，宁可漏不误触发
- **错误静默场景全覆盖**：会话发送失败从静默 no-op 改为显式抛错；发送即显示「等待响应」+ 60 秒首响应看门狗；空回合给出兜底提示；非焦点会话的错误落到各自消息缓冲区，切回会话可见
- **重试可见性**：自动重试期间不再闪现红色错误卡片，新增「正在重试 n/m」状态条，重试过程一目了然

### 新增

- `tool_search` 独立挂载通道：MCP 关闭时第一方 deferred 工具仍有按需装载入口（此前 tool_search 只在 MCP 启用时存在）

### 变更

- **系统提示词瘦身**：首轮 prefill 约 15k → 10k token
  - 记忆策略默认样式 `full` → `compact`，并删除与工具描述重复的路由/分类/技能指导段落（约 850 → 270 token）
  - 各工具 `promptGuidelines` 审计：删除与工具 description / 参数 schema 的跨通道重复，只保留真正的行为纪律（约省 850 token）
  - 剥离 `<docs>` pi 文档路径段（约 500 token，仅改 pi 本身时才用得上）
  - `<skills>` 目录描述截断守卫：每条封顶 160 字符（优先截到句边界），防止 SKILL.md frontmatter 小作文常驻每轮 prompt；磁盘文件不受影响
  - 用户规则段 `<rules>` 更名为 `<user-rules>`，消除与 SDK 工具规程 `<rules>` 的同名冲突
  - subagent 委派指引包裹为 `<available_subagents>`，prompt 尾部宿主追加段统一 XML 围栏
- 升级 Pi SDK `@earendil-works/pi-coding-agent` 1.0.0 → 1.1.0（`tool_execution_end` 自带 `durationMs`、`server_busy` 等上游错误自动重试、hidden 工具不再泄漏进 `<rules>`）

### 修复

- **产物文件点击偶发 ENOENT**：Git-Bash 风格路径（`/c/Users/...`）被当作当前盘相对路径拼接成 `D:\c\...`；新增 Windows 路径归一化（同时覆盖 WSL `/mnt/c/...`）
- **自定义网关 400/422**：推理模型请求携带 `role:"developer"` 被上游拒绝；自定义 provider 保存与启动迁移统一写入 `compat.supportsDeveloperRole: false`
- **browser 观测改进**：snapshot 支持全文模式与 delta 增量；截图附带页面元数据并按内容哈希去重；`evaluate` 收口为最后手段并给出替代路径

***



