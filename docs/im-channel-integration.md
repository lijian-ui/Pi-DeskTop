# IM 渠道接入开发指南

> 本文档面向需要为 pi-desktop 接入**新 IM 渠道**（QQ、飞书、企业微信、Telegram…）的开发者。
> 当前已实现：**钉钉（DingTalk）P0**（文本收发 + 白名单 + 断线重连）。
> 微信参考实现：`参考项目/tencent-weixin-openclaw-weixin-2.4.3`（尚未移植，本文档含差异说明）。
> 底层架构：`docs/im-gateway.md`（设计）、`docs/im-gateway-weixin.md`（微信方案）。

---

## 一、架构总览

```
IM 渠道 (钉钉/微信/QQ/飞书…)
        │  ← 渠道各自的长连接/轮询/扫码登录
        ▼
┌─────────────────────────────────────────────────────────────┐
│  ImChannelAdapter（每个渠道实现一份）                         │
│  · start()/stop()/getStatus()                                 │
│  · 收到消息 → 归一化为 ImInboundMessage → 调 onMessage()      │
│  · 发送回复 → sendText(target, text)                          │
└─────────────────────────────────────────────────────────────┘
        │ onMessage / sendText
        ▼
┌─────────────────────────────────────────────────────────────┐
│  ImGateway（渠道无关，一个实例管所有渠道）                     │
│  1. 白名单校验（默认拒绝）                                     │
│  2. /reset 命令 → 重置会话                                     │
│  3. 会话映射：sessionKey → Pi 会话文件（chat/im/<channel>/）    │
│  4. 调用 piManager.prompt() 驱动 Pi 智能体                     │
│  5. 监听 Pi 事件流 → message_end 时把回复路由回对应渠道         │
└─────────────────────────────────────────────────────────────┘
        │ prompt() / imForwarder（事件钩子）
        ▼
┌─────────────────────────────────────────────────────────────┐
│  PiDeskSessionManager（SDK 封装，桌面端与 IM 共用）            │
└─────────────────────────────────────────────────────────────┘
```

**关键设计原则：**

1. **渠道无关**：ImGateway 只依赖 `ImChannelAdapter` 接口，不感知任何渠道协议细节。新渠道 = 新增一个 adapter + 注册，骨架零改动。
2. **会话隔离**：IM 会话落在 `chat/im/<channel>/` 子目录，**不广播到桌面 UI**（经 `imForwarder` 钩子消费），桌面聊天与 IM 聊天互不干扰。
3. **持久化**：会话映射（`chat/im-session-map.json`）与渠道配置（`~/.pi/agent/im-config.json`）落盘，重启后续聊。
4. **安全底线**：白名单**默认拒绝**——没有白名单配置时任何 IM 消息都不处理（因为智能体有 bash 工具，必须防陌生人）。

---

## 二、核心文件地图（代码路径）

```
src/main/im/
├── types.ts                      ★ 渠道无关接口定义（先读这个）
├── im-config.ts                  渠道配置读写（im-config.json）
├── im-gateway.ts                 ★ 渠道注册表 + 生命周期 + 回复路由
├── im-session-map.ts             会话映射（channel:peer → Pi 会话文件）
├── im-whitelist.ts               白名单校验（默认拒绝）
└── dingtalk/                     ★ 钉钉渠道（新渠道参照这个目录）
    ├── dingtalk-connection.ts    长连接（DWClient + 心跳 + 退避重连 + 去重）
    ├── dingtalk-adapter.ts       ★ 实现 ImChannelAdapter（消息解析 + 发送）
    └── dingtalk-reply.ts         回复发送（accessToken 缓存 + REST）

# 接线点（新渠道基本不用动，除非要加 IPC）
src/main/index.ts                 ImGateway 启动 + 状态推送（pi:imStatus）
src/main/ipc-handlers.ts          pi:imGetConfig / imSaveConfig / imGetStatus
src/main/pi/session-manager.ts    imForwarder 钩子（IM 会话事件不广播桌面 UI）
src/preload/index.ts              preload 暴露
src/preload/api.d.ts              ImConfig 等类型

# 渲染层
src/renderer/im/ImPage.tsx        「IM 接入」设置页（开关/凭据/白名单/状态徽章）
src/renderer/im/ImPage.module.css
src/renderer/layout/Sidebar.tsx   「扩展」下方导航「IM 接入」（mainView: "im"）
src/renderer/layout/MainPanel.tsx 路由
src/shared/i18n/index.ts          im.* 文案（中英）
```

