# Pi Desktop IM 接入（钉钉）开发文档

> 状态：**方案已定，未开发**（2026-07-31 用户拍板：只写方案不动代码）
> 形态：**集成进桌面壳主进程**（非独立进程，所有能力在桌面端）
> 参考项目：`参考项目/dingtalk-openclaw-connector`（钉钉官方为 OpenClaw 开发的 connector，MIT 协议）
>
> **双渠道导航**：本文档 = 钉钉渠道；微信（iLink 官方协议）见 [im-gateway-weixin.md](im-gateway-weixin.md)。两渠道共用架构骨架（im-gateway 总控 / im-session-map / prompt 入口 / 事件流隔离），差异仅在连接层与回复分发。

---

## 1. 背景与调研结论

### 1.1 需求

通过钉钉等 IM 渠道与 Pi agent 沟通：用户在钉钉里发消息 → agent 回复，全程不需要打开桌面壳窗口。

### 1.2 Pi SDK 能力边界（源码确认）

| 能力 | 结论 |
|---|---|
| 原生 IM 渠道适配器（钉钉/微信 bot） | ❌ 没有 |
| 外部消息注入钩子 | ✅ `AgentSession.prompt(text, images?, ...)`（agent-session.d.ts）——任何渠道的消息都可走这里 |
| 回复事件流 | ✅ 桌面壳已订阅 `subscribeToUnit` → `pi:event`（`message_update` 增量 / `message_end` 完成） |
| 结论 | **IM 适配是纯应用层职责，不需要也不应该动 Pi SDK**——正好符合项目"不动 Pi 源码"原则 |

### 1.3 参考项目分析（dingtalk-openclaw-connector，核心 4884 行）

| 层 | 文件（参考项目内） | 职责 | 本项目怎么用 |
|---|---|---|---|
| 连接层 | `src/core/connection.ts`（797 行） | 钉钉 **stream 长连接**（WebSocket，免公网回调）、自定义心跳 10s/超时 20s、指数退避无限重连、消息去重（5 分钟 TTL） | ✅ **几乎照搬**，去掉 openclaw/plugin-sdk 类型依赖即可 |
| 消息处理 | `src/core/message-handler.ts`（1793 行） | 会话上下文构建（conversationId/senderId 隔离）、白名单、命令归一化（`/reset`→`/new`）、媒体下载 | 会话映射逻辑照搬，agent 调用换成 `piManager.prompt()` |
| 回复分发 | `src/reply-dispatcher.ts`（839 行） | **AI Card 流式回复**（打字机）、文本/Markdown、@成员、QPS 限流 | P1 复用；流式内容源换成 Pi 事件流 |
| 开放能力 | `src/gateway-methods.ts`（740 行） | 钉钉文档/待办/表格/日历等能力暴露给 agent | 可选：做成 Pi 自定义工具 |
| 配置 | `src/config/accounts.ts` + `schema.ts` | 多账号、zod 校验、凭据管理 | 参考凭据管理方式 |
| 媒体 | `src/services/media/*` | 图片/音频/分块上传 | 图片 → Pi `ImageContent`（见 `docs/image-input.md`） |

**核心依赖**（全是纯 JS 包，可进 `dependencies` 打进 asar）：`dingtalk-stream@2.1.4`（钉钉官方长连接 SDK）、`axios`、`form-data`、`qrcode-terminal`、`zod`。

**关键洞察**：钉钉侧 100% 可复用（stream/卡片/webhook 全是钉钉官方能力，与 OpenClaw 无关）；OpenClaw 特有部分（`plugin-sdk` / ChannelPlugin / gateway 协议）**完全不需要**。核心工作 = 会话映射 + 回复路由。

### 1.4 形态决策

