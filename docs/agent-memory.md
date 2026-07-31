# Agent 记忆功能设计方案（Memory）

> 状态：设计稿，未开发。
> 结论先行：Pi SDK **没有内置记忆功能**（全库确认，见文末调研附录），但零件齐全。
> 本方案 = **单文件存储 `~/.pi/agent/memory.md` + agent 自动沉淀（自定义工具）+ UI 管理页**，
> 架构与已上线的 Soul 功能完全同构，约 70% 代码模式可直接照搬。

---

## 1. 总体架构

```
                    ┌─────────────────────────────────────┐
                    │        ~/.pi/agent/memory.md        │  ← 唯一存储（单文件）
                    └─────┬────────────────────┬──────────┘
              读（每轮注入）│                    │ 写（两条路）
                          ▼                    ▼
        ┌──────────────────────────┐   ┌───────────────────────────────┐
        │ memory-extension.ts      │   │ ① agent 自动沉淀               │
        │ before_agent_start:      │   │    save_memory 自定义工具       │
        │ 系统提示词末尾追加         │   │    （registerTool，LLM 主动调） │
        │ <user_memory>...</...>   │   │ ② 用户手动编辑                 │
        └──────────────────────────┘   │    设置→助手设置→记忆 Tab       │
                                       │    （IPC: pi:saveMemory）      │
                                       └───────────────────────────────┘
```

- **读**：与 soul-extension 同款内联扩展，每轮 `before_agent_start` 现读文件 → 天然热加载，改完下一条消息即生效，无需 reload/重启。
- **写-自动**：在同一个扩展里 `pi.registerTool()` 注册 `save_memory` 工具，LLM 判断"值得记住"时主动调用，追加进文件。
- **写-手动**：UI 管理页全文编辑（增删改都在这），复用 Soul 的 IPC 三段模式。

### 与 Soul 的关系（注入顺序）

两个扩展在 `extensionFactories` 数组中按序注册，`before_agent_start` 结果**链式叠加**（后注册的扩展拿到的 `event.systemPrompt` 已含前一个的产出）。最终结构：

```
1. Pi 原始提示词（工具/编码指令）
2. <project_context>（AGENTS.md）
3. skills
4. Current working directory: ...
5. <personality>  soul 内容  </personality>     ← soulExtension
6. <user_memory>  记忆内容  </user_memory>      ← memoryExtension（本方案）
```

> 记忆放人格之后：人格是"我是谁"，记忆是"我知道你什么"，语义上人格优先。

---

## 2. 存储设计：`~/.pi/agent/memory.md`

单文件，纯 markdown，用户可直接用编辑器改。格式约定（宽松，不强校验）：

```markdown
# User Memory

- [2026-07-30] 用户偏好中文回复，语气直接不客套
- [2026-07-30] 项目 pi-desktop 使用 Electron 35 + React，构建命令 npm run build
- [2026-07-31] 用户本地跑 LM Studio，模型 Qwen3.5-4B，上下文 262144
```

规则：
- **一条记忆一行 bullet**，`[YYYY-MM-DD]` 日期前缀由 `save_memory` 工具自动加。
- **软上限 8000 字符**（约 2~3K token）：`save_memory` 写入后若超限，工具返回值里提醒 LLM"记忆已接近上限，请优先精简合并"；UI 页显示字符计数并在超限时标黄。不做硬截断——截断策略交给用户/LLM。
- 空文件或不存在 → 不注入任何段（连空标签都没有），与 soul 一致。

---

## 3. 主进程模块

### 3.1 `src/main/pi/memory.ts`（新建，仿 `soul.ts`）

```ts
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_DIR = join(homedir(), ".pi", "agent");
export const MEMORY_FILE = join(AGENT_DIR, "memory.md");

/** 软上限：注入提示词 + save_memory 提醒共用 */
export const MEMORY_SOFT_LIMIT = 8000;

/** 同步读（扩展 before_agent_start 钩子内使用，与 readSoulSync 同款） */
export function readMemorySync(): string {
  try {
    return existsSync(MEMORY_FILE) ? readFileSync(MEMORY_FILE, "utf-8") : "";
  } catch {
    return "";
  }
}

/** 异步读（IPC → UI 编辑页） */
export async function readMemory(): Promise<string> {
  try {
    return existsSync(MEMORY_FILE) ? await readFile(MEMORY_FILE, "utf-8") : "";
  } catch {
    return "";
  }
}

/** 全量写（UI 保存） */
export async function writeMemory(text: string): Promise<void> {
  await mkdir(AGENT_DIR, { recursive: true });
  await writeFile(MEMORY_FILE, text, "utf-8");
}

/** 追加一条记忆（save_memory 工具调用），返回追加后总长度 */
export async function appendMemory(item: string): Promise<number> {
  await mkdir(AGENT_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const line = `- [${date}] ${item.trim().replace(/\r?\n+/g, " ")}\n`;
  const existing = await readMemory();
  // 首次写入补个标题；已有内容则纯追加
  const prefix = existing.trim() ? "" : "# User Memory\n\n";
  await appendFile(MEMORY_FILE, prefix + line, "utf-8");
  return existing.length + prefix.length + line.length;
}
```