---

## 三、接口定义（`src/main/im/types.ts`）

新渠道必须完整实现 `ImChannelAdapter`：

```ts
export type ImStatus = "off" | "connecting" | "connected" | "error";

/** Image payload passed to Pi prompts (mirrors SDK ImageContent). */
export interface ImImage {
  type: "image";
  data: string; // base64
  mimeType: string;
}

/** Normalized inbound message handed to the gateway by a channel adapter. */
export interface ImInboundMessage {
  /** Channel id, e.g. "dingtalk". */
  channel: string;
  /**
   * Session key — the granularity at which a Pi conversation is persisted.
   * Convention: `${channel}:${peer}` where peer is channel-specific
   * (DingTalk: conversationId; WeChat: from_user_id; …). The gateway hashes
   * this into a per-channel session directory under chat/im/.
   */
  sessionKey: string;
  /** Text payload (media stripped by the adapter into images). */
  text: string;
  images?: ImImage[];
  /** Raw channel payload, for debugging / future fields. */
  raw?: unknown;
}

/** One channel's connection + send capability. */
export interface ImChannelAdapter {
  readonly channel: string;
  /** Connect (stream / long-poll / scan-login). Resolves when ready. */
  start(): Promise<void>;
  /** Disconnect and release resources. */
  stop(): Promise<void>;
  getStatus(): ImStatus;
  /** Injected by the gateway once registered. */
  onMessage?: (msg: ImInboundMessage) => void;
  /** Injected by the gateway; fires on any status transition. */
  onStatusChange?: (status: ImStatus) => void;
  /** Send a text reply to a peer (target = the raw peer id from sessionKey). */
  sendText(target: string, text: string): Promise<void>;
  /** Optional "typing…" indicator. */
  sendTyping?(target: string): Promise<void>;
}
```

**几个容易踩的约定：**

- `channel` 必须是稳定字符串（`"qq"` / `"feishu"`…），它会出现在：会话目录名 `chat/im/<channel>/`、配置键、白名单键、状态 Map 的 key。
- `sessionKey` 固定格式 `${channel}:${peer}`。`peer` 是该渠道里**唯一标识一段对话**的原生 id（钉钉=conversationId 或 userId；微信=from_user_id；QQ=group_openid 或 user_openid）。
- adapter 收到消息后**只做归一化**（解析协议 → 填 `ImInboundMessage`），**不要**在这里做白名单、会话创建、智能体调用——那些是 ImGateway 的事。
- 如果渠道支持图片，把图片 base64 塞进 `images`（P1 能力，当前钉钉 P0 只传文本）。

---

## 四、接入新渠道：七步走

以下步骤以"接入 QQ"为例（飞书/Telegram 同理）。每个步骤都标注了**要改的文件**和**代码片段**。

### 步骤 1：定义渠道配置（`src/main/im/im-config.ts`）

```ts
export interface QQConfig {
  appId: string;
  appSecret: string;
}

export interface ImWhitelist {
  /** DingTalk: allowlisted DM senders (userId / staffId). */
  dingtalkDm?: string[];
  /** DingTalk: allowlisted group conversationIds. */
  dingtalkGroups?: string[];
  /** QQ: allowlisted group openids. */
  qqGroups?: string[];
  /** QQ: allowlisted user openids. */
  qqUsers?: string[];
}

export interface ImConfig {
  enabled: boolean;
  dingtalk?: DingtalkConfig;
  qq?: QQConfig;              // ← 新增
  whitelist?: ImWhitelist;
}
```

### 步骤 2：实现连接层（新建 `src/main/im/qq/qq-connection.ts`）

参照 `dingtalk-connection.ts` 的模式（协议代码可照搬各官方 SDK 或参考项目，框架代码丢弃）：

- 连接建立（stream / 长轮询 / WebSocket，按渠道官方机制）
- 心跳保活（钉钉是 10s ping / 20s 超时，见 `HEARTBEAT_INTERVAL` / `HEARTBEAT_TIMEOUT` 常量）
- **指数退避重连**（`BASE_BACKOFF_DELAY` 2s 起步，×2 递增，`MAX_BACKOFF_DELAY` 30s 封顶，加 jitter 抖动）
- **消息去重**（`checkAndMark()`，按消息 id + 5 分钟 TTL）

核心骨架（可直接复制改造）：