| 维度 | A 集成主进程（选定） | B 独立进程 |
|---|---|---|
| 部署 | 一个安装包，无额外服务 | 多一个服务要部署/运维 |
| 配置复用 | settings.json / soul / activeTools 直接生效 | 独立进程要自己读配置、处理并发 |
| UI | 设置页开关/状态/日志 | 无 UI |
| 常驻 | 托盘已实现 → 窗口关闭程序不退，IM 照常收消息 | 独立常驻 |
| 会话并发 | units Map 多 cwd 并行是 SDK 原生能力 | 跨进程竞争同一 jsonl 要自己加锁 |
| 工作量 | 只写 IM 层（~1000 行），连接层照搬 | 还要写进程通信 + 部署脚本 |

**结论**：集成方案工作量更小，且完全匹配"所有能力都在桌面端"。

### 1.5 首期范围（分期）

| 期 | 内容 | 说明 |
|---|---|---|
| **P0** | 钉钉 stream 连接 + 文本收发 + 会话映射 + 纯文本回复 | 先跑通全链路 |
| **P1** | AI Card 流式打字机 + 图片收发 + `/new` 命令 | 实现量约为 P0 的 3~4 倍 |
| **P2** | 多账号 + 权限策略 + 钉钉开放能力工具 | 可选 |

---

## 2. 总体架构与数据流

### 2.1 架构图

```
桌面壳主进程 (Electron)
├── pi/                      已有（session-manager / terminal-manager …）
├── im/                      ← 新增
│   ├── im-gateway.ts        IM 网关总控：启动/停止、连接状态、生命周期
│   ├── dingtalk-connection.ts  钉钉 stream 长连接（照搬 connector connection.ts）
│   ├── im-session-map.ts    IM会话(conversationId/senderId) ↔ Pi session 路径（持久化）
│   ├── im-message-handler.ts 消息路由 + 命令归一化 + 白名单 + 媒体下载
│   └── im-reply.ts          回复分发（P0 纯文本 / P1 AI Card 流式）
├── ipc-handlers.ts          + pi:im*（开关 / 状态 / 配置）
├── index.ts                 启动时按配置初始化 IM Gateway
└── 渲染层 SettingsPage      +「IM 接入」区块
```

### 2.2 数据流（完整链路）

```
钉钉 用户/群消息
  → dingtalk-stream WebSocket 长连接（免公网回调）
  → 消息去重（accountId:msgId，5 分钟 TTL）
  → 白名单校验（DM: senderId / 群聊: conversationId）
  → 命令归一化（/reset /clear 新会话 → /new）
  → im-session-map 查/建 Pi 会话（独立目录 chat/im/<会话ID>.jsonl）
  → piManager.prompt(text, images, cwd, sessionPath)
  → Pi SDK 回复（事件流 message_update 增量 / message_end 完成）
  → im-reply 转钉钉（P0: sendMessage 纯文本 / P1: streamAICard 流式）
```

---

## 3. 新增依赖

```bash
npm install dingtalk-stream axios form-data qrcode-terminal
```

| 包 | 版本 | 用途 |
|---|---|---|
| `dingtalk-stream` | ^2.1.4 | 钉钉官方长连接 SDK（WebSocket，免公网回调） |
| `axios` | ^1.14.0 | 钉钉开放平台 REST API（发消息、上传媒体） |
| `form-data` | ^4.0.0 | 媒体文件 multipart 上传 |
| `qrcode-terminal` | ^0.12.0 | 扫码登录（个人模式，可选） |

全部进 `dependencies`（electron-builder 打进 asar）。纯 JS，无原生依赖，无需 asarUnpack。

---

## 4. 主进程改动明细（核心）

### 4.1 IM 配置读写：`src/main/im/im-config.ts`（新建）

凭据**不存 settings.json**（避免和 Pi 配置混在一起），单独 `im-config.json`，路径跟随数据目录（`getAgentDir()/im-config.json`）：