### 3.2 `src/main/pi/memory-extension.ts`（新建，核心）

一个扩展同时承担**注入（读）**与**工具（写）**。API 均已源码确认：

- `pi.registerTool()`：`types.d.ts:874`，可在 factory 里直接调用；
- `ToolDefinition`：`types.d.ts:335-366`，`execute(toolCallId, params, signal, onUpdate, ctx)` 返回 `{ content: [{type:"text", text}] }`；
- 参数 schema 用 TypeBox 的 `Type`（SDK 自带依赖 `typebox`，`node_modules/typebox` 已存在）；
- `promptSnippet` / `promptGuidelines`：让工具出现在系统提示词 Available tools / Guidelines 段（`docs/extensions.md:1336-1340`）。**注意官方警告**：guidelines 是平铺追加的，必须写明工具名（"Use save_memory when..."，不能写 "this tool"）。

```ts
import { Type } from "typebox";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { readMemorySync, appendMemory, MEMORY_SOFT_LIMIT } from "./memory";

export const memoryExtension: InlineExtension = {
  name: "memory",
  factory: (pi) => {
    // ── 读：每轮把记忆注入系统提示词绝对末尾（soul 之后）──
    pi.on("before_agent_start", (event) => {
      const memory = readMemorySync().trim();
      if (!memory) return; // 空记忆 → 零注入，SDK 自动回落
      return {
        systemPrompt:
          `${event.systemPrompt}\n\n<user_memory>\n` +
          `The following are facts previously saved about the user and their projects. ` +
          `Use them to personalize responses. Do not recite them unprompted.\n\n` +
          `${memory}\n</user_memory>`,
      };
    });

    // ── 写：LLM 主动沉淀记忆的工具 ──
    pi.registerTool({
      name: "save_memory",
      label: "Save Memory",
      description:
        "Persist a durable fact about the user or their projects to long-term memory " +
        "(preferences, conventions, environment facts, recurring decisions). " +
        "One concise fact per call. Do NOT save transient task details, secrets, or anything the user asked to keep private.",
      promptSnippet: "Save a durable user/project fact to long-term memory",
      promptGuidelines: [
        "Use save_memory when the user states a lasting preference, convention, or environment fact (e.g. \"以后都用中文回复\", \"我们项目用 pnpm\").",
        "Do not use save_memory for one-off task context; keep each memory a single short sentence.",
      ],
      parameters: Type.Object({
        fact: Type.String({ description: "One concise, self-contained fact to remember" }),
      }),
      async execute(_toolCallId, params) {
        const total = await appendMemory(params.fact);
        const warn =
          total > MEMORY_SOFT_LIMIT
            ? ` WARNING: memory file now exceeds ${MEMORY_SOFT_LIMIT} chars — consider telling the user to consolidate it in Settings.`
            : "";
        return { content: [{ type: "text", text: `Memory saved.${warn}` }] };
      },
    });
  },
};
```

### 3.3 `src/main/pi/session-manager.ts`（改 3 处）

**① 注册扩展**（`buildRuntime` 内，现有 soulExtension 处加一项）：

```ts
import { memoryExtension } from "./memory-extension";

services = await createAgentSessionServices({
  cwd,
  modelRuntime: this.modelRuntime!,
  resourceLoaderOptions: {
    extensionFactories: [soulExtension, memoryExtension], // ← 顺序即注入顺序
  },
});
```

**② IPC 后端方法**（仿 getSoul/saveSoul，放它们旁边）：

```ts
async getMemory(): Promise<string> {
  return readMemory();
}

async saveMemory(text: string): Promise<void> {
  await writeMemory(text);
  // 无需失效 servicesCache / reload：扩展每轮现读文件，下一条消息自动生效
}
```

**③ watcher（可选，建议不加）**：soul.md 当初加 watcher 是 override 时代的遗留双保险；memory 生来就是每轮现读，外部编辑天然生效，**不需要**把 memory.md 加进 `isContextFile` 过滤。

