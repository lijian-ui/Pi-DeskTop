# Pi Desktop v0.5.0 Release Notes

## ✨ 本版概要

- **Pi SDK**imidazoline 升级 `@earendil-works/pi-coding-agent`：`0.83.0` → `0.84.2`（0.84.0 为 SDK minor 版本，按 semver 属破坏性升级；经兼容性核对，本项目所用 API 无破坏，已直接升级）
- **桌面端里程碑**：`v0.4.0` → `v0.5.0`（新增能力汇总 + 依赖升级，属于大版本更新）

---

## 重要变更（Breaking / Notable）

### 依赖：Pi SDK 0.83 → 0.84

0.84.0 的 Breaking 集中在内层：

- `pi-agent-core` 的会话仓储 API 全面切换为 v4 Lane 结构（`SessionStorage` / `SessionRepo`）
- 移除旧版 `message_update` 事件中的累积 `message` 与 `partial` 字段；**本项目仅使用 `assistantMessageEvent.delta`（文本与思考增量），不受影响**
- `ModelRuntime.setRuntimeApiKey()` 第三参数由「目录刷新参数」改为「鉴权取消参数」——本项目仅传两个参数，不受影响
- 远程会话通用客户端（`RemoteSession.sessions` 摘要）切换为 `SessionMetadata`——本项目未使用

> 上述 Breaking 均不涉及本项目实际使用的 SDK 面；**已验证流式协议类型定义（`message_update` 结构完全匹配）**。

## 新增功能（0.84.x 带给我们）

- **Mermaid / LaTeX 渲染**（0.84.0 新增）
- **Git Bash 文件工具路径修复**（0.84.0；Windows 桌面端直接受益）
- **流式 `message_update` 的累计用量修复**（0.84.2）
- **Windows 下 Git Bash 的 `~/.pi/agent` 目录扫描效率优化**（0.84.2）
- **模型目录、认证检查等可靠性增强**（0.84.x）

### 0.84.0 ∽ 0.84.2 详细差异（选择）

- `0.84.1 / 0.84.2`：错误修复（固定 message_update 上 accumulated usage 消失；`defaultTools` 设置项，缺省与旧行为等价）
- Windows drive 路径、网络重试增强等

---

## 🐛 修复与体验

- 0.84.2 修复流式 `message_update` 过程中 usage 累积丢失
- 0.84.0 修复 Git Bash 文件工具盘符路径与终端显示路径不一致问题（Windows 桌面端显著受益）
- 0.84 模型目录 / npm 包在启动阶段异常退出时可自动重试
- 0.84 增加 `defaultTools` 配置文件设置项（不配置即沿用旧行为）

## 📦 安装与升级

- 升级：`npm install @earendil-works/pi-coding-agent@^0.84.2` 已执行
- 定位：agent SDK 作为依赖内嵌，不使用独立 pi CLI 二进制；无独立二进制 / 自更新器需要替换

## 验证状态

| 项目 | 状态 |
|---|---|
| 类型检查（`tsc --noEmit`） | ✅ 通过 |
| 生产构建（renderer / main / preload） | ✅ 通过 |
| 事件协议核对（`message_update`） | ✅ 兼容 |
| lint | ⚠️ 原有 IM 模块错误（与本次升级无关） |

---

*如果使用过程中遇到任何问题，请直接到 [Issues]( 反馈。*