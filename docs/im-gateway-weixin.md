# Pi Desktop 微信（iLink 官方协议）接入开发文档

> 状态：**方案已定，未开发**（2026-07-31）
> 前置结论：iLink 通道**无申请门槛**（用户此前 Rust 版 agent 已实测接入）
> 参考项目：`参考项目/tencent-weixin-openclaw-weixin-2.4.3/package`（腾讯官方微信渠道插件，MIT）
> 配套文档：`docs/im-gateway.md`（钉钉接入，双渠道共用架构骨架）

---

## 1. 背景与调研结论

### 1.1 需求

通过微信与 Pi agent 沟通——用户扫码授权后，在微信里直接和 agent 对话。

### 1.2 关键突破：腾讯官方 iLink 协议（非非官方库）

个人微信通常只能走 wechaty/itchat 等非官方库（**封号风险**），但腾讯官方为机器人场景开放了 **iLink 通道**：

```
网关：https://ilinkai.weixin.qq.com
接入方式：HTTP 长轮询 + 扫码登录
```

| 能力 | iLink 端点 | 说明 |
|---|---|---|
| 收消息 | `ilink/bot/getupdates` | **HTTP 长轮询**（服务端挂起请求直到新消息/超时） |
| 发消息 | `ilink/bot/sendmessage` | 文本/图片 message_item 列表 |
| 扫码登录 | `ilink/bot/get_bot_qrcode` + `get_qrcode_status` | 二维码 → 35s 长轮询等扫码 → token 存本地 |
| 输入中状态 | `ilink/bot/sendtyping` | 打字机效果的替代方案 |
| 媒体上传 | `ilink/bot/getuploadurl` + CDN | 预签名 URL + AES 加密上传 |
| 配置 | `ilink/bot/getconfig` | 含 typing_ticket |
| 生命周期 | `ilink/bot/msg/notifystart` / `notifystop` | 上线/下线通知 |

**结论**：官方协议 + 扫码授权 + 无申请门槛 → **零封号风险、个人可用**，比钉钉（企业应用资质）更适合个人用户。

### 1.3 参考项目架构（33 文件，5462 行）

| 层 | 文件（参考项目内） | 职责 | 移植到 Pi |
|---|---|---|---|
| API 层 | `src/api/api.ts` | 全部 iLink CGI 调用（纯 Node fetch，零 HTTP 依赖） | ✅ **直接照搬**（无 openclaw 依赖） |
| 登录 | `src/auth/login-qr.ts` + `accounts.ts` | 扫码登录、token 持久化、多账号 | ✅ 照搬（`withFileLock` 换自研） |
| 消息处理 | `src/messaging/process-message.ts`（500 行） | 入站路由 → 会话 → 回复分发 | 骨架照搬，agent 调用换 Pi |
| 发送 | `src/messaging/send.ts` + `markdown-filter.ts` | 消息构造 + **StreamingMarkdownFilter**（361 行） | ✅✅ **微信刚需**——微信不渲染 markdown，必须过滤 |
| 媒体 | `src/media/*` + `src/cdn/*` | 图片下载、**AES-ECB 解密**、silk 语音转码 | 图片复用；语音先不做 |
| 监控 | `src/monitor/monitor.ts`（223 行） | 心跳/状态 | 参考 |

### 1.4 与钉钉方案的差异（连接机制完全不同）

| 维度 | 钉钉 | 微信（本文档） |
|---|---|---|
| 收消息 | WebSocket stream 长连接（主动推送） | **HTTP 长轮询 getupdates**（被动拉取） |
| 登录 | clientId/clientSecret（企业应用） | **扫码登录**（个人可） |
| 流式回复 | AI Card 卡片流式（打字机） | **sendtyping 输入中状态**模拟 |
| markdown | 原生支持 | ❌ 必须过 **StreamingMarkdownFilter** |
| 图片 | mediaId 下载 | CDN 预签名 + **AES-ECB 解密**（`cdn/pic-decrypt.ts`） |
| 依赖 | dingtalk-stream + axios + form-data | **qrcode-terminal + zod**（更轻） |

**共用骨架**（见 `docs/im-gateway.md`）：`im-gateway.ts` 总控、`im-session-map.ts` 会话映射（独立目录 `chat/im/`）、`piManager.prompt()` 入口、事件流隔离——微信渠道复用同一套。

---

## 2. 总体架构与数据流

### 2.1 架构图

