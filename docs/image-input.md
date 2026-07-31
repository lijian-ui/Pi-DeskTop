# 对话中图片输入（粘贴 / 上传）开发文档

> 状态：**未开发**（方案已调研，待拍板）
> 目标：用户在对话输入框**粘贴 / 选择图片**，随消息发送给 LLM，并在对话界面渲染图片附件。
> 结论先行：**Pi SDK 原生支持图片输入**（`prompt(text, { images })`），主进程/preload 已透传 `images` 参数，**全部工作集中在渲染层**；SDK **不支持视频**（需自行抽帧转图片）。

---

## 1. 背景与调研结论

### 1.1 SDK 能力（已确认，源码级）

- `AgentSession.prompt(text, options?: PromptOptions)`，`PromptOptions.images?: ImageContent[]`（`agent-session.d.ts:153-165`）
- `steer(text, images?)` / `followUp(text, images?)` 同样支持
- `ImageContent = { type: "image"; data: string; mimeType: string }`（`pi-ai/dist/types.d.ts:248`），`data` 为 **base64** 图像字节
- OpenAI 兼容 API 拼成 `image_url: { url: "data:{mimeType};base64,{data}" }`（`pi-ai/dist/api/openai-completions.js:825`）；Anthropic 走 image block —— 主流 provider 均适配
- SDK 自带图片处理管线（`dist/utils/`）：`image-process.js`（mime 检测 → 自动 resize 2000×2000 → PNG 转换 → base64）、`clipboard-image.js`（剪贴板）、`image-resize-worker.js`（后台线程）
- ⚠️ 多模态生效前提：**模型本身支持图片**（如 Qwen-VL、GPT-4o、Claude 等）；纯文本模型会忽略或报错

### 1.2 桌面壳现状（逐层盘点）

| 层 | 现状 | 需要改动 |
|---|---|---|
| 主进程 `ipc-handlers.ts` `pi:prompt` | 已接收 `images` 并传给 `piManager.prompt(text, images, ...)` | ✅ 零改动 |
| 主进程 `session-manager.ts` `prompt()` | 已 `session.prompt(text, { images })` 透传给 SDK | ✅ 零改动 |
| `preload/index.ts` `prompt` | 已带 `images?: any[]` 参数 | ✅ 零改动 |
| `preload/api.d.ts` | 已声明 `prompt(text, images?)` | ✅ 零改动 |
| 渲染层 `ChatComposer.handleSend` | 调 `prompt(fullBody, undefined, ...)` —— images 恒为 `undefined` | ⚠️ 核心改动 |
| 渲染层消息渲染 `UserMessage` | 只渲染文本 + 代码附件，无图片 | ⚠️ 核心改动 |

---

## 2. 总体数据流

```
用户粘贴 / 选择图片
  → ChatComposer 捕获（paste 事件 / 文件选择器）
  → 读 File → arrayBuffer → base64（渲染层完成；可先压缩，SDK 也会再处理）
  → 存 ui-store.imageAttachments（待发送，显示缩略图胶囊）
  → 点发送：
      handleSend 构造 ImageContent[] = [{ type:"image", data: base64, mimeType }]
      window.piDesk.prompt(fullBody, imageContents, currentCwd, currentPath)
      （IPC 已有 images 参数 → session-manager → SDK prompt({images})）
  → 乐观插入用户消息（带 images 附件，立即渲染缩略图）
  → SDK message_start 事件（含图片的用户消息）→ 后续重放时也带图片
  → UserMessage 渲染图片卡片（<img src="data:...;base64,...">）
```

---

## 3. 渲染层改动明细（核心）

### 3.1 扩展附件类型：`src/renderer/store/ui-store.ts`

在 `CodeAttachment` 旁新增图片附件类型（可放同文件或 `agent-store.ts`）：

```ts
/** 待发送/已发送的图片附件（对话输入用）。 */
export interface ImageAttachment {
  id: string;
  /** 本地预览用：`data:${mimeType};base64,${data}` 直接给 <img> */
  mimeType: string;
  /** base64 图像字节（不含 data: 前缀，与 SDK ImageContent.data 一致） */
  data: string;
  /** 原文件名（选择文件时）或 "剪贴板图片" */
  name?: string;
  /** 文件大小（用于限制提示） */
  size?: number;
}
```

ui-store 新增状态（与 `codeAttachments` 并列）：