```ts
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { getAgentDir } from "../pi/session-manager"; // 复用数据目录解析

export interface ImConfig {
  enabled: boolean;          // IM 总开关
  dingtalk?: {
    clientId: string;        // 钉钉企业内部应用 Client ID（AppKey）
    clientSecret: string;    // Client Secret（AppSecret）
    robotCode?: string;      // 机器人编码
  };
}

export async function readImConfig(): Promise<ImConfig> {
  try {
    const raw = await readFile(join(getAgentDir(), "im-config.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return { enabled: false }; // 默认关闭
  }
}

export async function writeImConfig(cfg: ImConfig): Promise<void> {
  const dir = getAgentDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "im-config.json"), JSON.stringify(cfg, null, 2), "utf-8");
}
```

> 参考项目的凭据管理（`src/config/accounts.ts`）：**凭据不进 process.env**（避免被子进程继承/日志泄露），启动时从配置注入 `client.connect({ clientId, clientSecret })`——照此办理。

### 4.2 钉钉连接层：`src/main/im/dingtalk-connection.ts`（新建）

照搬参考项目 `src/core/connection.ts` 的机制（去掉 openclaw/plugin-sdk 类型依赖），核心三件套：

**① 心跳（应用层，10s 间隔 / 20s 超时）**——关闭 SDK 内置 keepAlive，用自定义心跳：

```ts
const HEARTBEAT_INTERVAL = 10 * 1000;
const HEARTBEAT_TIMEOUT = 20 * 1000;

// client.connect({ ... keepAlive: false })  ← 关闭内置，用下面的应用层心跳
setInterval(() => {
  // 发送 ping，若 20s 内无 pong → 触发 doReconnect()
}, HEARTBEAT_INTERVAL);
```

**② 指数退避无限重连**（直接照搬参考项目 `connection.ts:259-263`）：

```ts
function calculateBackoffDelay(attempt: number): number {
  const exponentialDelay = BASE_BACKOFF_DELAY * Math.pow(2, attempt); // BASE=2000ms
  const jitter = Math.random() * 1000; // 0-1 秒随机抖动
  return Math.min(exponentialDelay + jitter, MAX_BACKOFF_DELAY);      // MAX=30s
}
```

重连要点（参考项目 `connection.ts:265+`）：`doReconnect()` 用 `isReconnecting` 标志防并发；先 `client.disconnect()` 旧连接 → `client.connect()` → **立即重挂 pong/message/close 监听**（避免 keepAlive 的 pong 回来时 listener 还没挂被丢）→ 等 open 事件（最多 10s）确认建立。

**③ 消息去重（5 分钟 TTL，accountId 隔离）**（照搬参考项目 `utils/utils-legacy.ts:267`）：

```ts
// accountId 前缀隔离：群聊 @多个机器人时 msgId 相同，不隔离第二个机器人会被误判重复
const scopedProtocolId = protocolMessageId ? `${accountId}:${protocolMessageId}` : undefined;
const scopedBusinessId = businessMsgId ? `${accountId}:${businessMsgId}` : undefined;

const isDuplicate =
  (scopedProtocolId && isMessageProcessed(scopedProtocolId)) ||
  (scopedBusinessId && isMessageProcessed(scopedBusinessId));
if (isDuplicate) return true; // 重复，跳过

// 首次处理：两个 ID 都标记（不能提前 return，否则漏标记另一个 ID）
if (scopedProtocolId) markMessageProcessed(scopedProtocolId);
if (scopedBusinessId) markMessageProcessed(scopedBusinessId);
return false;
```

`isMessageProcessed` / `markMessageProcessed`：内部 `Map<string, number>`（msgId → 时间戳），每次查询清理超过 5 分钟的旧条目。

### 4.3 会话映射：`src/main/im/im-session-map.ts`（新建）

**核心职责**：`IM会话ID → Pi 会话路径` 的映射，持久化（重启后 IM 会话历史连续）。

