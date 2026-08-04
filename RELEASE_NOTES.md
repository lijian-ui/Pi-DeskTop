# Pi Desktop v0.3.0 Release Notes

## ✨ 新功能

### 跨平台终端
- **macOS 终端支持**：终端模块完成跨平台重构，Mac 上点击终端按钮即可打开内置终端，默认使用 zsh，可在下拉列表切换为 Bash；Windows 继续支持 Git Bash / PowerShell / CMD。
- **Shell 自动探测**：根据已安装环境自动列出可用 shell，未安装的 shell（如未安装的 Git Bash）不会出现在下拉列表中。
- 终端基于 node-pty 真 PTY：关闭面板 = 隐藏（保留全部输出与进程常驻），切换设置/技能视图时不卸载，切 shell 显式重建。

## 🐛 问题修复

- **Mac 终端无法启动（posix_spawnp failed）**：修复 Mac 上 node-pty 原生二进制与 Electron 运行时不兼容导致终端打不开的问题；Mac 构建现自动针对本机 Electron 重编 node-pty。
- **任务会话权限按钮错位**：不选择工作空间进入任务会话时，权限选择按钮稳定保持在输入框右侧。
- **暗色主题下拉白底**：修复暗色主题下权限下拉列表、配置模型模态框背景显示为白底的问题（修正主题变量引用）。
- **配置模型模态框误关**：修复在模态框内选中文本并拖出时误关闭配置页面的问题（改为按下时判定点击目标）。
- **输入框拼写红线**：关闭所有输入框的拼写检查波浪线。
- **启动偶发报错**：修复启动阶段 IPC 竞态（渲染进程早期调用抢跑在 SDK 初始化完成前），启动更稳定。
- **关于框版本号**：版本号改为动态读取，正确显示当前版本（不再写死旧值）。

## 📦 构建

- 版本号：`0.3.0`
- Electron：`^35.0.0`
- Pi SDK：`^0.83.0`
- macOS 构建需本机安装 Xcode 命令行工具（`xcode-select --install`），构建时自动重编 node-pty。

# Pi Desktop v0.2.0 Release Notes

## 🐛 问题修复

### 资源泄漏
- **TerminalManager 退出未释放**：修复了应用退出时 `node-pty` 伪终端进程未调用 `dispose()` 的问题，避免残留僵尸进程。

### 数据安全
- **auth.json 并发写竞争**：新增 `authWriteLock` 顺序写锁，保护 `saveApiKey` / `deleteApiKey` / `saveCustomProvider` / `deleteCustomProvider` 的读-改-写操作，防止并发调用导致写入覆盖。

### 安全可用性
- **Bash 黑名单无效正则静默丢弃**：`compileBashPatterns` 现在会在控制台输出警告日志，提示用户在 `bash-guard.json` 中配置了无效的正则模式，不再静默跳过。

### 代码质量
- **消除 extractText 重复代码**：提取共享工具模块 `src/renderer/utils/content-utils.ts`，统一 `extractText` / `extractThinking` 的实现，替代三处内联的 `any` 类型逻辑。

## 🚀 性能优化

- **会话缓冲 LRU 淘汰**：`messagesByPath` 新增 20 个会话的上限，超限时自动驱逐最旧的非当前会话缓冲，防止频繁切换工作区导致内存持续增长。
- **工具输出截断显示**：工具执行输出超过 5,000 字符时默认折叠，附带"展开完整输出"按钮。不影响 SDK 上下文（LLM 仍持有完整输出）。
- **上下文用量去重写入**：`compaction_end` 事件中，当 token 数与上次写入相同时跳过磁盘写入，减少不必要的 I/O。

## 📦 构建

- 版本号：`0.2.0`
- Electron：35.7.5
- Pi SDK：0.83.0