```ts
imageAttachments: ImageAttachment[];
addImageAttachment: (img: ImageAttachment) => void;
removeImageAttachment: (id: string) => void;
clearImageAttachments: () => void;
```

### 3.2 捕获粘贴图片：`src/renderer/chat/ChatComposer.tsx`

在 `handleKeyDown` 之外加 paste 监听（组合键里 `Ctrl/Cmd+V` 时处理剪贴板图片）：

```tsx
// 组件内（或在 textarea 的 onPaste）
const handlePaste = async (e: React.ClipboardEvent) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      e.preventDefault(); // 阻止把图片二进制粘进 textarea
      const file = item.getAsFile();
      if (!file) continue;
      const data = await fileToBase64(file); // 见下方工具函数
      useUIStore.getState().addImageAttachment({
        id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        mimeType: file.type,
        data,
        name: file.name || "剪贴板图片",
        size: file.size,
      });
    }
  }
};
```

工具函数（可放 `src/renderer/utils/image.ts` 新建，或 ChatComposer 内联）：

```ts
export async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  // 分片转 base64，避免大图一次 toString 爆内存
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
```

> 可选：压缩大图（>1MB）用 canvas 缩放后再转 base64；SDK 侧 `image-process.js` 也会 resize 到 2000×2000 max，应用层压缩非必需。

### 3.3 上传按钮（可选）：`ChatComposer.tsx` metaRow 区

在现有附件区（代码引用 pills）旁加「图片」按钮：

```tsx
<input
  type="file"
  accept="image/*"
  multiple
  hidden
  ref={imageInputRef}
  onChange={async (e) => {
    const files = Array.from(e.target.files ?? []);
    for (const f of files) {
      const data = await fileToBase64(f);
      useUIStore.getState().addImageAttachment({ id: `img-${Date.now()}`, mimeType: f.type, data, name: f.name, size: f.size });
    }
    e.target.value = ""; // 允许重复选同一文件
  }}
/>
<button onClick={() => imageInputRef.current?.click()}>图片</button>
```

### 3.4 图片附件胶囊（预览 + 移除）：ChatComposer 渲染

复用代码附件 pill 的布局风格（`ChatComposer.module.css` 内新增样式）：

```tsx
{useUIStore((s) => s.imageAttachments).map((img) => (
  <div key={img.id} className={styles.imagePill}>
    <img src={`data:${img.mimeType};base64,${img.data}`} alt={img.name ?? "图片"} />
    <button onClick={() => useUIStore.getState().removeImageAttachment(img.id)} title="移除">×</button>
  </div>
))}
```

### 3.5 发送：`ChatComposer.handleSend`（核心改动点）

当前（`ChatComposer.tsx:608`）：

```tsx
window.piDesk.prompt(fullBody, undefined, currentCwd, currentPath ?? undefined)
```

改为（发送前快照图片、清空待发送列表，与 codeAttachments 同款语义）：

```tsx
const imageAttachments = useUIStore.getState().imageAttachments;
const images: { type: "image"; data: string; mimeType: string }[] = imageAttachments.map(
  (a) => ({ type: "image", data: a.data, mimeType: a.mimeType }),
);
useUIStore.getState().clearImageAttachments(); // 重置 composer
// ...（原有 fullBody / refsText 逻辑不变）...
window.piDesk.prompt(fullBody, images, currentCwd, currentPath ?? undefined);
```

⚠️ 队列路径（流式中发送 `enqueueMessage`）：`drainQueue`（`src/renderer/hooks/useAgentSession.ts`）的 `prompt(next.content, undefined, ...)` 目前丢图片——若要做流式队列传图，`QueuedMessage` 需加 `images` 字段并透传（见 4.1）。

### 3.6 消息渲染：`src/renderer/chat/UserMessage.tsx`

`Message` 类型加 `images?: ImageAttachment[]`（`src/renderer/store/agent-store.ts`），UserMessage 在文本前渲染图片卡片：

```tsx
{message.images?.map((img) => (
  <img
    key={img.id}
    className={styles.messageImage}
    src={`data:${img.mimeType};base64,${img.data}`}
    alt={img.name ?? "图片"}
  />
))}
```

样式（`UserMessage.module.css` 新增）：

```css
.messageImage {
  max-width: 320px;
  max-height: 240px;
  border-radius: var(--radius-8);
  border: 1px solid var(--border-neutral-l2);
  object-fit: contain;
  display: block;
  margin: var(--spacer-6) 0;
}
```

### 3.7 事件流补充：乐观消息携带图片

