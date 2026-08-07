# Soul 情绪修饰层（自动微调）开发文档

> 方案编号：④ Extension `before_agent_start` 事件
> 前置依赖：方案 ③ 多人格（`docs/soul-multi-persona.md`）——④ 是 ③ 之上的**修饰层**，不替代 ③
> 状态：设计完成，未开发

---

## 1. 目标与定位

让 agent 具备"陪伴感"：**每轮对话前**自动感知用户情绪/场景，在人格底座之上叠加当轮的语气修饰，用户零操作、无感知。

**架构分层（关键设计决策）**：

```
系统提示词 = Pi 基础提示词（工具/编码指令）
           + 人格底座（③ appendSystemPromptOverride，reload 时才变）
           + 情绪修饰层（④ before_agent_start，每轮现算）   ← 本文档
```

- ③ 负责"我是谁"（稳定人格，用户手动切换）；
- ④ 负责"此刻怎么说话"（动态语气，逐轮自动）；
- ④ **只追加一小段修饰指令，绝不整段替换系统提示词**——替换会丢掉 Pi 工具脚手架和 ③ 注入的人格。

---

## 2. SDK 机制（源码级依据）

### 2.1 事件定义

`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`：

```ts
// types.d.ts:513-524 —— 事件入参
/** Fired after user submits prompt but before agent loop. */
export interface BeforeAgentStartEvent {
    type: "before_agent_start";
    prompt: string;                              // 展开后的用户输入（模板已展开）
    images?: ImageContent[];
    systemPrompt: string;                        // 完整拼装好的系统提示词（含 ③ 的人格）
    systemPromptOptions: BuildSystemPromptOptions;
}

// types.d.ts:787-791 —— 返回值
export interface BeforeAgentStartEventResult {
    message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
    /** Replace the system prompt for this turn. If multiple extensions return this, they are chained. */
    systemPrompt?: string;
}

// types.d.ts:855 —— 注册签名
on(event: "before_agent_start",
   handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
```

### 2.2 每轮自动回落（重要保证）

`dist/core/agent-session.js:903-912`：

```js
// Apply extension-modified system prompt, or reset to base
if (result?.systemPrompt !== undefined) {
    this._systemPromptOverride = result.systemPrompt;
    this.agent.state.systemPrompt = result.systemPrompt;
} else {
    // Ensure we're using the base prompt (in case previous turn had modifications)
    this._systemPromptOverride = undefined;
    this.agent.state.systemPrompt = this._baseSystemPrompt;
}
```

**含义**：扩展当轮不返回 `systemPrompt` → SDK 自动恢复 base。"无情绪信号时零干预"天然成立，不需要我们手工清理上一轮的修饰。

### 2.3 多扩展链式（runner.js:792-817）

`emitBeforeAgentStart` 按扩展注册顺序遍历，后一个扩展在 `event.systemPrompt` 里看到的是前一个改过的结果（`currentSystemPrompt` 逐个传递）。我们只有一个情绪扩展，但写 handler 时**必须基于 `event.systemPrompt` 追加**而非凭空构造，这样与用户自装的其他扩展兼容。

### 2.4 接入通道：内联扩展（不写文件！）

`dist/core/resource-loader.d.ts:70`：

```ts
extensionFactories?: InlineExtension[];
```

`dist/core/extensions/types.d.ts:1066-1072`：

```ts
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
export type InlineExtension = ExtensionFactory | {
    name: string;          // 启动扩展列表显示为 <inline:name>
    factory: ExtensionFactory;
};
```

**选内联而非文件扩展的理由**：
1. 不往 `~/.pi/agent/extensions/` 写 TS 文件 → 避开 jiti 同步编译（正是曾导致主进程卡死数秒的重活，见 MEMORY.md）；
2. 扩展代码在主进程内，可直接 `import` 我们的模块（读 souls.json、情绪状态），文件扩展做不到；
3. 随应用版本走，不会被用户误删/改坏。

传入位置就是现有 `createAgentSessionServices` 调用处（`resourceLoaderOptions` 同级字段），`session-manager.ts:587-596`。

---

## 3. 情绪信号设计

### 3.1 信号来源（第一版只做零成本的三种）