```ts
export interface QQConnectionOptions {
  appId: string;
  appSecret: string;
  onMessage: (rawData: string) => void;
  onStatusChange?: (connected: boolean) => void;
}

export class QQConnection {
  private stopped = false;
  private isReconnecting = false;
  private reconnectAttempts = 0;
  private connected = false;

  async connect(): Promise<void> {
    // 1. 建立连接（各渠道 SDK 不同）
    // 2. 注册消息回调 → this.opts.onMessage(raw)
    // 3. 启动心跳
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // 断开连接、清理定时器
  }

  private async doReconnect(immediate: boolean) {
    if (this.isReconnecting || this.stopped) return;
    // 指数退避 + 重连（照搬 dingtalk-connection.ts 的 backoffDelay/doReconnect）
  }
}
```

### 步骤 3：实现 Adapter（新建 `src/main/im/qq/qq-adapter.ts`）——**最关键的一步**

实现 `ImChannelAdapter`，把渠道消息转成 `ImInboundMessage`，把 `sendText` 映射到渠道 REST API。完整模板：

```ts
/**
 * QQ channel adapter — implements ImChannelAdapter over the QQ connection.
 */
import type {
  ImChannelAdapter,
  ImInboundMessage,
  ImStatus,
} from "../types";
import type { QQConfig } from "../im-config";
import { QQConnection } from "./qq-connection";
import { sendQQText } from "./qq-reply";

interface QQMessageData {
  // ← 按 QQ 官方回调 payload 填写字段
  fromId?: string;        // 会话 id（群/单聊）
  chatType?: number;      // 1 单聊 / 2 群聊
  content?: string;
  msgId?: string;
}

export class QQAdapter implements ImChannelAdapter {
  readonly channel = "qq";
  private conn: QQConnection | null = null;
  private status: ImStatus = "off";

  onMessage?: (msg: ImInboundMessage) => void;
  onStatusChange?: (status: ImStatus) => void;

  constructor(private cfg: QQConfig) {}

  private setStatus(s: ImStatus) {
    this.status = s;
    this.onStatusChange?.(s);
  }

  async start(): Promise<void> {
    if (this.conn) await this.stop();
    this.setStatus("connecting");
    this.conn = new QQConnection({
      appId: this.cfg.appId,
      appSecret: this.cfg.appSecret,
      onMessage: (raw) => this.handleRaw(raw),
      onStatusChange: (connected) =>
        this.setStatus(connected ? "connected" : "connecting"),
    });
    try {
      await this.conn.connect();
      this.setStatus("connected");
    } catch (err) {
      this.setStatus("error");
      throw err;
    }
  }

  async stop(): Promise<void> {
    await this.conn?.stop();
    this.conn = null;
    this.setStatus("off");
  }

  getStatus(): ImStatus {
    return this.status;
  }

  private handleRaw(rawData: string) {
    let data: QQMessageData;
    try {
      data = JSON.parse(rawData);
    } catch {
      return; // ignore non-JSON frames
    }
    // ← 过滤：只处理文本消息；群聊要求 @机器人（避免噪音）
    const peer = data.fromId ?? "";
    if (!peer) return;

    this.onMessage?.({
      channel: "qq",
      sessionKey: `qq:${peer}`,
      text: data.content ?? "",
      raw: { msgId: data.msgId },
    });
  }

  async sendText(target: string, text: string): Promise<void> {
    await sendQQText(this.cfg, target, text);
  }
}
```

**⚠️ 群聊 @机器人过滤（重要）：** 钉钉的实现里，群消息必须 `isInAtList === true` 才处理，否则忽略——这是为了避免机器人在群里被疯狂刷屏。QQ/飞书接入时同样要处理（QQ 的 at 标记字段不同，按官方 payload 取）。

### 步骤 4：回复发送（新建 `src/main/im/qq/qq-reply.ts`）

参照 `dingtalk-reply.ts`：accessToken 缓存 + REST 发送。

```ts
import axios from "axios";
import type { QQConfig } from "../im-config";

const TOKEN_CACHE_TTL_MS = 1000 * 60 * 55; // 略低于官方过期时间

interface TokenCacheEntry { token: string; expiryMs: number; }
const tokenCache = new Map<string, TokenCacheEntry>();

async function getAccessToken(cfg: QQConfig): Promise<string> {
  const key = cfg.appId;
  const cached = tokenCache.get(key);
  if (cached && cached.expiryMs > Date.now() + 60_000) return cached.token;
  // ← 调 QQ 官方 token 接口
  const res = await axios.post(`https://.../token`, { /* ... */ });
  const token = res.data?.access_token as string;
  tokenCache.set(key, { token, expiryMs: Date.now() + 2 * 60 * 60 * 1000 });
  return token;
}

