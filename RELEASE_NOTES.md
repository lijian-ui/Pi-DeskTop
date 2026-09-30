# Pi Desktop Release Notes

## v0.7.0 — 2026-09-30

**219 files changed, +39185 / -3582 lines**

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

- **新增 `send_file` 一方工具**（`src/main/pi/send-file/`）：显式调用 `send_file(filePath)` 发送文件到当前 IM 会话；`sendfile-config.json` 开关
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

---

## v0.6.0 — 2026-08-xx

### 🆕 新功能

- TTS 语音合成
- 飞书 IM 通道
- 思考内容默认折叠
- 会话回合折叠（MessageList 重构为 AssistantTurn / ThinkingTools 组合）
- IM 端 `/stop` 命令 + 停止按钮终止 bash 进程树

### 🐛 修复

- 打包版 ffmpeg 路径（asar.unpacked）
- 飞书流式回复 / 语音发送
- 钉钉语音发送

---

## v0.5.0 及更早

详见各 tag 对应提交历史。