| 信号 | 来源 | 成本 | 第一版 |
|---|---|---|---|
| 显式关键词 | 当轮 `event.prompt` 正则/词表匹配（"我好累"、"烦死了"、"太开心了"） | 零 | ✅ |
| 时间段 | `new Date().getHours()`（深夜 23-6 点 → 温柔安静） | 零 | ✅ |
| 对话节奏 | 最近 N 条用户消息平均长度骤降 → 收敛话痨程度 | 零 | ✅ |
| LLM 情绪打分 | 上一轮让主模型顺带输出情绪标签（见 §7 展望） | 每轮 0 额外请求 | ❌ 二期 |
| 独立小模型打分 | 每轮先调一次 4B 模型情绪分类 | 每轮 +1 次推理延迟 | ❌ 不做（本地 LM Studio 场景延迟不可接受） |

### 3.2 情绪 → 修饰指令映射

内置映射表（用户可在设置页开关整个功能，映射表第一版硬编码）：

```
low   （低落/疲惫） → "用户当前情绪低落或疲惫。放慢节奏，语气温和，多倾听共情，少给密集建议，避免催促。"
stress（烦躁/急）   → "用户当前有些烦躁。回答直接给结论，砍掉铺垫和废话，一次只说最关键的事。"
happy （开心）      → "用户当前心情不错。语气可以轻快一些，适当呼应用户的好情绪。"
night （深夜）      → "现在是深夜。语气放轻放缓，回答尽量简短，不推动用户开新任务。"
null  （无信号）    → 不注入（SDK 自动回落 base，见 §2.2）
```

优先级：显式关键词 > 节奏 > 时间段（取最高优先级单个，不叠加，避免修饰指令互相打架）。

---

## 4. 模块设计与代码

### 4.1 文件布局（模块化）

```
src/main/pi/
├── emotion/
│   ├── detector.ts        ← 纯函数：信号 → EmotionKind（可单测）
│   ├── modifiers.ts       ← EmotionKind → 修饰指令文本（i18n 无关，跟随人格语言）
│   └── extension.ts       ← InlineExtension 工厂：注册 before_agent_start
├── soul.ts                ← ③ 已有，不动
└── session-manager.ts     ← 接线：extensionFactories + 开关配置
```

### 4.2 `src/main/pi/emotion/detector.ts`

```ts
/** 情绪种类。null = 无信号，本轮不注入修饰。 */
export type EmotionKind = "low" | "stress" | "happy" | "night" | null;

const LOW_WORDS = /好累|太累|疲惫|难过|伤心|沮丧|emo|唉|想哭|没劲|提不起/;
const STRESS_WORDS = /烦死|急死|赶紧|快点|别废话|烦躁|气死|无语|崩溃/;
const HAPPY_WORDS = /哈哈|太棒|开心|真好|爽|nice|完美|太好了|666/;

export interface DetectInput {
  prompt: string;
  /** 最近的用户消息文本（旧→新），用于节奏检测。可为空数组。 */
  recentUserMessages: string[];
  now?: Date; // 注入以便单测
}

export function detectEmotion(input: DetectInput): EmotionKind {
  const { prompt, recentUserMessages, now = new Date() } = input;

  // 1. 显式关键词（最高优先级）
  if (STRESS_WORDS.test(prompt)) return "stress";
  if (LOW_WORDS.test(prompt)) return "low";
  if (HAPPY_WORDS.test(prompt)) return "happy";

  // 2. 节奏：最近 3 条都很短（<10 字）且此前平均较长 → 用户在变冷/变累
  const recent = recentUserMessages.slice(-3);
  const earlier = recentUserMessages.slice(0, -3);
  if (recent.length === 3 && earlier.length >= 2) {
    const avgRecent = recent.reduce((s, m) => s + m.length, 0) / recent.length;
    const avgEarlier = earlier.reduce((s, m) => s + m.length, 0) / earlier.length;
    if (avgRecent < 10 && avgEarlier > 30) return "low";
  }

  // 3. 时间段（最低优先级）
  const h = now.getHours();
  if (h >= 23 || h < 6) return "night";

  return null;
}
```

### 4.3 `src/main/pi/emotion/modifiers.ts`

```ts
import type { EmotionKind } from "./detector";

const MODIFIERS: Record<Exclude<EmotionKind, null>, string> = {
  low: "用户当前情绪低落或疲惫。放慢节奏，语气温和，多倾听共情，少给密集建议，避免催促。",
  stress: "用户当前有些烦躁。回答直接给结论，砍掉铺垫和废话，一次只说最关键的事。",
  happy: "用户当前心情不错。语气可以轻快一些，适当呼应用户的好情绪。",
  night: "现在是深夜。语气放轻放缓，回答尽量简短，不推动用户开新任务。",
};

/** 包一层标签，便于在日志/调试里辨认这段是情绪层注入的。 */
export function buildModifierSection(kind: Exclude<EmotionKind, null>): string {
  return `\n\n<mood_adaptation>\n${MODIFIERS[kind]}\n</mood_adaptation>`;
}
```