```
桌面壳主进程 (Electron)
├── im/
│   ├── im-gateway.ts             总控（复用钉钉方案，按渠道分发）
│   ├── im-session-map.ts         会话映射（复用）
│   ├── weixin/                   ← 新增（微信渠道）
│   │   ├── weixin-api.ts         iLink CGI 调用（照搬 api/api.ts）
│   │   ├── weixin-login.ts       扫码登录（照搬 login-qr.ts）
│   │   ├── weixin-poll.ts        长轮询循环（getupdates 驱动）
│   │   ├── weixin-handler.ts     消息路由 → prompt
│   │   ├── weixin-reply.ts       回复分发（markdown 过滤 + sendtyping）
│   │   ├── markdown-filter.ts    StreamingMarkdownFilter（照搬，361 行）
│   │   └── weixin-media.ts       图片下载/解密/上传（照搬 cdn/*）
├── ipc-handlers.ts              + pi:im*（复用，渠道参数化）
└── 渲染层 SettingsPage          +「IM 接入」区块（渠道选择：钉钉 / 微信）
```

### 2.2 数据流

```
微信用户发消息
  → 长轮询 getupdates（挂起直到新消息/超时，超时返回空重试）
  → 消息解析（msg / item_list）
  → 会话路由（会话Key：账号+渠道+对端 隔离）
  → im-session-map 查/建 Pi 会话（chat/im/<会话ID>.jsonl）
  → piManager.prompt(text, images, cwd, sessionPath)
  → Pi 事件流（message_update 增量 / message_end 完成）
  → StreamingMarkdownFilter 过滤 markdown → sendmessage 回微信
  → （可选）sendtyping 通知"正在输入"
```

---

## 3. 新增依赖

```bash
npm install qrcode-terminal zod
```

| 包 | 版本 | 用途 |
|---|---|---|
| `qrcode-terminal` | ^0.12.0 | 终端显示登录二维码 |
| `zod` | ^4.3.6 | 配置校验（可选，参考项目用它） |

> iLink API 全部用 Node 22 内置 `fetch`，**零 HTTP 依赖**。语音转码（silk-wasm）先不做。

---

## 4. 主进程改动明细（核心）

### 4.1 API 层：`src/main/im/weixin/weixin-api.ts`（新建）

照搬参考项目 `src/api/api.ts`（纯 fetch，无 openclaw 依赖）。三个核心函数：

**① 长轮询收消息（`getUpdates`，参考项目 api.ts:344）**：

```ts
const DEFAULT_LONG_POLL_TIMEOUT_MS = 60_000; // 服务端可挂起请求到该时长

export async function getUpdates(params: {
  baseUrl: string; token?: string; getUpdatesBuf?: string;
}): Promise<GetUpdatesResp> {
  try {
    const rawText = await apiPostFetch({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({ get_updates_buf: params.getUpdatesBuf ?? "", base_info: buildBaseInfo() }),
      token: params.token,
      timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
    });
    return JSON.parse(rawText) as GetUpdatesResp;
  } catch (err) {
    // 长轮询客户端超时是正常现象：返回空响应让调用方重试
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: params.getUpdatesBuf };
    }
    throw err;
  }
}
```

**② 发消息（`sendMessage`，参考项目 api.ts:415）**：

```ts
export async function sendMessage(params: { baseUrl: string; token?: string; body: SendMessageReq }): Promise<void> {
  await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
  });
}

// 消息体构造（参考项目 send.ts:17-45）——message_item 列表，支持 TEXT/图片
const item_list: MessageItem[] = text
  ? [{ type: MessageItemType.TEXT, text_item: { text } }]
  : [];
```

**③ 生命周期 + 辅助**：`notifyStart` / `notifyStop`（`ilink/bot/msg/notifystart|stop`）、`sendTyping`（`ilink/bot/sendtyping`，typing_ticket）、`getConfig`、`getUploadUrl`（媒体）。

`buildBaseInfo()`（每请求必带）：从插件自身 package.json 读取 `name/version/ilink_appid`，标识调用方（参考项目 api.ts:60-90）。

### 4.2 扫码登录：`src/main/im/weixin/weixin-login.ts`（新建）

照搬参考项目 `src/auth/login-qr.ts` 流程：

```ts
// 1. 获取二维码（参考项目 login-qr.ts:79）
//    GET  POST ilink/bot/get_bot_qrcode?bot_type=<type>
//    body: { local_token_list: [...] }   ← 已登录 token 列表，可免扫码复用
//    → 返回 qrcode（二维码内容）+ qrcode_img_content（图片）

// 2. 终端/UI 显示二维码（qrcode-terminal 渲染 or 图片塞给渲染层）

// 3. 长轮询等扫码（参考项目 login-qr.ts:113，35s 超时）
//    GET ilink/bot/get_qrcode_status?qrcode=<qrcode>[&verify_code=<code>]
//    超时/网关错误 → 返回 { status: "wait" } 继续轮询（循环直到成功/失败/取消）

// 4. 成功后：token 保存到 im-config.json（或独立 credentials 文件，加密存储）
```