export async function sendQQText(
  cfg: QQConfig,
  target: string,
  text: string,
): Promise<void> {
  const token = await getAccessToken(cfg);
  // ← 调 QQ 官方发消息接口（群聊/单聊按 target 类型路由）
  await axios.post(
    `https://.../send`,
    { /* target, text */ },
    { headers: { Authorization: `Bearer ${token}` } },
  );
}
```

### 步骤 5：在网关注册（`src/main/im/im-gateway.ts`）

两处修改：

```ts
import { QQAdapter } from "./qq/qq-adapter";   // ← 新增 import

// applyConfig() 里，在钉钉分支后面加：
async applyConfig(cfg: ImConfig): Promise<void> {
  await this.stopAll();
  this.whitelist = cfg.whitelist;
  this.adapters = [];
  this.pending.clear();

  if (cfg.enabled && cfg.dingtalk?.clientId && cfg.dingtalk.clientSecret) {
    const adapter = new DingtalkAdapter(cfg.dingtalk);
    this.register(adapter);
    await adapter.start().catch((err) => {
      console.error("[im:dingtalk] start failed:", err?.message);
      this.setChannelStatus("dingtalk", "error");
    });
  }

  // ← 新增：QQ 分支（镜像钉钉）
  if (cfg.enabled && cfg.qq?.appId && cfg.qq.appSecret) {
    const adapter = new QQAdapter(cfg.qq);
    this.register(adapter);
    await adapter.start().catch((err) => {
      console.error("[im:qq] start failed:", err?.message);
      this.setChannelStatus("qq", "error");
    });
  }

  this.broadcastStatus();
}
```

**注意：** 网关会自动处理 `handleInbound`（白名单 → /reset → 会话映射 → prompt → 回复路由），**这些逻辑新渠道无需改动**——它们只依赖 `adapter.channel` / `sessionKey` / `sendText`，对渠道本身无感知。

### 步骤 6：扩展白名单（`src/main/im/im-whitelist.ts`）

```ts
export function isAllowed(cfg: ImWhitelist | undefined, sessionKey: string): boolean {
  if (!cfg) return false; // no whitelist → deny by default
  const [channel, peer] = sessionKey.split(":") as [string, string | undefined];
  if (!peer) return false;

  if (channel === "dingtalk") {
    if (cfg.dingtalkGroups?.includes(peer)) return true;
    if (cfg.dingtalkDm?.includes(peer)) return true;
    return false;
  }

  // ← 新增：QQ
  if (channel === "qq") {
    if (cfg.qqGroups?.includes(peer)) return true;
    if (cfg.qqUsers?.includes(peer)) return true;
    return false;
  }

  return false; // unknown channel → deny
}
```

### 步骤 7：渲染层设置页（`src/renderer/im/ImPage.tsx` + i18n）

在 `ImPage.tsx` 的钉钉 section 后面加一个 QQ section（镜像钉钉的结构）：

```tsx
{/* QQ section（镜像钉钉，新增） */}
<div className={styles.section}>
  <div className={styles.sectionHead}>
    <span className={styles.sectionTitle}>{t("im.qq")}</span>
    <span className={`${styles.badge} ${styles["badge_" + (status["qq"] ?? "off")]}`}>
      {t(`im.status.${status["qq"] ?? "off"}`)}
    </span>
  </div>
  <div className={styles.field}>
    <span className={styles.fieldLabel}>{t("im.qqAppId")}</span>
    <input
      className={styles.fieldInput}
      type="text"
      value={config.qq?.appId ?? ""}
      onChange={(e) =>
        setConfig({
          ...config,
          qq: { ...(config.qq ?? { appId: "", appSecret: "" }), appId: e.target.value },
        })
      }
    />
  </div>
  {/* …appSecret 同理（type="password"）… */}
</div>