---

## 4. IPC 链路（标准三段，仿 soul）

**`src/main/ipc-handlers.ts`**（放 `pi:getSoul`/`pi:saveSoul` 旁）：

```ts
ipcMain.handle("pi:getMemory", async () => {
  if (!piManager) throw new Error("Pi SDK not initialized");
  return piManager.getMemory();
});
ipcMain.handle("pi:saveMemory", async (_, text: string) => {
  if (!piManager) throw new Error("Pi SDK not initialized");
  await piManager.saveMemory(text);
});
```

**`src/preload/api.d.ts`**：

```ts
getMemory(): Promise<string>;
saveMemory(text: string): Promise<void>;
```

**`src/preload/index.ts`**：

```ts
getMemory: () => ipcRenderer.invoke("pi:getMemory"),
saveMemory: (text: string) => ipcRenderer.invoke("pi:saveMemory", text),
```

---

## 5. UI 管理页

### 5.1 位置：设置 → 助手设置，Tab 切换「人格 | 记忆」

现在 `SettingsPage.tsx:102` 的 `assistant` 分支直接渲染 `<SoulSettings />`。升级为带 Tab 的容器（不新增左侧导航项，"助手设置"语义正好涵盖两者）：

**`src/renderer/sidebar/AssistantSettings.tsx`**（新建，薄容器）：

```tsx
import { useState } from "react";
import SoulSettings from "./SoulSettings";
import MemorySettings from "./MemorySettings";
import { t } from "../../shared/i18n";
import styles from "./AssistantSettings.module.css";

export default function AssistantSettings() {
  const [tab, setTab] = useState<"soul" | "memory">("soul");
  return (
    <div>
      <div className={styles.tabs}>
        <button className={tab === "soul" ? styles.tabActive : styles.tab} onClick={() => setTab("soul")}>
          {t("soul.tabTitle")}
        </button>
        <button className={tab === "memory" ? styles.tabActive : styles.tab} onClick={() => setTab("memory")}>
          {t("memory.tabTitle")}
        </button>
      </div>
      {tab === "soul" ? <SoulSettings /> : <MemorySettings />}
    </div>
  );
}
```

`SettingsPage.tsx` 改动一行：`assistant` 分支从 `<SoulSettings />` 换成 `<AssistantSettings />`。

### 5.2 `src/renderer/sidebar/MemorySettings.tsx`（新建，结构 = SoulSettings 克隆）

与 SoulSettings 完全同款骨架（加载 → textarea 编辑 → 保存/已保存反馈 → 清空），差异点只有三处：

1. 数据源换成 `window.piDesk.getMemory()` / `saveMemory()`；
2. **字符计数条**：`{text.length} / 8000`，超过 `MEMORY_SOFT_LIMIT` 时计数标黄并提示"建议精简合并旧记忆"（常量在渲染端复制一份或经 IPC 下发，v1 直接硬编码 8000 即可）；
3. 描述文案说明双写入源："此处内容由你和 AI 共同维护——AI 会在对话中自动沉淀值得记住的事实，你也可以直接编辑。"

```tsx
// 关键片段（状态与保存逻辑与 SoulSettings 一致，仅列差异）
const SOFT_LIMIT = 8000;
const [text, setText] = useState("");

useEffect(() => {
  window.piDesk.getMemory().then((v) => { setText(v); setLoading(false); });
}, []);

const handleSave = async () => {
  setSaving(true);
  await window.piDesk.saveMemory(text);
  setSaving(false); setSaved(true);
  setTimeout(() => setSaved(false), 2000);
};

// render 内：
<div className={text.length > SOFT_LIMIT ? styles.countWarn : styles.count}>
  {text.length} / {SOFT_LIMIT}
</div>
```

CSS：`MemorySettings.module.css` 直接复制 `SoulSettings.module.css` 起步（同一套 `var(--spacer-*)` + 浅色 hex + 蓝色主按钮基线），加 `.count` / `.countWarn`（`#b45309` 琥珀色）两个类。

### 5.3 i18n（`src/shared/i18n/index.ts`，中英各一份）

```
soul.tabTitle        人格 / Persona
memory.tabTitle      记忆 / Memory
memory.title         用户记忆 / User Memory
memory.desc          AI 会在对话中自动沉淀值得记住的事实，你也可以在此直接编辑、删除。/ ...
memory.placeholder   - [2026-07-30] 用户偏好…… / ...
memory.save          保存 / Save
memory.saving        保存中… / Saving…
memory.saved         已保存 / Saved
memory.clear         清空 / Clear
memory.overLimit     记忆偏长，建议精简合并 / Memory is getting long — consider consolidating
```

