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
- **自动更新**：electron-updater 对接 Gitee（主源）/ GitHub（镜像），发布后用户端自动升级
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
│   └── pi/          # Pi SDK 集成（session-manager / terminal-manager / soul …）
├── preload/         # 安全桥接（contextIsolation）
├── renderer/        # React UI（chat / sidebar / layout / store）
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

## 运行时配置（Windows：`~/.pi/agent/` · macOS：`~/Documents/PiAgent/`）

Pi SDK 与桌面壳共用配置目录（macOS 放在「文稿」下，Finder 直接可见；Windows 保持隐藏的 `~/.pi/agent`）：

| 文件 | 内容 |
|---|---|
| `settings.json` | 默认模型 / Provider、`activeTools`（激活工具）、`compaction`（压缩参数） |
| `auth.json` | 各 Provider 的 API Key |
| `custom-models.json` | 自定义 OpenAI 兼容端点（LM Studio / Ollama 等） |
| `soul.md` | 人格设定（设置页编辑） |
| `chat/` | 无工作目录会话的存储位置 |
| `sessions/` | 各工作目录的会话历史（JSONL） |

## 需求与安装

### 系统要求

| 平台 | 最低 |
|---|---|
| Windows | Windows 10+（x64 / arm64） |
| macOS | macOS 12+（Intel / Apple Silicon） |

### 安装

从 [Releases（镜像）](https://github.com/lijian-ui/Pi-DeskTop/releases) 下载安装包（更新源是 Gitee，国内访问友好；GitHub 作为镜像备份）。

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