**要点**：
- `bot_type` 常量（参考项目 `DEFAULT_ILINK_BOT_TYPE`）——与 `package.json` 的 `ilink_appid` 配套
- `local_token_list`：已有 token 时请求二维码会自动带上，实现"换设备不重复扫码"（可选）
- token = 微信账号会话凭据，**必须加密存储**（泄露=账号被接管）

### 4.3 长轮询循环：`src/main/im/weixin/weixin-poll.ts`（新建）

微信是**轮询驱动**（区别于钉钉的事件驱动）：

```ts
export async function pollLoop(deps: {
  api: WeixinApi; sessionMap: ImSessionMap; onMessage: (msg: any) => Promise<void>;
}) {
  let buf = ""; // get_updates_buf：增量游标，服务端用它做消息续传
  while (!deps.stop) {
    const resp = await deps.api.getUpdates({ baseUrl, token, getUpdatesBuf: buf });
    if (resp.ret !== 0) { /* 业务错误，短暂 sleep 后重试 */ }
    if (resp.msgs?.length) buf = resp.get_updates_buf ?? buf;
    for (const msg of resp.msgs ?? []) await deps.onMessage(msg);
    // 无消息（超时返回空）→ 直接下一轮（长轮询天然不忙等）
  }
}
```

**断线重连**：`getUpdates` 抛网络异常 → 指数退避重试（复用钉钉方案的 `calculateBackoffDelay`）；token 失效（ret 指明）→ 触发重新扫码。

### 4.4 消息处理：`src/main/im/weixin/weixin-handler.ts`（新建）

```ts
export async function handleWeixinMessage(msg: any, deps: {
  sessionMap: ImSessionMap; piManager: PiDeskSessionManager; reply: WeixinReply;
}) {
  // 1. 消息解析：msg.item_list 里 TEXT / 图片等
  const text = extractText(msg);            // item_list → 拼接文本
  const media = extractMedia(msg);          // 图片 → weixin-media 下载解密 → ImageContent

  // 2. 会话路由：会话Key = `${accountId}:${msg.from_user_id}`（私聊按人隔离，与钉钉同模式）
  //    参考项目还支持 dmScope 配置（per-account-channel-peer）——多账号时按 账号+渠道+对端 隔离

  // 3. 命令归一化（/reset /clear → /new，复用钉钉方案的 normalizeCommand）

  // 4. 注入 Pi
  const sessionPath = await deps.sessionMap.ensureSession(sessionKey);
  await deps.piManager.prompt(text, images, undefined, sessionPath);
  // 回复由事件流驱动（weixin-reply），此处不等待
}
```

### 4.5 回复分发：`src/main/im/weixin/weixin-reply.ts`（新建）

**① markdown → 微信纯文本（刚需，照搬 `markdown-filter.ts`）**：

微信不渲染 markdown，agent 输出必须过滤。参考项目的 `StreamingMarkdownFilter` 是**字符级状态机**（适合流式增量）：