```ts
// 会话 ID 规则（照搬参考项目 message-handler.ts 的隔离粒度）：
//   私聊: userId        （每个用户一个会话）
//   群聊: conversationId（每个群一个会话）
//   可选细化: `${conversationId}:${senderId}`（群内按人隔离）

const IM_CWD = join(getAgentDir(), "chat", "im"); // 独立目录，与桌面壳会话隔离

export class ImSessionMap {
  private map: Record<string, string> = {}; // 会话ID → sessionPath

  async ensureSession(sessionId: string): Promise<string> {
    if (this.map[sessionId]) return this.map[sessionId];
    const path = await piManager.newSession(IM_CWD); // 复用桌面壳会话创建
    this.map[sessionId] = path!;
    await this.persist();
    return path!;
  }
  // load() 启动时读 im-session-map.json；persist() 每次新增后写回
}
```

> ⚠️ 复用 `piManager.newSession(IM_CWD)`：返回新建会话路径（`string | null`，2026-07-31 已改造）；IM 会话全落 `chat/im/` 目录，与桌面壳会话文件互不干扰。

### 4.4 消息处理：`src/main/im/im-message-handler.ts`（新建）

流程（照搬参考项目 message-handler.ts 的骨架，agent 调用换成 Pi）：

```ts
export async function handleImMessage(params: {
  accountId: string;
  data: any; // 钉钉消息事件体
}) {
  const { accountId, data } = params;

  // 1. 去重（见 4.2）
  if (checkAndMarkDingtalkMessage(accountId, data.msgId, data.msgId)) return;

  // 2. 私聊/群聊分流 + 白名单（参考项目 message-handler.ts:990-1090）
  const isGroup = data.conversationType === "2"; // 1=单聊 2=群聊
  const senderId = data.senderStaffId || data.senderId;
  const conversationId = data.conversationId;

  // 3. 命令归一化（参考项目 message-handler.ts:1168）
  //    /reset、/clear、新会话 等别名 → 统一为 /new（新建会话）
  const normalized = normalizeCommand(data.text);
  if (normalized === "/new") {
    await sessionMap.delete(conversationId); // 新会话 = 丢弃映射
    await imReply.sendText(conversationId, "已开启新会话 ✓");
    return;
  }

  // 4. 会话映射 → Pi prompt
  const sessionPath = await sessionMap.ensureSession(conversationId);
  await piManager.prompt(normalized.text, undefined, IM_CWD, sessionPath);
  // 5. 回复由事件流驱动（见 4.5），此处不等待
}
```

**事件订阅隔离（关键）**：IM 会话的 `message_update`/`message_end` **不能广播到桌面 UI**（避免聊天窗口出现 IM 的流式消息）。方案：`im-message-handler` 用 `unit.subscribe()` 单 unit 订阅（或监听 `pi:event` 时按 `event.sessionPath` 是否属于 `chat/im/` 前缀过滤），IM 回复与 UI 各走各的。

### 4.5 回复分发：`src/main/im/im-reply.ts`（新建）

**P0（纯文本）**：

```ts
// 钉钉开放平台 REST：机器人发单聊/群聊消息
// POST https://api.dingtalk.com/v1.0/robot/groupMessages/send  （群）
// POST https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend（单聊）
// Authorization: Bearer <client 的 accessToken>（dingtalk-stream 提供 token 刷新）
await axios.post(url, { msgParam: JSON.stringify({ content: text }), ... });
```

**P1（AI Card 流式打字机）**：照搬参考项目 `reply-dispatcher.ts` 的 `streamAICard` 调用点（`:614`）：

```ts
// 钉钉 AI Card：先创建卡片 → 流式期间 updateCard 增量内容 → 完成后 finishCard
await streamAICard({
  conversationId, msgId: createdCardId,
  content: (info) => info.kind === "delta" ? info.deltaText : info.text,
  onFinal: () => imReply.sendText(conversationId, "✅ 已完成"),
});
```

流式内容源 = Pi 事件流 `message_update`（delta 增量）；`message_end`（final）时收尾。参考项目内置令牌桶限流（QPS 保护），照搬。

### 4.6 网关总控：`src/main/im/im-gateway.ts`（新建）

