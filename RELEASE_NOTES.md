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