### 4.4 `src/main/pi/emotion/extension.ts`（核心）

```ts
import { detectEmotion, type EmotionKind } from "./detector";
import { buildModifierSection } from "./modifiers";

/**
 * 情绪修饰层的运行时状态。session-manager 持有并喂数据：
 * - enabled：设置页开关（关 = handler 永远返回 undefined，SDK 回落 base）
 * - recentUserMessages：session-manager 在收到用户消息事件时 push（环形，最多 8 条）
 */
export class EmotionState {
  enabled = false;
  recentUserMessages: string[] = [];

  pushUserMessage(text: string): void {
    this.recentUserMessages.push(text);
    if (this.recentUserMessages.length > 8) this.recentUserMessages.shift();
  }
}

/**
 * 创建内联扩展工厂。传给 createAgentSessionServices 的
 * resourceLoaderOptions.extensionFactories（SDK resource-loader.d.ts:70）。
 *
 * 关键约束：
 * 1. 只追加，不替换 —— 基于 event.systemPrompt（此刻已含 Pi 基础提示词 + ③ 人格）
 *    拼接修饰段，保证与其他扩展链式兼容（runner.js:792 起逐扩展传递）。
 * 2. 无信号/开关关闭时返回 undefined —— SDK 自动回落 base
 *    （agent-session.js:904-912），上一轮的修饰不会残留。
 */
export function createEmotionExtension(state: EmotionState) {
  return {
    name: "soul-emotion-layer",
    factory: (pi: any) => {
      pi.on("before_agent_start", (event: any) => {
        if (!state.enabled) return undefined;
        const kind: EmotionKind = detectEmotion({
          prompt: event.prompt,
          recentUserMessages: state.recentUserMessages,
        });
        if (!kind) return undefined;
        console.log(`[emotion-layer] mood=${kind} — appending modifier for this turn`);
        return { systemPrompt: event.systemPrompt + buildModifierSection(kind) };
      });
    },
  };
}
```

> 类型说明：`ExtensionAPI` / `BeforeAgentStartEvent` 可从
> `@earendil-works/pi-coding-agent` 顶层导入获得完整类型（`dist/core/sdk.d.ts:65`
> re-export 了 `ExtensionAPI`、`InlineExtension` 等）；若导出路径受限，用
> `any` + 注释标注 SDK 行号亦可接受（与项目现状一致）。

### 4.5 `session-manager.ts` 接线（3 处）

**(a) 成员与构造**：

```ts
import { EmotionState, createEmotionExtension } from "./emotion/extension";

// class 成员：
private emotionState = new EmotionState();
```

**(b) `buildRuntime` 内 `createAgentSessionServices`（现 587-596 行）追加一个字段**：

```ts
services = await createAgentSessionServices({
  cwd,
  modelRuntime: this.modelRuntime!,
  resourceLoaderOptions: {
    appendSystemPromptOverride: (base: string[]) => {   // ③ 人格底座，不动
      const soul = readActiveSoulSync();
      return soul ? [...base, soul] : base;
    },
    extensionFactories: [createEmotionExtension(this.emotionState)],  // ④ 新增
  },
});
```

注意：`emotionState` 是 session-manager 实例成员，services 重建（servicesCache 失效）后新扩展实例拿到的仍是同一个 state 对象——**开关与节奏历史跨 reload 存活**。

**(c) 喂用户消息（节奏信号）**：在现有发送用户消息的入口（`sendMessage`/`prompt` 转发处）加一行：

```ts
this.emotionState.pushUserMessage(text);
```

### 4.6 开关配置

- 存 `~/.pi/agent/settings.json` 之外的自有配置（项目已有 compaction config 的读写模式可照抄，见 `saveCompactionConfig`，session-manager.ts:885-902）或简单存 `souls.json` 加一个 `emotionLayer: boolean` 字段（推荐——情绪层语义上属于 soul 体系）。
- 启动时读入 `emotionState.enabled`；IPC：`pi:getEmotionLayer` / `pi:setEmotionLayer`（模式照抄 §soul 的 handler）。
- **开关切换不需要 servicesCache 失效**：handler 每轮读 `state.enabled`，改内存标志即时生效。这是 ④ 相对 ③ 的天然优势——逐轮生效，无 reload。

### 4.7 UI（设置页）

在 ③ 的 `SoulSettings.tsx` 人格列表下方加一个开关区块（不新建导航项）：

