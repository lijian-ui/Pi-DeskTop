# Prompt Templates（快捷指令）对接方案

> 状态：设计文档，未开发。何时开发由产品决定。
> 调研日期：2026-07-30，基于 `@earendil-works/pi-coding-agent` 当前版本源码（`dist/core/prompt-templates.*`、`dist/core/agent-session.*`）。

---

## 0. 一句话结论

**SDK 已经在主进程侧把最难的部分做完了**：`session.prompt(text)` 内部会自动匹配 `/名字` 并展开模板（含 `$1`/`$@`/`${N:-default}` 参数替换），展开结果作为 user message 发送，与系统提示词无关。

因此 pi-desktop 对接这个功能，**不需要写任何展开逻辑**，只需要做三件 UI 层的事：

| 阶段 | 内容 | 工作量 |
|---|---|---|
| P0 | `/` 补全菜单里列出模板（IPC 拿列表 + ChatComposer 渲染分组） | 小 |
| P1 | 模板文件变更热更新（复用 AGENTS.md watcher 模式） | 小 |
| P2 | 设置页里的模板管理 UI（增删改 `.md` 文件） | 中 |

UI 文案统一叫 **「快捷指令」**，不要叫"提示词模板"（中文语境里"提示词"默认指系统提示词，会误导用户以为能改 Agent 行为——它只是发送前的文本展开）。

---

## 1. SDK 事实（源码级，写代码前必读）

### 1.1 模板类型

`node_modules/@earendil-works/pi-coding-agent/dist/core/prompt-templates.d.ts`：

```ts
export interface PromptTemplate {
  name: string;          // 命令名（= 文件名去掉 .md），输入 /name 触发
  description: string;   // frontmatter 的 description
  argumentHint?: string; // frontmatter 的 argument-hint，补全菜单里显示参数提示
  content: string;       // 模板正文（含 $1/$@ 占位符）
  sourceInfo: SourceInfo;
  filePath: string;      // 磁盘绝对路径（管理 UI 用得上）
}
```

### 1.2 获取模板列表的官方 API

`AgentSession` 上有现成的 getter（`dist/core/agent-session.d.ts:327`）：

```ts
/** File-based prompt templates */
get promptTemplates(): ReadonlyArray<PromptTemplate>;
```

**这是 P0 唯一需要的 SDK API。** 不要自己调 `loadPromptTemplates()` 重复扫盘——session 里这份就是 `resourceLoader.reload()` 时加载的快照，和实际展开用的是同一份数据，保证补全列表与真实行为一致。

### 1.3 展开发生在哪（我们不用做）

`dist/core/agent-session.js` 的 `prompt()` 链路：

```
"/review src/foo.ts"
  → _expandSkillCommand()                 // 先判断是不是 skill
  → expandPromptTemplate(text, templates)  // 名字匹配 → substituteArgs 参数替换
  → messages.push({ role: "user", content: [{ type: "text", text: 展开后全文 }] })
```

- 匹配不到模板名 → **原样发送**（用户敲错命令 LLM 会收到字面 `/reviw xxx`）
- `steer()` / `followUp()`（流式中排队）也各自会展开，我们的排队发送路径天然覆盖
- 可用 `prompt(text, { expandPromptTemplates: false })` 关闭（我们不需要）

### 1.4 模板文件的加载位置

- 全局：`~/.pi/agent/prompts/*.md`
- 项目：`{cwd}/.pi/prompts/*.md`
- 不递归扫子目录；同目录内文件名即命令名
- 加载时机 = `resourceLoader.reload()` = `createAgentSessionServices()` → **受我们 `servicesCache` 按 cwd 缓存的影响，改文件后默认不生效**（和 AGENTS.md 同款问题，见 P1）

文件格式：

```markdown
---
description: 审查暂存区的代码改动
argument-hint: "<文件路径>"
---
审查 $1 的代码改动，重点检查：
- 空指针与边界条件
- 并发安全
- 错误处理是否吞异常
```

---

## 2. P0：`/` 补全菜单接入模板列表

### 2.1 主进程：`src/main/pi/session-manager.ts`

在 `PiSessionManager` 类里加一个轻量方法（紧挨 `getContextUsage()` 之类的查询方法放）：

```ts
/** File-based prompt templates loaded by the SDK for the current session. */
getPromptTemplates(): Array<{
  name: string;
  description: string;
  argumentHint?: string;
  filePath: string;
}> {
  if (!this.session) return [];
  // 只挑 UI 需要的字段过 IPC，content 可能很大，补全菜单用不到。
  return this.session.promptTemplates.map((t) => ({
    name: t.name,
    description: t.description,
    argumentHint: t.argumentHint,
    filePath: t.filePath,
  }));
}
```

> 注意：不要把 `content` 发到渲染层——补全菜单不需要正文；P2 管理 UI 需要时再单独提供按需读取的 IPC。

### 2.2 IPC：`src/main/ipc-handlers.ts`