```ts
export class ImGateway {
  private connection: DingtalkConnection | null = null;
  private status: "off" | "connecting" | "connected" | "error" = "off";

  async start(cfg: ImConfig): Promise<void> { /* 校验凭据 → 建连接 → 订阅消息 */ }
  async stop(): Promise<void> { /* 断开连接、清理订阅、保存映射 */ }
  getStatus() { return this.status; }
}
```

生命周期规则：
- **启动时**：读 `im-config.json` → `enabled && dingtalk` 存在 → `start()`
- **配置变更时**：先 `stop()` 再 `start()`（钉钉凭据变更需重连）
- **窗口关闭**：托盘常驻，主进程不退 → **IM 照常收消息**（不依赖窗口）
- **应用退出**：`disposePi()` 前 `gateway.stop()`

### 4.7 IPC：`src/main/ipc-handlers.ts`（修改）

```ts
ipcMain.handle("pi:imGetConfig", async () => (await readImConfig()));
ipcMain.handle("pi:imSaveConfig", async (_, cfg) => {
  await writeImConfig(cfg);
  await gateway.restart(cfg); // 先 stop 再 start
});
ipcMain.handle("pi:imGetStatus", () => gateway.getStatus());
// 状态变更主动推送：gateway → webContents.send("pi:imStatus", status)
```

---

## 5. preload 桥接（修改）

`src/preload/index.ts` + `src/preload/api.d.ts`：

```ts
// preload/index.ts
imGetConfig: () => ipcRenderer.invoke("pi:imGetConfig"),
imSaveConfig: (cfg: any) => ipcRenderer.invoke("pi:imSaveConfig", cfg),
imGetStatus: () => ipcRenderer.invoke("pi:imGetStatus"),
onImStatus: (callback: (s: any) => void) => {
  const l = (_: any, s: any) => callback(s);
  ipcRenderer.on("pi:imStatus", l);
  return () => ipcRenderer.removeListener("pi:imStatus", l);
},
```

---

## 6. 渲染层改动（P0 范围）

### 6.1 `src/renderer/sidebar/ImSettings.tsx`（新建）

设置页「IM 接入」区块（复用 `ToolsSettings.tsx` / `ContextPage` 样式）：

- **总开关**（`enabled` checkbox）
- 钉钉凭据输入（clientId / clientSecret，`type="password"`）
- 连接状态指示（off / connecting / connected / error，实时订阅 `pi:imStatus`）
- 「保存并连接」按钮 → `imSaveConfig`

### 6.2 `src/renderer/sidebar/SettingsPage.tsx`（修改）

NAV_ITEMS 加 `{ key: "im", icon: MessageSquare, labelKey: "settings.im" }`；渲染分支加 `<ImSettings />`。

### 6.3 i18n：`src/shared/i18n/index.ts`

```ts
// zh
"settings.im": "IM 接入",
"im.enabled": "启用 IM 接入",
"im.dingtalk": "钉钉",
"im.clientId": "Client ID (AppKey)",
"im.clientSecret": "Client Secret (AppSecret)",
"im.status.off": "未连接",
"im.status.connecting": "连接中…",
"im.status.connected": "已连接",
"im.status.error": "连接异常",
"im.save": "保存并连接",
```

（en 同步一份）

---

## 7. 会话并发与隔离设计

| 问题 | 方案 |
|---|---|
| IM 会话与桌面会话混在一起 | IM 会话全落 `getAgentDir()/chat/im/` 独立目录 |
| 同一 IM 会话连续多条消息 | 复用 prompt 的 cwd 级并发机制（`piManager.prompt` 内部按 unit 排队），或参考 ChatComposer 的 enqueueMessage |
| IM 流式事件串进桌面 UI | 事件订阅按 `sessionPath` 前缀 `chat/im/` 过滤（见 4.4） |
| 多实例桌面壳同时跑 | IM 会话 jsonl 由 SDK 并发控制；映射文件最后写者胜（可接受，可加锁文件） |
| 钉钉重复推送 | accountId:msgId 去重缓存（见 4.2） |

---