```tsx
<section className={styles.section}>
  <h2 className={styles.sectionTitle}>{t("soul.emotionTitle")}</h2>
  <p className={styles.sectionDesc}>{t("soul.emotionDesc")}</p>
  <label className={styles.switchRow}>
    <input
      type="checkbox"
      checked={emotionEnabled}
      onChange={async (e) => {
        setEmotionEnabled(e.target.checked);
        await window.piDesk.setEmotionLayer(e.target.checked);
      }}
    />
    <span>{t("soul.emotionToggle")}</span>
  </label>
</section>
```

i18n 词条：

```ts
"soul.emotionTitle": "情绪自适应",
"soul.emotionDesc": "根据你的消息语气、对话节奏和时间段，自动微调助手的说话方式。仅影响语气，不改变人格与能力。",
"soul.emotionToggle": "启用情绪自适应",
```

---

## 5. 为什么不这样做（反方案记录）

| 反方案 | 否决理由 |
|---|---|
| 文件扩展（`~/.pi/agent/extensions/emotion.ts`） | jiti 同步编译阻塞主进程（历史卡死教训）；无法 import 主进程模块共享状态；用户可误删 |
| `before_agent_start` 整段替换 systemPrompt | 丢 Pi 工具脚手架 + ③ 人格；与其他扩展链不兼容 |
| 修饰做进 ③ 的 `appendSystemPromptOverride` | 该钩子只在 reload 时跑，做不到逐轮；为每轮情绪触发 reload 代价离谱（services 重建是同步重活） |
| 每轮先调小模型打情绪分 | 本地 LM Studio 单模型场景 = 每轮双倍推理延迟，体验不可接受 |
| 多情绪修饰叠加 | 指令互相冲突（"轻快"+"放缓"），单选最高优先级 |

---

## 6. 测试清单

1. 单测 `detectEmotion`（纯函数，注入 `now`）：关键词三类命中、节奏骤降、深夜、无信号。
2. 开关关闭 → 任何输入都不注入（日志无 `[emotion-layer]`）。
3. 输入"烦死了快点" → 该轮系统提示词尾部出现 `<mood_adaptation>`（stress 文案）；**下一轮**输入普通内容 → 修饰消失（验证 SDK 自动回落）。
4. ③+④ 同时生效：激活某人格 + 触发情绪 → 系统提示词同时含人格段与 `<mood_adaptation>` 段，且人格在前、情绪在后。
5. 切换人格（③ 触发 services 重建）后情绪层仍工作，且 `recentUserMessages` 历史未丢（EmotionState 挂 session-manager 成员）。
6. 深夜 23:30 发消息 → night 修饰；白天同内容 → 无修饰。
7. `npm run build` EXIT=0。

调试技巧：`before_agent_start` 的 `event.systemPrompt` 就是完整拼装结果，handler 里 `console.log(event.systemPrompt.slice(-500))` 可直接目检 ③/④ 两段注入。

---

## 7. 二期展望：LLM 情绪打分（零额外请求方案）

让主模型**上一轮回答时顺带**输出情绪标签，本轮直接用（避免独立打分请求）：

- ③/④ 的修饰指令中追加一句：`在回答末尾用 <mood>标签</mood> 标注你判断的用户当前情绪（low/stress/happy/neutral），该标签会被界面隐藏。`
- session-manager 在 `message_end`（渲染前）解析并剥离 `<mood>` 标签 → 写入 `emotionState`；
- `detectEmotion` 优先级表加一级：LLM 标签 > 显式关键词 > 节奏 > 时间段。
- 风险：低配模型（Qwen3-4B）标签遵循率可能不稳，需容错（解析失败静默回落规则检测）。

---

## 8. 改动文件汇总

| 文件 | 类型 | 内容 |
|---|---|---|
| `src/main/pi/emotion/detector.ts` | 新建 | 情绪检测纯函数 |
| `src/main/pi/emotion/modifiers.ts` | 新建 | 情绪 → 修饰指令映射 |
| `src/main/pi/emotion/extension.ts` | 新建 | `EmotionState` + 内联扩展工厂 |
| `src/main/pi/session-manager.ts` | 修改 | `extensionFactories` 接线 + `emotionState` 成员 + 用户消息喂入 + 开关持久化 |
| `src/main/ipc-handlers.ts` | 修改 | `pi:getEmotionLayer` / `pi:setEmotionLayer` |
| `src/preload/index.ts` / `api.d.ts` | 修改 | 对应两方法 |
| `src/renderer/sidebar/SoulSettings.tsx` | 修改 | 情绪自适应开关区块 |
| `src/shared/i18n/index.ts` | 修改 | `soul.emotion*` 词条（中英） |