按现有 `pi:getContextUsage` 的模式追加：

```ts
ipcMain.handle("pi:listPromptTemplates", async () => {
  if (!piManager) return [];
  return piManager.getPromptTemplates();
});
```

### 2.3 preload：`src/preload/index.ts`

在 `piAPI` 对象里追加（挨着 `listSkills`）：

```ts
listPromptTemplates: () => ipcRenderer.invoke("pi:listPromptTemplates"),
```

同时补 `src/renderer` 侧的 `window.piDesk` 类型声明（项目里 piDesk 类型定义所在的 d.ts）。

### 2.4 渲染层状态：建议直接放进 `skill-store` 或新建轻量 store

现状：`ChatComposer.tsx:248-251` 用 `useSkillStore` 提供 `/` 补全。模板列表生命周期和 skills 一致（都随 services 快照走），**建议直接扩展 `src/renderer/store/skill-store.ts`**，避免多一个 store：

```ts
export interface PromptTemplateInfo {
  name: string;
  description: string;
  argumentHint?: string;
  filePath: string;
}

// state 增加：
promptTemplates: PromptTemplateInfo[];

// load() 里并行拉取：
const [skills, templates] = await Promise.all([
  window.piDesk.listSkills(),
  window.piDesk.listPromptTemplates(),
]);
set({ skills, promptTemplates: templates });
```

### 2.5 ChatComposer 补全菜单：`src/renderer/chat/ChatComposer.tsx`

现状（约 414-460 行）：slash 菜单由两组构成——内置命令（`/compact`）+ skills（`/skill:xxx`）。加第三组「快捷指令」：

```ts
// 现有代码附近（~line 423）
type TemplateEntry = { kind: "template"; info: PromptTemplateInfo };
type SlashEntry = CommandEntry | SkillEntry | TemplateEntry;

const promptTemplates = useSkillStore((s) => s.promptTemplates);

const templateEntries: TemplateEntry[] = showSlash
  ? promptTemplates
      .filter((p) => p.name.toLowerCase().includes(slashQuery!))
      .map((p) => ({ kind: "template", info: p }))
  : [];

// 顺序：内置命令 → 模板 → skills（模板是"纯打字"，比 skill 更接近命令语义）
const entries: SlashEntry[] = [...commandEntries, ...templateEntries, ...skillEntries];
```

选中行为（`pickEntry`，~line 451）：**只填入 `/name `（带尾空格）**，不做本地展开——发送时由 SDK 展开。这样用户还能继续敲参数：

```ts
if (entry.kind === "template") {
  setText(`/${entry.info.name} `);
  textareaRef.current?.focus();
  return;
}
```

渲染分组（~line 701 的 `slashBox` 内，模板组样式复用 `slashItem`）：

```tsx
{templateEntries.length > 0 && (
  <>
    <div className={styles.slashGroupLabel}>{t("slash.templates")}</div>
    {templateEntries.map((p, idx) => (
      <button key={p.info.name} className={/* 同 skill 项，含 activeIdx 高亮 */}>
        <span className={styles.slashName}>/{p.info.name}</span>
        {p.info.argumentHint && (
          <span className={styles.slashArgHint}>{p.info.argumentHint}</span>
        )}
        <span className={styles.slashDesc}>{p.info.description}</span>
      </button>
    ))}
  </>
)}
```

> `slashArgHint` 是新样式类（`ChatComposer.module.css`），弱化色显示参数提示，如 `<PR-URL>`。

### 2.6 i18n：`src/shared/i18n/index.ts`

```ts
// 中文
"slash.templates": "快捷指令",
"slash.templateArgHint": "参数",
// English
"slash.templates": "Snippets",
"slash.templateArgHint": "arguments",
```

### 2.7 P0 必须注意的三个坑

1. **命名冲突**：内置 `/compact` 在 `handleSend` 里被本地拦截（`ChatComposer.tsx` 的 `compactMatch`）。如果用户建了 `compact.md` 模板，本地拦截优先、模板永远不生效——文档/管理 UI 里要提示保留字。skills 用 `/skill:` 前缀天然隔离，模板与内置命令共用裸 `/` 命名空间。
2. **乐观消息显示的是原始文本**：`handleSend` 里 `addMessage({ content: body })` 显示 `/review foo`，但 SDK 会话历史里存的是**展开后全文**——刷新/重开会话后气泡会"变长"。P0 可接受（Claude Code 同款行为是显示原始命令）；若要彻底一致，需主进程在 `message_start` 事件里回传真实 content 替换乐观消息，属于加分项。
3. **列表时效**：模板列表来自 session 的 services 快照。`load()` 的调用时机要覆盖：应用启动、切 workspace（`setCwd` 后）、P1 的热更新事件。

---

## 3. P1：模板文件热更新

问题同 AGENTS.md：SDK 在 services 创建时一次性扫盘，加上我们 `servicesCache` 按 cwd 缓存，用户改/新增模板后客户端不感知。