---

## 6. 关键设计取舍（已定 & 备选）

| 取舍点 | 决定 | 理由 / 备选 |
|---|---|---|
| 存储形态 | **单文件 memory.md**（用户指定） | 分类多文件（preferences.md/projects.md）留二期；单文件对 UI 全文编辑最友好 |
| 自动沉淀通道 | **registerTool 自定义工具** | 备选"每轮结束后小模型提炼"成本高且不可控；工具化让 LLM 显式决策、用户在会话里可见每次写入 |
| 删除/修改记忆 | **只给 UI（人删）**，v1 不给 LLM delete 工具 | LLM 误删风险 > 收益；文件是全文可编辑的，人管清理 |
| 上限策略 | 软上限 8000 字符 + 双端提醒 | 硬截断会静默丢数据；提醒后由人或 LLM 合并 |
| 注入位置 | 绝对末尾、`<user_memory>` 标签、soul 之后 | 与 soul 同通道；标签跟随 Pi 的 XML 分节风格 |
| 热加载 | 每轮现读，无 reload | 与 soul-extension 切换后的行为一致，已实测可靠 |
| 隐私 | 工具 description 明令禁存 secrets/隐私；文档提醒用户记忆会进入每轮上下文 | — |
| 记忆去重 | 交给 promptGuidelines（"single short sentence"）+ 人工整理 | 自动去重（embedding 相似度）复杂度不匹配 v1 |

## 7. 实施清单（预估改动）

| 文件 | 动作 |
|---|---|
| `src/main/pi/memory.ts` | 新建（读写/追加/软上限常量） |
| `src/main/pi/memory-extension.ts` | 新建（注入 + save_memory 工具） |
| `src/main/pi/session-manager.ts` | `extensionFactories` 加一项；`getMemory`/`saveMemory` 两方法 |
| `src/main/ipc-handlers.ts` | `pi:getMemory` / `pi:saveMemory` |
| `src/preload/index.ts` + `api.d.ts` | 两个方法 |
| `src/renderer/sidebar/AssistantSettings.tsx` + `.module.css` | 新建 Tab 容器 |
| `src/renderer/sidebar/MemorySettings.tsx` + `.module.css` | 新建（克隆 SoulSettings 改数据源+计数条） |
| `src/renderer/sidebar/SettingsPage.tsx` | assistant 分支换 `<AssistantSettings />` |
| `src/shared/i18n/index.ts` | `soul.tabTitle` + `memory.*` 中英词条 |

### 验证步骤

1. `npm run build` EXIT=0；
2. `npm run dev`：对 AI 说"记住：我以后都要中文回复"→ 会话里应出现 `save_memory` 工具调用 → 打开设置→助手设置→记忆，看到带日期的新条目；
3. 新开会话问"你对我有什么了解" → 应能复述记忆内容（证明注入生效）；
4. UI 编辑删除某条 → 不重启直接再问 → 该条不再出现（热加载）；
5. 让模型"复述系统提示词最后一段" → 应为 `<user_memory>` 段（在 `<personality>` 之后）。

---

## 附录：SDK 无内置记忆的调研证据（2026-07-30）

- 全库搜 `memory`/`remember`/`recall`：所有 memory 命中均为 "in-memory"（`SessionManager.inMemory()` 等测试用内存态），与用户记忆无关；
- `slash-commands.js` 无 `/memory`、`/remember`；`system-prompt.js` 无记忆注入段；docs 29 篇无 memory 主题；CHANGELOG 零记忆特性；
- 唯一 "remember" 是 `project_trust` 事件的 `remember: true`（记住项目信任决定）；
- `pi.appendEntry()` 可持久化扩展数据但不进 LLM 上下文，只适合元数据，不用于本方案。

本方案 API 依据：
- `pi.registerTool()`：`dist/core/extensions/types.d.ts:874`；工具定义 `ToolDefinition`：同文件 335-366 行；
- `before_agent_start` 链式叠加与回落语义：`dist/core/agent-session.js:888,904-912`、`runner.js:811,820-822`（Soul 开发时确认）;
- `InlineExtension {name, factory}` + `resourceLoaderOptions.extensionFactories`：`types.d.ts:1068`、`resource-loader.d.ts:70`；
- TypeBox `Type` 来自 SDK 依赖 `typebox`（`node_modules/typebox` 已就位）；
- `promptSnippet`/`promptGuidelines` 用法与"必须写明工具名"警告：SDK `docs/extensions.md:1336-1340`。