```ts
export class StreamingMarkdownFilter {
  private buf = "";
  private fence = false;   // 在代码围栏内（``` 内容原样透传）
  private sol = true;      // 行首状态
  private inl: {...} | null = null; // 内联标记累积

  feed(delta: string): string;  // 喂流式增量，返回可安全输出的部分
  flush(): string;              // 流结束，冲刷剩余
}
```

**过滤规则**（参考项目 markdown-filter.ts 头部注释）：
- **保留**：代码围栏 ```、行内代码 `、表格、分割线、加粗 **、英文斜体
- **过滤（剥掉标记保留内容）**：中文斜体标记、H5/H6 标题、图片 `![alt](url)`（**整段删除**）

**② 发送流程**：

```ts
// 流式期间：sendTyping（ilink/bot/sendtyping）每 5s 续一次，模拟"正在输入"
// 完成时（message_end）：
const text = markdownFilter.feed(fullText) + markdownFilter.flush();
await sendMessage({ body: buildTextMessageReq({ to, text, clientId }) });
// 图片：buildImageMessageReq（先 getUploadUrl 预签名 → CDN 上传 → 加密 → 引用）
```

### 4.6 媒体：`src/main/im/weixin/weixin-media.ts`（新建，P1）

照搬参考项目 `cdn/` + `media/`：
- **入站图片**：`cdn/pic-decrypt.ts`（**AES-ECB 解密**）+ `media/media-download.ts` → 转 `ImageContent` 喂给 Pi（复用 `docs/image-input.md` 链路）
- **出站图片**：`getUploadUrl` 预签名 → `cdn/upload.ts` 上传 → 消息引用

---

## 5. IPC / preload / 渲染层（与钉钉共用，渠道参数化）

复用 `docs/im-gateway.md` 第 5~6 章的骨架，差异点：

```ts
// im-config.json 扩展为多渠道：
interface ImConfig {
  enabled: boolean;
  channel: "dingtalk" | "weixin";   // 当前启用渠道
  dingtalk?: { clientId: string; clientSecret: string };
  weixin?: { token?: string; botType?: string; qrcode?: string }; // token 扫码后写入
}
```

渲染层 `ImSettings.tsx` 加**渠道选择**（钉钉/微信 radio）+ 微信扫码展示区（登录二维码图片 + 状态）。

---

## 6. 边界与风险

1. **token 安全**：扫码登录 token = 微信会话凭据，必须加密存储（Electron safeStorage 或本地加密文件），日志脱敏（参考项目 `util/redact.ts`）
2. **长轮询可靠性**：`get_updates_buf` 游标必须正确续传（丢消息重灾区）；断线退避重试（复用钉钉方案的退避函数）
3. **markdown 过滤**：StreamingMarkdownFilter 是字符级状态机，**必须按原样照搬**（它处理了中文斜体/代码围栏等边界），不要重写
4. **bot_type / ilink_appid**：与接入通道强相关，扫码登录时要和 `package.json` 声明一致
5. **语音消息**：silk-wasm 转码（devDependency 含 wasm 产物），首期不做
6. **多账号**：参考项目支持多微信号并发（每次扫码新增账号条目），P2 再做
7. **工具暴露**：同钉钉——微信端等于远程执行（bash 工具），P0 必须带白名单/权限控制

---

## 7. 验收清单

### P0（文本收发 + 扫码）
- [ ] 设置页点「微信登录」→ 显示二维码
- [ ] 手机扫码确认 → 状态变「已连接」
- [ ] 微信发文本 → agent 回复（markdown 已正确过滤，代码块/链接显示正常）
- [ ] 连续两条消息按序回复
- [ ] `/reset` 开启新会话
- [ ] 断网/重启 → 自动重连（get_updates_buf 续传不丢消息）
- [ ] 长轮询超时静默重试（无报错刷屏）
- [ ] token 加密存储，日志无明文

### P1（图片 + 输入中）
- [ ] 发图片 → agent 可见（AES 解密链路通）
- [ ] agent 回复图片 → 微信可看
- [ ] agent 思考期间微信显示「对方正在输入…」（sendtyping）
- [ ] 已登录设备二次启动免扫码（local_token_list）

---

## 8. 文件清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `package.json` | 改 | + qrcode-terminal / zod |
| `src/main/im/weixin/weixin-api.ts` | 新建 | iLink CGI 调用（照搬 api/api.ts） |
| `src/main/im/weixin/weixin-login.ts` | 新建 | 扫码登录（照搬 login-qr.ts） |
| `src/main/im/weixin/weixin-poll.ts` | 新建 | 长轮询循环 |
| `src/main/im/weixin/weixin-handler.ts` | 新建 | 消息路由 → prompt |
| `src/main/im/weixin/weixin-reply.ts` | 新建 | markdown 过滤 + sendtyping + 发送 |
| `src/main/im/weixin/markdown-filter.ts` | 新建 | StreamingMarkdownFilter（照搬 361 行） |
| `src/main/im/weixin/weixin-media.ts` | 新建 | 图片解密/上传（P1） |
| `src/main/im/im-gateway.ts` | 改 | 渠道分发（dingtalk / weixin） |
| `src/main/im/im-config.ts` | 改 | 多渠道配置结构 |
| `src/main/ipc-handlers.ts` | 改 | im 相关 handler 渠道参数化 |
| `src/renderer/sidebar/ImSettings.tsx` | 改 | 渠道选择 + 微信扫码区 |
| `src/shared/i18n/index.ts` | 改 | + weixin.* 词条 |
| `node_modules/@earendil-works/*` | **零改动** | 项目原则 |

---

## 9. 实施顺序建议

1. `weixin-api.ts`（先跑通 getUpdates + sendmessage 收发）→ 2. `weixin-login.ts`（扫码拿 token）→ 3. `weixin-poll.ts` + `weixin-handler.ts`（消息进 Pi）→ 4. `markdown-filter.ts` + `weixin-reply.ts`（回复回微信）→ 5. 设置页 UI（渠道选择 + 扫码区）→ 6.（P1）图片 + sendtyping
