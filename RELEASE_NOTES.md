# Pi Desktop v0.6.0 Release Notes

## ✨ 本版概要

- **语音合成（TTS）**：桌面端 LLM 回复支持朗读 + 流式自动播放，并可在 IM 渠道以语音消息回复（小米 MiMo-V2.5-TTS）。
- **飞书（Feishu / Lark）IM 通道**：新增飞书机器人接入，与钉钉 / 微信 / QQ 并列。
- **IM 语音回复**：QQ、飞书支持把 AI 回复合成语音发送，可设「仅发送语音」。
- **IM 会话 / 工作区命令**：新增 `/workspaces` `/workspace` `/sessions` `/continue`。
- **LLM 回复区重构**：思考过程 / 工具 / 中间回复折叠为「思考与工具」面板；思考内容默认折叠，避免大段思考撑爆回复区。
- **用户消息代码引用卡片折叠**：引用卡片可点击展开 / 收起。

---

## 新增功能

### 1. 语音合成（TTS）

- 新增独立 TTS 子系统（主进程 `src/main/tts/tts-service.ts`，渲染端 `src/renderer/sidebar/TtsPage.tsx`）。
- 模型：**MiMo-V2.5-TTS**（小米 mimo），通过 OpenAI 兼容接口调用。
  - 非流式：返回完整 **WAV**（base64）。
  - 流式：返回 **PCM16（24kHz 单声道）** 分块，渲染端 `pcm-player.ts` 实时播放，LLM 流式结束即同步朗读。
- 设置页新增「语音合成」分区：
  - 多配置管理（增 / 删 / 改 / 设为当前）、预置音色（冰糖 / 茉莉 / 苏打 / 白桦 / Mia / Chloe / Milo / Dean）、自然语言「语气风格」指令、测试语音、流式自动播放开关。
  - 配置持久化到 `~/.pi/agent/tts-config.json`（独立于 `settings.json`，密钥隔离）。
- 桌面端 LLM 回复气泡新增「朗读 / 停止」按钮（`AssistantTurn.tsx`），开启流式开关后回复完成自动播放。
- IPC：`pi:getTtsConfig` / `pi:saveTtsConfig` / `pi:ttsSynthesize` / `pi:ttsSynthesizeStream`；主进程通过 `pi:ttsChunk` / `pi:ttsDone` 推送音频分块。预加载 `window.piDesk.ttsSynthesize` / `onTtsChunk` / `onTtsDone`。

### 2. 飞书（Feishu / Lark）IM 通道

- 新增 `feishu` 渠道类型（`src/main/im/feishu/`：adapter / connection / reply）。
- 配置字段：`appId` / `appSecret` / `encryptKey`（可选）/ `verificationToken`（可选）/ `brand`（feishu / lark）。
- 渠道弹窗（`ImChannelModal`）支持飞书字段与可选标记；`vite.config.ts` 将 `@larksuiteoapi/node-sdk` 设为 external（与 dingtalk-stream 同模式，运行时由 Electron 解析）。

### 3. IM 语音回复（QQ + 飞书）

- 渠道实例新增 `ttsReply`（同时发语音）与 `ttsVoiceOnly`（仅发语音，失败自动回退文字）。
- QQ 适配器 `sendVoice`：文本 → MiMo TTS → WAV → **SILK Base64** → QQ 语音消息（`@tencent-connect/qqbot-nodejs` 的 `audioFileToSilkBase64`）。
- 网关在回复完成时按渠道配置合成语音；`voiceOnly` 模式下跳过文字流、仅发语音（语音失败回退文字）。

### 4. IM 会话 / 工作区管理命令

- `/workspaces`：列出所有工作区（近期目录 + 会话历史 cwd，标记当前会话）。
- `/workspace <路径>`：设置待切换工作区（校验目录存在），下次 `/new` 生效。
- `/sessions`：列出全部会话（编号 + 首条消息预览 + 工作区），供 `/continue` 快捷引用。
- `/continue <id 或编号>`：将当前会话映射到已有 Pi 会话文件（`ImSessionMap.setMapping`）。
- 帮助文本同步更新；`/model` 列表格式优化。

### 5. LLM 回复区 · 思考与工具折叠

- 会话回合折叠（消息列表重构为 `MessageList → AssistantTurn + ThinkingTools`），同一回合只显示**一个 Pi 头像**，中间过程（思考 / 工具 / 中间回复）聚合成「思考与工具」面板：流式自动展开、完成自动折叠。
- **本版新增**：思考内容默认折叠——面板内新增「思考过程」开关，流式 / 完成态均折叠，用户手动点开查看大段思考，回复区始终保持清爽（折叠态下空 step 自动过滤，不留分隔线）。

### 6. 用户消息代码引用卡片折叠

- 用户气泡内的代码 / 终端引用卡片（`RefCard`）可点击标题折叠 / 展开（`ChevronRight` 旋转指示）。

---

## 修复与体验优化

- **代码块复制修复**：`Markdown.tsx` 复制改为从渲染后 `<code>` 元素取 `textContent`，修复 rehype-highlight 把代码包成 `<span>` 导致复制内容带标签 / 丢失的问题；同时修正代码块首尾多余换行。
- **发送流程优化**：`ChatComposer` / `useAgentSession` 在发送时乐观插入用户气泡（含 `attachments`，经 `mutateBuffer` 写入 `messagesByPath` 避免附件被 SDK 事件覆盖）；队列发送时重建 `fullBody`（用户文本 + 展开的代码引用），确保模型收到完整上下文，附件引用随消息入队转发。
- **停止逻辑统一**：`steer` / `followUp` / `abort` 改用 `resolveCwd(cwd)` 解析工作目录（与既有「空 cwd 回退 chatOnlyCwd」约定一致），避免误定位到 null 工作区。
- **主题 / 原生控件修复**：`tokens.css` 增加 `color-scheme: dark / light`；`global.css` 强制 `<option>` 背景 / 前景按主题着色，修复 Windows / Electron 下 `<select>` 下拉框始终白底黑字的问题。
- **i18n**：新增飞书、TTS、语音回复、IM 命令等近 90 条中英文文案。

---

## 依赖与构建

- `vite.config.ts`：external 增加 `@larksuiteoapi/node-sdk`。
- `package.json` / `package-lock.json`：TTS 服务使用 `axios`；QQ 适配复用 `@tencent-connect/qqbot-nodejs` 的 SILK 转换。

---

## 验证状态

| 项目 | 状态 |
|---|---|
| 类型检查（渲染端 `tsc -p tsconfig.json --noEmit`） | ✅ 通过 |
| 类型检查（主进程 `tsc -p tsconfig.node.json --noEmit`，含 TTS / 飞书） | ⚠️ 待你本地验证（按约定我不跑主进程 build） |
| 生产构建 / 打包（electron-builder） | ⚠️ 待你本地验证 |
| TTS 实际合成 / 飞书接入 / QQ 语音回复 | ⚠️ 需配置 API Key 与渠道后实测 |

> 本版为未提交的工作区改动汇总。发版前请在本地完成主进程类型检查与生产构建，并实测 TTS、飞书接入与 QQ 语音回复链路。

---

*如果使用过程中遇到任何问题，请直接到 [Issues]( 反馈。*
