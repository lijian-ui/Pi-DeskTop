# Pi Desktop

> **中文** | [English](README.en.md)

> 为 [Pi Agent](https://pi.dev) 打造的桌面壳——用 Electron 给你一个原生窗口、终端和多会话工作区。

Pi Desktop 是 Pi AI 编程代理的桌面客户端。它不修改 Pi SDK 的任何源码（`@earendil-works/pi-coding-agent` 保持原样，可随 npm 自由升级），只负责提供一个舒适的桌面交互层：侧栏会话管理、集成终端、多工作空间并行任务、系统托盘、自动更新等。

![Pi Desktop](image/screenshot.png)

## 功能特性

- **多会话并行**：不同工作目录（空间）的任务可并行运行，侧栏「任务 / 空间」双分组管理
- **内嵌终端**：基于 node-pty 的真 PTY 终端（Git Bash / PowerShell / Cmd），与主视图并排常驻，关闭不销毁、输出零丢失
- **会话内搜索**：标题栏搜索框，跨全部消息内容与思考过程定位高亮
- **上下文管理**：手动 `/compact` 与自动压缩，可调保留窗口 / 触发阈值
- **工具执行可视化**：工具调用名称 + 参数摘要直接显示，展开可看完整 JSON 与输出
- **工具激活配置**：设置页勾选 Pi 内置工具（read / bash / edit / write / grep / find / ls）
- **文件管理**：侧栏文件管理器浏览工作目录、搜索文件、预览内容；对话中用 `@` 引用文件生成卡片，随消息一并发送给模型
- **Soul 人格**：设置页编辑人格设定，注入到系统提示词最底部，每轮热加载
- **安全中心**：bash 危险命令黑名单 / 白名单，敏感命令弹窗确认（按工作目录隔离）
- **系统托盘**：点 X 最小化到托盘，托盘图标常驻；左键显隐、右键菜单退出
- **IM 接入**：侧栏「IM 接入」页配置钉钉 / 微信 / QQ 机器人，手机上就能和 AI 对话——文本 / 图片 / 语音收发、斜杠命令、命令审批（QQ 按钮 / 文本指令）、定时任务完成推送（详见 [IM 接入](#im-接入钉钉--微信--qq)）
- **自动更新**：electron-updater 以 Gitee 为版本检测源、GitHub 为安装包下载源（下载 URL 经 `ghproxy.net` 等镜像加速，国内直连更快；可在 `scripts/publish-lib.mjs` 用 `GITHUB_MIRROR` 环境变量切换镜像），发布后用户端自动升级
- **会话导出**：导出会话为独立 HTML 文件

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Electron 35+ |
| 前端 | React 19 + TypeScript + Vite |
| 状态 | Zustand |
| 终端 | node-pty + xterm.js |
| Agent 引擎 | [@earendil-works/pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)（SDK，只读不改） |
| 更新 | electron-updater（generic provider） |

## 目录结构

```
src/
├── main/            # Electron 主进程
│   ├── index.ts     # 入口：窗口 + 托盘 + 更新 + IPC
│   ├── window.ts    # 主窗口（关闭即隐藏到托盘）
│   ├── tray.ts      # 系统托盘
│   ├── app-updater.ts  # 自动更新
│   ├── menu.ts      # 应用菜单
│   ├── ipc-handlers.ts
│   ├── pi/          # Pi SDK 集成（session-manager / terminal-manager / soul …）
│   └── im/          # IM 网关（gateway / 渠道适配器 dingtalk·weixin·qq / 会话映射）
├── preload/         # 安全桥接（contextIsolation）
├── renderer/        # React UI（chat / sidebar / im / automate / store）
└── shared/          # i18n 等共享代码
resources/           # 图标（Pi 官方 logo）
scripts/publish.mjs  # 发布脚本（Gitee + GitHub 双发，含令牌，已被 .gitignore 排除）
```

## 开发

```bash
npm install
npm run dev          # 启动 vite + Electron（热更新）
```

## 构建与打包

```bash
npm run build            # 仅编译（tsc 渲染层 + vite 产物到 dist/）
npm run build:electron   # 完整打包：主进程 tsc 检查 + electron-builder 出安装包（release/）
```

打包产物（`electron-builder.yml`）：Windows 下 NSIS 安装版 + portable 便携版。

## macOS 构建（需在 macOS 上进行）

Windows **无法交叉编译** macOS 安装包（dmg 只能在 macOS 上构建）。在 Mac 上构建：

**前置依赖**

- Node.js 22.x + npm（Pi SDK 要求 `engines.node >= 22.19.0`）
- Xcode Command Line Tools：`xcode-select --install`
- （可选）Apple Developer 证书——用于签名与公证；不签名也能出包，但用户首次打开会被 macOS Gatekeeper 拦截（右键 → 打开 可绕过）

**构建**

```bash
npm install
npm run build:electron   # 产出 release/ 下的 .dmg + .zip
```

> node-pty 自带 darwin-arm64 / darwin-x64 预编译二进制（N-API），mac 上 `npm install` 免编译；若提示编译错误再检查 Xcode CLT。

## IM 接入（钉钉 / 微信 / QQ）

在侧栏 **「IM 接入」** 页添加渠道，配置后即可在手机上和 AI 对话——所有 IM 会话在桌面端侧栏可见、可继续追问，也可以把会话绑定 / 迁移到任意工作目录（AI 直接读写该目录项目文件）。

### 渠道接入方式

| 渠道 | 接入方式 | 凭证来源 |
|---|---|---|
| **钉钉** | 企业内部机器人（Stream 长连接，免公网回调） | AppKey + AppSecret（钉钉开放平台） |
| **微信** | **扫码绑定**，无需 AppID/AppSecret | 手机微信扫码（iLink 官方协议，必要时输配对码） |
| **QQ** | **扫码绑定**，无需手动创建机器人 | 手机 QQ 扫码（官方机器人 SDK，自动写入 AppID + AppSecret） |

每个渠道可添加**多个实例**（多个机器人），各实例会话相互独立；渠道可独立启用 / 停用 / 删除，并配置**默认工作目录**。

### 收发能力

- **文本收发**：钉钉单聊 / 群聊（群聊自动 @ 提问人）、微信单聊、QQ 私聊 + 群聊（仅响应 @ 机器人的消息）
- **图片**：发给机器人 → AI 识别（多模态）；AI 回复中提及本地图片 / 文件路径 → 自动作为独立图片 / 文件消息发送
- **语音**：语音消息服务端转文字后交给 AI（QQ / 钉钉）
- **文件解析**：钉钉可接收 docx / pdf / txt 等文件并解析文本供 AI 阅读
- **引用消息**：渠道内"回复某条消息"再提问，被引用内容自动附加给 AI
- **流式输出**：钉钉 AI 卡片流式、QQ 私聊打字机式逐字呈现（群聊 / 失败自动回退整段）

### 斜杠命令

`/model`（切换模型）· `/status`（查看目录与模型）· `/compact`（压缩上下文）· `/allow` `/deny` `/allow_always`（审批响应，见下）· `/reset` `/clear` `/new`（新会话）· `/help`

### 命令审批（安全）

渠道可开启「**命令审批**」——AI 在该渠道执行 bash 命令前，需在手机上确认：

- **QQ**：发送带按钮的审批卡片，点「✅ 允许 / ⛔ 拒绝 / 🔁 允许并记住 / 本次会话允许」即放行
- **钉钉 / 微信**：文本指令 `/allow` `/deny` `/allow_always`，或直接回复 `allow:1` / `✅ 允许 1` 等
- 渠道审批**优先于**桌面端全局权限模式（即使桌面端 YOLO，开了审批的渠道也拦截）；桌面端询问弹窗与渠道确认**不重复弹出**；危险命令黑名单始终强制
- 「**允许并记住**」会把命令动词写入全局白名单（`bash-guard.json`），以后全渠道免审批

### 定时任务完成推送

「自动化」页创建任务时可选「**完成后推送**」到指定 IM 渠道——任务执行结果主动推送到该渠道最近活跃会话（QQ / 微信 / 钉钉均可）。

### 会话与数据

- IM 会话存储于配置目录 `chat/im/<channel>/`（独立于桌面会话，`/reset` 不删除历史文件）
- 会话可迁移到任意工作目录：IM 接入页「批量迁移」或桌面会话窗口「选择工作目录」，对话历史保留、会话身份不变

## 运行时配置（Windows：`~/.pi/agent/` · macOS：`~/Documents/PiAgent/`）

Pi SDK 与桌面壳共用配置目录（macOS 放在「文稿」下，Finder 直接可见；Windows 保持隐藏的 `~/.pi/agent`）：

| 文件 | 内容 |
|---|---|
| `settings.json` | 默认模型 / Provider、`activeTools`（激活工具）、`compaction`（压缩参数） |
| `auth.json` | 各 Provider 的 API Key |
| `custom-models.json` | 自定义 OpenAI 兼容端点（LM Studio / Ollama 等） |
| `soul.md` | 人格设定（设置页编辑） |
| `im-config.json` | IM 渠道配置（钉钉 / 微信 / QQ 实例与凭证、命令审批开关） |
| `im-session-map.json` | IM 会话映射（渠道会话 → 会话文件） |
| `bash-guard.json` | bash 危险命令黑名单 / 白名单 |
| `chat/` | 无工作目录会话的存储位置 |
| `sessions/` | 各工作目录的会话历史（JSONL） |

## 需求与安装

### 系统要求

| 平台 | 最低 |
|---|---|
| Windows | Windows 10+（x64 / arm64） |
| macOS | macOS 12+（Intel / Apple Silicon） |

### 安装

从 [GitHub Releases](https://github.com/lijian-ui/Pi-DeskTop/releases) 下载安装包（版本检测走 Gitee，国内访问友好；安装包实际托管在 GitHub，下载经镜像加速）。

- **Windows NSIS 安装版**：双击 `.exe` → 安装向导
- **macOS DMG**：双击 `.dmg` → 拖入 Applications

**首次打开的签名提示**（未签名的安装包）：

- Windows：SmartScreen 提示「未知发布者」→ 选「仍要运行」（需要点开"更多信息"）
- macOS：Gatekeeper 拦截 → 右键 → 打开 → 再次确认

要消除这些提示需要购买代码签名证书（几千/年）。当前发布未签名，开发版正常。

### 数据与卸载

- **会话 / 配置 / 人格** 都存在配置目录（Windows：`~/.pi/agent/`，macOS：`~/Documents/PiAgent/`，详见上一节）
- **卸载应用** 不会删除配置目录——重装后历史会话、设置、人格都在
- **想彻底清除**：手动删除配置目录（Windows 在 `%USERPROFILE%\.pi\agent\`，macOS 在 `~/Documents/PiAgent/`）

## 常见问题

**无工作目录能聊天吗？** 能。普通对话直接落配置目录的 `chat/`（侧栏「任务」分组），发送首条消息前可绑定工作空间（「空间」分组）。

**如何升级 Pi SDK？** `npm install @earendil-works/pi-coding-agent@<新版本>`（0.x 版本 `^` 只锁 patch，跨 minor 需显式指定版本），升级后 `npm run build` 验证。

**点关闭按钮程序还在？** 是的，点 X 最小化到系统托盘；退出请用托盘右键菜单「退出」。

## License

MIT