**实现：直接扩展现有 watcher**（`session-manager.ts` 的 `installContextFileWatchers()`，2026-07-30 已实现 AGENTS.md 监听）：

1. 监听目录追加两个：
   - `~/.pi/agent/prompts/`
   - `{cwd}/.pi/prompts/`
   （目录可能不存在——`fs.watch` 会抛错，沿用现有的 try/catch 静默跳过；若想支持"目录后来才创建"，可监听父目录 `~/.pi/agent/` 和 `{cwd}/.pi/`，按事件文件名过滤。）
2. 事件过滤条件放宽：现有按 `agents.md`/`claude.md` 过滤，追加 `事件来自 prompts 目录且文件名以 .md 结尾`。
3. 命中后动作与现有完全一致（300ms 防抖 → `servicesCache = null` + `session.reload()`），**再补一步**：通知渲染层刷新列表——

```ts
// 主进程防抖回调里追加：
mainWindow?.webContents.send("pi:promptTemplatesChanged");
```

```ts
// preload 追加订阅：
onPromptTemplatesChanged: (cb: () => void) => {
  const l = () => cb();
  ipcRenderer.on("pi:promptTemplatesChanged", l);
  return () => ipcRenderer.removeListener("pi:promptTemplatesChanged", l);
},
```

```ts
// 渲染层（skill-store 或 App 级 useEffect）：
useEffect(() => window.piDesk.onPromptTemplatesChanged(() => useSkillStore.getState().load()), []);
```

---

## 4. P2：模板管理 UI（可选，需求明确后再做）

入口：设置页新增「快捷指令」分组，或复用技能页的卡片式列表（遵循项目 UI 基线：卡片 `12px 16px`、图标盒 32×32、容器 `max-width:640px`）。

功能与实现要点：

| 功能 | 实现 |
|---|---|
| 列表 | 复用 `pi:listPromptTemplates`（已含 `filePath`，可显示来源：全局/项目） |
| 查看/编辑 | 新 IPC `pi:readPromptTemplate(filePath)` / `pi:savePromptTemplate(filePath, content)`——主进程直接 `readFile`/`writeFile`，**必须校验路径在两个 prompts 目录内**（防任意文件读写） |
| 新建 | 表单字段：名字（=文件名，校验 `[a-z0-9-_]`，提示 `compact` 等保留字不可用）、描述、参数提示、正文；写入用户选择的作用域目录（全局/项目），目录不存在先 `mkdir -p` |
| 删除 | `unlink` + 确认弹窗 |
| 生效 | 全部写操作后不需要手动失效缓存——P1 的 watcher 会自动触发 reload + 列表刷新 |

编辑器加分项：正文里高亮 `$1`/`$@`/`${N:-default}` 占位符，底部给一行"输入 `/名字 参数` 使用"的示例预览。

---

## 5. 验证清单（开发完成后逐项过）

1. `~/.pi/agent/prompts/review.md` 建一个带 `$1` 的模板 → 重启应用 → 输入 `/` → 补全菜单出现「快捷指令」分组，显示名字/描述/参数提示。
2. 选中补全项 → 输入框变成 `/review `，续敲参数后发送 → 让模型复述收到的内容，确认是展开后全文（含参数替换）。
3. `{cwd}/.pi/prompts/` 放同名模板 → 确认项目级与全局级都出现（或按 SDK 去重规则显示）。
4. （P1）应用运行中新增/修改模板 `.md` → 不重启，补全列表自动更新，发送即用新内容。
5. 敲一个不存在的 `/xxx yyy` → 确认原样发送（SDK 行为，不算 bug，但管理 UI 文案要解释）。
6. `/compact` 仍走本地压缩逻辑，不被模板机制影响。
7. `tsc --noEmit` + `vite build` EXIT=0。

---

## 6. 涉及文件汇总

| 文件 | 阶段 | 改动 |
|---|---|---|
| `src/main/pi/session-manager.ts` | P0/P1 | `getPromptTemplates()`；watcher 扩展 prompts 目录 + 变更广播 |
| `src/main/ipc-handlers.ts` | P0/P2 | `pi:listPromptTemplates`；P2 读写/删除模板 IPC |
| `src/preload/index.ts` | P0/P1/P2 | `listPromptTemplates` / `onPromptTemplatesChanged` / P2 读写 API |
| `src/renderer/store/skill-store.ts` | P0 | `promptTemplates` 状态 + `load()` 并行拉取 |
| `src/renderer/chat/ChatComposer.tsx` | P0 | slash 菜单第三分组 `TemplateEntry`；`pickEntry` 填 `/name ` |
| `src/renderer/chat/ChatComposer.module.css` | P0 | `slashArgHint` 样式 |
| `src/shared/i18n/index.ts` | P0/P2 | `slash.templates` 等中英文案 |
| `src/renderer/sidebar/SettingsPanel.tsx`（或新组件） | P2 | 管理 UI |