## 8. 边界与风险

1. **钉钉 stream 依赖**：`dingtalk-stream` 是钉钉官方包，升级跟随 npm；WebSocket 协议变更由官方兼容
2. **凭据安全**：clientSecret 存 `im-config.json`（数据目录内，非代码库）；参考项目原则——不进 process.env、不进日志
3. **白名单缺失**：不做白名单 = 任何能 @ 机器人的人都能用 agent（能执行 bash 的工具集），**P0 必须带白名单**（DM: senderId 列表 / 群: conversationId 列表，配置在 im-config.json）
4. **流式实现量**：P1 的 AI Card 流式是 P0 的 3~4 倍工作量，先跑通 P0
5. **工具能力暴露**：IM 会话默认激活全部 7 个工具（含 bash）——钉钉侧等于开放了远程执行，白名单 + 后续可给 IM 会话单独降级工具集（`setActiveToolsByName` 按会话粒度）
6. **媒体/图片**：P1 接入图片时复用 `docs/image-input.md` 的 `ImageContent` 链路（钉钉下载 mediaId → base64 → prompt images）

---

## 9. 验收清单

### P0（文本收发）
- [ ] 设置页填凭据 → 保存 → 状态变「已连接」
- [ ] 私聊机器人发文本 → agent 回复纯文本
- [ ] 群聊 @机器人 → 回复
- [ ] 连续两条消息 → 按序回复（不互相打断）
- [ ] 白名单外用户 @机器人 → 收到"无权限"提示
- [ ] `/reset` → 开启新会话（历史隔离）
- [ ] 断网/重启 → 自动重连，会话历史连续
- [ ] 窗口关闭（托盘）→ IM 照常收发
- [ ] 桌面 UI 聊天列表**不出现** IM 会话的流式消息
- [ ] 重复消息推送不重复回复

### P1（流式 + 图片）
- [ ] AI Card 流式打字机效果
- [ ] 发图片给机器人 → agent 可见图片内容
- [ ] agent 回复引用图片/生成图片 → 钉钉可看
- [ ] `/new` 命令开启新会话

---

## 10. 文件清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `package.json` | 改 | + dingtalk-stream / axios / form-data / qrcode-terminal |
| `src/main/im/im-config.ts` | 新建 | 配置读写（getAgentDir()/im-config.json） |
| `src/main/im/dingtalk-connection.ts` | 新建 | 钉钉 stream 连接（心跳/退避重连/去重，照搬参考项目） |
| `src/main/im/im-session-map.ts` | 新建 | 会话映射 + 持久化 |
| `src/main/im/im-message-handler.ts` | 新建 | 消息路由/白名单/命令归一化/调 prompt |
| `src/main/im/im-reply.ts` | 新建 | 回复分发（P0 文本 / P1 AI Card 流式） |
| `src/main/im/im-gateway.ts` | 新建 | 总控（生命周期/状态/重启） |
| `src/main/ipc-handlers.ts` | 改 | + pi:im* 4 个 handler + 状态推送 |
| `src/main/index.ts` | 改 | 启动时初始化 ImGateway |
| `src/preload/index.ts` + `api.d.ts` | 改 | + im 桥接 4 个方法 |
| `src/renderer/sidebar/ImSettings.tsx` | 新建 | 设置 UI |
| `src/renderer/sidebar/SettingsPage.tsx` | 改 | +「IM 接入」nav 项 |
| `src/shared/i18n/index.ts` | 改 | + im.* 中英词条 |
| `node_modules/@earendil-works/*` | **零改动** | 项目原则 |

---

## 11. 实施顺序建议

1. `im-config.ts`（配置读写）→ 2. `dingtalk-connection.ts`（先连上、打印收到的消息）→ 3. `im-session-map.ts` + `im-message-handler.ts`（文本收发打通）→ 4. `im-reply.ts` 纯文本回复 → 5. IPC + preload + 设置 UI（可配置化）→ 6.（P1）AI Card 流式 + 图片