{/* 白名单也加 QQ 两组 textarea（镜像钉钉） */}
```

i18n（`src/shared/i18n/index.ts`，中英都要）：

```ts
// zh
"im.qq": "QQ",
"im.qqAppId": "AppID",
"im.qqAppSecret": "AppSecret",
"im.whitelistQqUsers": "QQ 白名单（用户 openid）",
// en
"im.qq": "QQ",
"im.qqAppId": "AppID",
"im.qqAppSecret": "AppSecret",
"im.whitelistQqUsers": "QQ whitelist (user openids)",
```

> **可选：** 如果新渠道需要额外 IPC（如获取扫码登录二维码推送给前端），在 `src/main/ipc-handlers.ts` 加 `pi:imXxx` handler + `src/preload/index.ts` 暴露 + `src/preload/api.d.ts` 类型——参考现有 `pi:imGetConfig / imSaveConfig / imGetStatus` 三件套（ipc-handlers.ts:269-284）。

---

## 五、钉钉完整范例（现有实现的代码路径速查）

接入新渠道时对照钉钉的三个文件即可：

| 文件 | 角色 | 要点 |
|---|---|---|
| `src/main/im/dingtalk/dingtalk-connection.ts` | 连接层 | `DWClient` WebSocket 长连接；`HEARTBEAT_INTERVAL=10s` ping / `HEARTBEAT_TIMEOUT=20s`；`BASE_BACKOFF_DELAY=2s` 指数退避 + jitter；`DEDUP_TTL_MS=5min` 消息去重；`registerCallbackListener(TOPIC_ROBOT, …)` 注册消息回调 |
| `src/main/im/dingtalk/dingtalk-adapter.ts` | 适配层 | `handleRaw()`：JSON 解析 → 只收文本消息 → 群聊必须 @机器人（`isInAtList`）→ 归一化成 `ImInboundMessage`；`sendText()` 按 `peerInfo` 记忆的单/群聊类型路由到不同 REST 端点 |
| `src/main/im/dingtalk/dingtalk-reply.ts` | 发送层 | `getAccessToken()`：`POST /v1.0/oauth2/accessToken`，缓存 55 分钟；群聊 `POST /v1.0/robot/groupMessages/send`、单聊 `POST /v1.0/robot/oToMessages/batchSend` |

**发送路由要点（钉钉）：** `sendText(target, text)` 的 `target` 是 sessionKey 冒号后的 peer（`conversationId` 或 `userId`），adapter 内部用 `peerInfo` Map 记忆该 peer 是单聊还是群聊，从而选对 REST 端点。新渠道若协议对单聊/群聊区分端点，也用同样模式。

---

## 六、微信渠道差异说明（参考项目已就绪）

微信参考实现：`参考项目/tencent-weixin-openclaw-weixin-2.4.3`（MIT，协议代码可照搬）。与钉钉的主要差异：

| 维度 | 钉钉 | 微信 |
|---|---|---|
| 连接方式 | WebSocket stream 长连接（推送） | **HTTP 长轮询** getupdates（拉取） |
| 登录方式 | clientId/clientSecret | **扫码登录**（需要处理登录二维码的展示与回调） |
| 消息回调 | 事件订阅 `IM_BOT_MESSAGE` | 长轮询拉取 |
| 流式反馈 | 可做 AI Card 卡片 | `sendtyping` 模拟 + `StreamingMarkdownFilter` 过滤 |
| 发送 | REST robot API | iLink CGI |

微信接线的参考文件：`参考项目/tencent-weixin-openclaw-weixin-2.4.3` 中的 `weixin-api.ts`（iLink CGI）、`weixin-login.ts`（扫码登录）、`weixin-poll.ts`（长轮询循环）、`markdown-filter.ts`（`StreamingMarkdownFilter`，361 行——微信回复 markdown 前必须过过滤，去掉不支持的语法）。

接入时同样走七步：`weixin-api/login/poll` 合成连接层 → `weixin-adapter.ts` 实现 `ImChannelAdapter`（`channel: "weixin"`）→ 注册进 `applyConfig` → 白名单加 `weixin*` 字段 → `ImPage` 加微信 section。

---

## 七、事件流与回复路由机制（不需要新渠道关心，但要理解）

**IM 会话的事件不会进桌面聊天窗口。** 这是通过 `session-manager.ts` 的 `imForwarder` 钩子实现的：

```ts
// src/main/pi/session-manager.ts（subscribeToUnit 内，第 1080-1083 行）
// IM-gateway hook: sessions under chat/im/ are consumed by the gateway
// (reply routing) and must NOT be broadcast to the desktop chat UI.
const sp = unit.activePath;
if (this.imForwarder && sp && this.imForwarder(sp, event)) return; // ← 消费即短路
wc?.send("pi:event", { sessionPath: unit.activePath, cwd: unit.cwd, event });
```

网关侧（`im-gateway.ts`）：

```ts
// init() 时挂上钩子
this.piManager.imForwarder = (sessionPath, event) => {
  return this.handlePiEvent(sessionPath, event as any);
};