`handleSend` 乐观插入用户消息时（当前逻辑在 `ChatComposer.tsx` 的 `mutateBuffer` 或 `addMessage` 处）带上 `images`：

```ts
sess.mutateBuffer(bufPath, (msgs) => [
  ...msgs,
  {
    id: `user-${Date.now()}`,
    role: "user",
    content: body,
    attachments,
    images: imageAttachments,   // ← 新增
    timestamp: Date.now(),
  },
]);
```

这样发送瞬间缩略图就出现，无需等 SDK 事件回放。

---

## 4. 可选/配套改动

### 4.1 流式队列传图（`src/renderer/store/agent-store.ts` + `useAgentSession.ts`）

- `QueuedMessage` 加 `images?: ImageContent[]`
- `enqueueMessage` 调用处（ChatComposer 流式中发送）透传 images
- `drainQueue` 的 `prompt(next.content, next.images, ...)` 带上

### 4.2 拖拽上传（可选）

`ChatComposer` 容器加 `onDrop`（`dataTransfer.files` 过滤 `image/*`），复用 `fileToBase64`。

### 4.3 多图 / 大图限制

- 建议限制单次 ≤ 4 张、单张 ≤ 10MB（base64 后内存翻倍）
- 超限 toast 提示（复用现有错误提示机制 `setError`）

### 4.4 视频（暂不做）

SDK 无视频 content 类型。若要做：主进程用 ffmpeg 抽帧 → 多张 ImageContent；工作量大，非本期。

---

## 5. 主进程 / preload 改动（确认：零改动）

| 文件 | 结论 |
|---|---|
| `src/main/ipc-handlers.ts` | `pi:prompt` 已透传 images，不改 |
| `src/main/pi/session-manager.ts` | `prompt()` 已 `session.prompt(text, { images })`，不改 |
| `src/preload/index.ts` / `api.d.ts` | 已带 images 参数，不改 |

---

## 6. 边界与风险

| 风险 | 说明 | 对策 |
|---|---|---|
| 模型不支持图片 | 纯文本模型会忽略 image content 或报错 | 发送前提示「当前模型可能不支持图片」；文档标注 |
| base64 内存 | 大图 base64 膨胀 ~33% + 多图叠加 | 单张 ≤10MB、数量 ≤4、可选 canvas 压缩 |
| 粘贴事件误触发 | 用户 Ctrl+V 文本时被 `preventDefault` 吞掉 | 仅当 items 含 image/* 才 preventDefault |
| 乐观消息与 SDK 回放重复 | SDK message_start 会带图片（user 消息） | 沿用现有 dedup（最后一条 user 则跳过），乐观消息已含 images 不冲突 |
| 队列丢图 | 流式中发送图片走 enqueueMessage 会丢 | 按 4.1 透传（若本期不做，UI 上流式中隐藏图片按钮） |

---

## 7. 验收清单

- [ ] 对话框 Ctrl+V 粘贴截图 → 出现图片缩略图胶囊，可移除
- [ ] 「图片」按钮选文件 → 同上
- [ ] 发送后：用户消息带图片卡片立即渲染（乐观）；SDK 事件回放不重复
- [ ] 多模态模型（如 Qwen-VL / GPT-4o）能"看到"图片内容并回答
- [ ] 流式队列场景（如有）图片不丢
- [ ] 纯文本模型（如 Qwen3-4B 基础版）发送图片不崩溃（忽略或提示）

---

## 8. 涉及文件清单（汇总）

| 文件 | 动作 |
|---|---|
| `src/renderer/store/ui-store.ts` | 改：`ImageAttachment` 类型 + `imageAttachments` 状态 |
| `src/renderer/store/agent-store.ts` | 改：`Message.images?`、`QueuedMessage.images?` |
| `src/renderer/utils/image.ts` | 新建：`fileToBase64`（及可选 canvas 压缩） |
| `src/renderer/chat/ChatComposer.tsx` | 改：paste 捕获、上传按钮、图片胶囊、handleSend 传 images、乐观消息带 images |
| `src/renderer/chat/ChatComposer.module.css` | 改：`.imagePill` 等样式 |
| `src/renderer/chat/UserMessage.tsx` | 改：渲染 `message.images` |
| `src/renderer/chat/UserMessage.module.css` | 改：`.messageImage` |
| `src/renderer/hooks/useAgentSession.ts` | 改（可选 4.1）：`drainQueue` 透传 images |
| 主进程 / preload / api.d.ts | **零改动** |