// handlePiEvent：只有 IM 会话才消费；message_end 时把最终文本发回渠道
private handlePiEvent(sessionPath: string, event: any): boolean {
  if (!this.sessionMap.hasSessionPath(sessionPath)) return false;
  if (event?.type === "message_end") {
    const pending = this.pending.get(sessionPath);
    if (pending) {
      const text = extractMessageText(event.message);
      if (text) pending.adapter.sendText(pending.target, text).catch(() => {});
      this.pending.delete(sessionPath);
    }
  }
  return true; // consumed — never broadcast IM sessions to the desktop UI
}
```

`pending` Map 是"正在等待回复"的路由表：`handleInbound` 时 `pending.set(sessionPath, { adapter, target })`，`message_end` 时取出回发。**新渠道完全复用这套机制**——只要 adapter 的 `sendText` 正确，回复就会自动路由回去。

---

## 八、注意事项与 FAQ

**Q1：为什么消息处理流程（白名单/会话/prompt）不能写进 adapter？**
因为那是**渠道无关**的公共逻辑，写在 ImGateway 一次，所有渠道复用。adapter 只做"协议翻译"（收消息解析、发消息发送），职责单一，否则接第二个渠道时就要复制一堆逻辑。

**Q2：如何调试新渠道？**
- 看主进程日志：网关错误带 `[im:xxx]` 前缀（如 `[im:dingtalk] connection error`）。
- 状态徽章：设置页每个渠道有 `off/connecting/connected/error` 四态徽章，连不上会显示 error。
- 回复不出现时：先确认 `sendText` 是否能独立发送成功（临时在 adapter 的 `start()` 后发一条测试消息），再排查事件流。

**Q3：图片/语音等多媒体消息怎么办？**
P0 只支持文本。`ImInboundMessage.images` 字段已预留（base64），把媒体解析后塞进 `images`，网关 `prompt()` 已支持传图（`piManager.prompt(msg.text, msg.images, cwd, sessionPath)`）。发送侧对应加 `sendImage?()`（接口已预留可选方法）。

**Q4：一个渠道多账号（多机器人）怎么办？**
当前设计一个渠道一个 adapter 实例。多账号可注册多个同 channel adapter（`channel` 相同但内部带实例 id），`sessionKey` 前缀加账号区分（如 `dingtalk2:conv-xxx`）。这是扩展点，尚未实现。

**Q5：安装依赖时要注意什么？**
渠道 SDK 一般按需安装（钉钉用了 `dingtalk-stream@^2.1.5` + `axios` + `form-data`）。注意：**CJS 的 SDK 在 ESM 主进程里要用 `await import()` 动态加载**（见 `dingtalk-connection.ts` 的 `loadDingtalkStream()`），避免构建期解析问题。`axios` 这类通用依赖加到 `package.json` dependencies。

**Q6：主进程构建有什么坑？**
- 改 `src/main/**` 后必须跑 `npx tsc -p tsconfig.node.json --noEmit`（vite build 的 esbuild 不查类型）。
- 构建/命令前清掉 `CODEBUDDY_SESSION_ID` / `CLAUDE_SESSION_ID`（WorkBuddy 环境注入的 fs shim 会破坏 SDK 的 settings 锁）。
- 若构建报 `EPERM open dist/main/index-*.js`：是残留进程/杀软锁文件，删除 dist 后重建（`rm` 可能被 shim 劫持，用 PowerShell `Remove-Item` 或清环境变量的 node unlink）。

---

## 九、接入清单（Checklist）

- [ ] `im-config.ts`：新增渠道配置类型 + `ImConfig` 字段 + `ImWhitelist` 字段
- [ ] 新建 `src/main/im/<channel>/<channel>-connection.ts`（连接/心跳/退避重连/去重）
- [ ] 新建 `<channel>-adapter.ts`（实现 `ImChannelAdapter`，`channel` 字段唯一）
- [ ] 新建 `<channel>-reply.ts`（accessToken 缓存 + sendText）
- [ ] `im-gateway.ts`：import adapter + `applyConfig` 注册分支
- [ ] `im-whitelist.ts`：`isAllowed` 加 `<channel>` 分支
- [ ] `ImPage.tsx`：加渠道 section + 白名单 textarea
- [ ] `src/shared/i18n/index.ts`：中英文键
- [ ] （如需要）IPC / preload / api.d.ts
- [ ] 双端 tsc + vite build 全绿
- [ ] 实机验证：白名单放行 → 消息进会话 → 回复路由回渠道 → 断网重连 → /reset 新会话
