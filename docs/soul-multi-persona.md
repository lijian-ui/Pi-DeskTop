# Soul 多人格（手动切换）开发文档

> 方案编号：③ 扩展版（`appendSystemPromptOverride` 多文件化）
> 前置依赖：单人格 Soul 功能（已上线，2026-07-30，见 `src/main/pi/soul.ts`）
> 状态：设计完成，未开发

---

## 1. 目标与非目标

### 目标
- 用户可创建**多个人格**（每个人格 = 一段 markdown），在设置页列表中新建 / 编辑 / 删除 / 一键切换激活。
- 同一时刻**只有一个激活人格**注入系统提示词。
- 切换后**热生效**：当前会话下一条消息即带新人格，新会话全局生效，无需重启。
- 外部直接编辑人格文件（`~/.pi/agent/souls/*.md`）同样自动生效。

### 非目标
- 不做"按情绪/时间自动切换"（那是方案 ④，见 `docs/soul-emotion-layer.md`）。
- 不做会话级人格绑定（第一版全局激活；升级路径见 §9）。

---

## 2. 现状基线（改造起点）

单人格实现的关键代码位置（本文档所有 diff 以此为基线）：

| 位置 | 现状 |
|---|---|
| `src/main/pi/soul.ts` | `soulPath()` → `~/.pi/agent/soul.md`；`readSoul()` / `readSoulSync()` / `writeSoul()` |
| `src/main/pi/session-manager.ts:587-596` | `createAgentSessionServices` 传 `resourceLoaderOptions.appendSystemPromptOverride`，钩子内 `readSoulSync()` 现读现取 |
| `src/main/pi/session-manager.ts:648-652` | watcher 的 `isContextFile` 过滤：`agents.md / claude.md / soul.md` |
| `src/main/pi/session-manager.ts:908-929` | `getSoul()` / `saveSoul(text)`（写文件 + `servicesCache=null` + `session.reload()`） |
| `src/main/ipc-handlers.ts:63-71` | `pi:getSoul` / `pi:saveSoul` |
| `src/preload/index.ts` + `src/preload/api.d.ts` | `getSoul()` / `saveSoul(text)` |
| `src/renderer/sidebar/SoulSettings.tsx` + `.module.css` | 单 textarea 编辑页 |

**热加载原理（不变，多人格完全复用）**：`appendSystemPromptOverride` 是 ResourceLoader **每次 (re)load 都执行**的函数钩子（SDK `dist/core/resource-loader.d.ts:112`）。切换人格本质只是"钩子里读哪个文件"变了，失效链路 `servicesCache=null + session.reload()` 现成。

⚠️ **绝不要退回 `appendSystemPrompt:[文本]`**——那是创建时快照，`session.reload()` 拿不到新内容（2026-07-30 已踩坑修复，详见 memory）。

---

## 3. 存储设计

```
~/.pi/agent/
├── souls/                    ← 新增目录，每人格一个文件
│   ├── default.md
│   ├── cheerful.md
│   └── strict-reviewer.md
├── souls.json                ← 新增：激活指针 + 元数据
└── soul.md                   ← 旧单人格文件（迁移后废弃，见 §8）
```

### `souls.json` 结构

```json
{
  "active": "cheerful",
  "personas": [
    { "id": "default",         "name": "默认助手",  "updatedAt": 1753840000000 },
    { "id": "cheerful",        "name": "元气少女",  "updatedAt": 1753841111000 },
    { "id": "strict-reviewer", "name": "严格审稿人", "updatedAt": 1753842222000 }
  ]
}
```

设计决策：
- **正文与元数据分离**：markdown 正文放 `souls/<id>.md`（用户可外部编辑），名称/顺序等元数据放 `souls.json`。
- `id` 由名称派生（slug：小写 + 空格转 `-` + 去非法字符），**生成后不变**；重名时追加 `-2`。
- `active: null` 或指向不存在的 id = 无人格（合法状态，钩子返回 base 原样）。
- 不放 `settings.json`：与既有约定一致（soul 正文不污染结构化配置），且 `souls/` 目录天然支持外部编辑。

---

## 4. 主进程改造：`src/main/pi/soul.ts`

保持模块自治——session-manager 只调用导出函数，所有文件布局知识封在本模块。

```ts
// src/main/pi/soul.ts —— 多人格版（完整替换现有实现，保留旧 API 兼容层见 §8）
import { readFile, writeFile, mkdir, unlink, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface PersonaMeta {
  id: string;
  name: string;
  updatedAt: number;
}

export interface SoulsIndex {
  active: string | null;
  personas: PersonaMeta[];
}

export function soulsDir(): string {
  return join(getAgentDir(), "souls");
}

export function soulsIndexPath(): string {
  return join(getAgentDir(), "souls.json");
}

export function personaPath(id: string): string {
  return join(soulsDir(), `${id}.md`);
}

/** 名称 → 文件系统安全 id（slug）。重名冲突由调用方追加 -2 后缀处理。 */
export function slugify(name: string): string {
  return name.trim().toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]/g, "")
    .slice(0, 64) || "persona";
}

export async function readSoulsIndex(): Promise<SoulsIndex> {
  try {
    const raw = JSON.parse(await readFile(soulsIndexPath(), "utf-8"));
    return {
      active: typeof raw.active === "string" ? raw.active : null,
      personas: Array.isArray(raw.personas) ? raw.personas : [],
    };
  } catch {
    return { active: null, personas: [] };
  }
}

async function writeSoulsIndex(index: SoulsIndex): Promise<void> {
  await mkdir(getAgentDir(), { recursive: true });
  await writeFile(soulsIndexPath(), JSON.stringify(index, null, 2), "utf-8");
}

/** 列表（含正文预览首行，供 UI 卡片显示）。 */
export async function listPersonas(): Promise<Array<PersonaMeta & { preview: string }>> {
  const index = await readSoulsIndex();
  const out = [];
  for (const p of index.personas) {
    let preview = "";
    try {
      const text = await readFile(personaPath(p.id), "utf-8");
      preview = text.trim().split("\n")[0]?.slice(0, 80) ?? "";
    } catch { /* 文件被外部删除 —— 列表仍显示，正文为空 */ }
    out.push({ ...p, preview });
  }
  return out;
}

export async function readPersona(id: string): Promise<string> {
  try {
    return await readFile(personaPath(id), "utf-8");
  } catch {
    return "";
  }
}

/** 新建或更新人格。id 为空 = 新建（由 name slug 派生）。返回最终 id。 */
export async function upsertPersona(opts: {
  id?: string; name: string; content: string;
}): Promise<string> {
  const index = await readSoulsIndex();
  let id = opts.id;
  if (!id) {
    const base = slugify(opts.name);
    id = base;
    let n = 2;
    while (index.personas.some((p) => p.id === id)) id = `${base}-${n++}`;
  }
  await mkdir(soulsDir(), { recursive: true });
  await writeFile(personaPath(id), opts.content, "utf-8");
  const existing = index.personas.find((p) => p.id === id);
  if (existing) {
    existing.name = opts.name;
    existing.updatedAt = Date.now();
  } else {
    index.personas.push({ id, name: opts.name, updatedAt: Date.now() });
  }
  await writeSoulsIndex(index);
  return id;
}

export async function deletePersona(id: string): Promise<void> {
  const index = await readSoulsIndex();
  index.personas = index.personas.filter((p) => p.id !== id);
  if (index.active === id) index.active = null; // 删除激活项 → 回到无人格
  await writeSoulsIndex(index);
  try { await unlink(personaPath(id)); } catch { /* 已被外部删除 */ }
}

export async function setActivePersona(id: string | null): Promise<void> {
  const index = await readSoulsIndex();
  index.active = id;
  await writeSoulsIndex(index);
}

/**
 * ⚠️ 核心热加载钩子（同步！）。被 appendSystemPromptOverride 在每次
 * ResourceLoader (re)load 时调用：现场读 souls.json 的 active 指针，再读对应
 * 人格正文。任何一步失败都返回 ""（无人格是合法状态，不是错误）。
 */
export function readActiveSoulSync(): string {
  try {
    const raw = JSON.parse(readFileSync(soulsIndexPath(), "utf-8"));
    const active = typeof raw.active === "string" ? raw.active : null;
    if (!active) return "";
    return readFileSync(personaPath(active), "utf-8").trim();
  } catch {
    return "";
  }
}
```

---

## 5. `session-manager.ts` 改造（3 处小改）

### 5.1 注入钩子改读激活人格

`buildRuntime` 内（现 587-596 行）只改一个函数名：

```ts
// import 行：
import { readActiveSoulSync, listPersonas, readPersona, upsertPersona,
         deletePersona, setActivePersona, readSoulsIndex } from "./soul";

// createAgentSessionServices 调用处：
resourceLoaderOptions: {
  appendSystemPromptOverride: (base: string[]) => {
    const soul = readActiveSoulSync();   // ← 原 readSoulSync()
    return soul ? [...base, soul] : base;
  },
},
```

### 5.2 失效方法（替换原 `getSoul`/`saveSoul`，现 908-929 行）

```ts
/** 统一失效：写盘后调它，当前会话+新会话都拿到新人格。 */
private invalidateSoul(): void {
  this.servicesCache = null;
  Promise.resolve(this.session?.reload?.()).catch((err) => {
    console.warn("Soul change: session reload skipped:", err);
  });
}

async listPersonas() { return listPersonas(); }
async getPersona(id: string) { return readPersona(id); }
async getSoulsIndex() { return readSoulsIndex(); }

async savePersona(opts: { id?: string; name: string; content: string }): Promise<string> {
  const id = await upsertPersona(opts);
  const index = await readSoulsIndex();
  if (index.active === id) this.invalidateSoul(); // 只有改的是激活人格才需要 reload
  return id;
}

async removePersona(id: string): Promise<void> {
  const wasActive = (await readSoulsIndex()).active === id;
  await deletePersona(id);
  if (wasActive) this.invalidateSoul();
}

async activatePersona(id: string | null): Promise<void> {
  await setActivePersona(id);
  this.invalidateSoul(); // 切换必失效
}
```

### 5.3 watcher 扩展（现 648-652 行）

⚠️ **坑：`fs.watch` 非递归**。现有 watcher 只监听 `~/.pi/agent` 这一层，`souls/` 子目录里的文件变更**不会触发**。必须单独加一个对 `souls/` 目录的 watch。

```ts
// installContextFileWatchers() 内：
const isContextFile = (name: string | null): boolean => {
  if (!name) return false;
  const n = name.toLowerCase();
  // souls.json 在 agentDir 顶层，active 指针变更走这里
  return n === "agents.md" || n === "claude.md" || n === "souls.json";
};

// 目录集合 dirs 构建后追加（agentDir 顶层循环之外）：
const soulsDirPath = join(getAgentDir(), "souls");
if (existsSync(soulsDirPath)) {
  try {
    const w = watch(soulsDirPath, (_event, filename) => {
      if (filename?.toLowerCase().endsWith(".md")) this.onContextFileChanged();
    });
    w.unref?.();
    w.on("error", () => {});
    this.contextFileWatchers.push(w);
  } catch { /* skip */ }
}
```

注：`souls/` 目录首次由 UI 创建时 watcher 未装上（目录当时不存在）——`upsertPersona` 走 IPC 保存本就显式失效，不依赖 watcher；下次 `buildRuntime`（init/setCwd）会重装 watcher 覆盖外部编辑场景。可接受。

---

## 6. IPC 链路

### `src/main/ipc-handlers.ts`（替换现 63-71 行的两个 handler）

```ts
// ── Soul / persona（多人格）──
ipcMain.handle("pi:listPersonas", async () => {
  if (!piManager) throw new Error("Pi SDK not initialized");
  return piManager.listPersonas();
});
ipcMain.handle("pi:getSoulsIndex", async () => {
  if (!piManager) throw new Error("Pi SDK not initialized");
  return piManager.getSoulsIndex();
});
ipcMain.handle("pi:getPersona", async (_, id: string) => {
  if (!piManager) throw new Error("Pi SDK not initialized");
  return piManager.getPersona(id);
});
ipcMain.handle("pi:savePersona", async (_, opts) => {
  if (!piManager) throw new Error("Pi SDK not initialized");
  return piManager.savePersona(opts);
});
ipcMain.handle("pi:removePersona", async (_, id: string) => {
  if (!piManager) throw new Error("Pi SDK not initialized");
  await piManager.removePersona(id);
});
ipcMain.handle("pi:activatePersona", async (_, id: string | null) => {
  if (!piManager) throw new Error("Pi SDK not initialized");
  await piManager.activatePersona(id);
});
```

### `src/preload/api.d.ts`

```ts
export interface PersonaMeta { id: string; name: string; updatedAt: number; preview?: string }

// PiDeskAPI 内（替换 getSoul/saveSoul）：
listPersonas(): Promise<PersonaMeta[]>;
getSoulsIndex(): Promise<{ active: string | null; personas: PersonaMeta[] }>;
getPersona(id: string): Promise<string>;
savePersona(opts: { id?: string; name: string; content: string }): Promise<string>;
removePersona(id: string): Promise<void>;
activatePersona(id: string | null): Promise<void>;
```

### `src/preload/index.ts`

```ts
listPersonas: () => ipcRenderer.invoke("pi:listPersonas"),
getSoulsIndex: () => ipcRenderer.invoke("pi:getSoulsIndex"),
getPersona: (id: string) => ipcRenderer.invoke("pi:getPersona", id),
savePersona: (opts: { id?: string; name: string; content: string }) =>
  ipcRenderer.invoke("pi:savePersona", opts),
removePersona: (id: string) => ipcRenderer.invoke("pi:removePersona", id),
activatePersona: (id: string | null) => ipcRenderer.invoke("pi:activatePersona", id),
```

---

## 7. 渲染端：`SoulSettings.tsx` 升级为人格列表页

文件不变（`src/renderer/sidebar/SoulSettings.tsx`），页面从"单 textarea"升级为"列表 + 编辑器"两态。**样式遵循项目卡片式列表页基线**（卡片 padding `12px 16px`、min-height 56px、`border:1px solid var(--border-neutral-l1)` radius-10、项间距 `var(--spacer-10)`、容器 `max-width:640px;margin:0 auto`），主按钮/次按钮配色对齐 `SecurityPage.module.css`。

### 组件结构（拆分，不堆单文件）

```
src/renderer/sidebar/
├── SoulSettings.tsx          ← 容器：状态机 list | edit，数据加载
├── SoulSettings.module.css
├── PersonaCard.tsx           ← 单张人格卡片（名称/预览/激活标记/操作按钮）
└── PersonaEditor.tsx         ← 编辑器（名称输入 + 正文 textarea + 保存/取消）
```

### `SoulSettings.tsx` 核心逻辑

```tsx
type View = { mode: "list" } | { mode: "edit"; id?: string };

export default function SoulSettings() {
  const { t } = useTranslation();
  const [view, setView] = useState<View>({ mode: "list" });
  const [personas, setPersonas] = useState<PersonaMeta[]>([]);
  const [active, setActive] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [list, index] = await Promise.all([
      window.piDesk.listPersonas(),
      window.piDesk.getSoulsIndex(),
    ]);
    setPersonas(list);
    setActive(index.active);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleActivate(id: string) {
    // 再点激活项 = 取消激活（回到无人格）
    await window.piDesk.activatePersona(id === active ? null : id);
    await refresh();
  }

  async function handleDelete(id: string) {
    await window.piDesk.removePersona(id);
    await refresh();
  }

  if (view.mode === "edit") {
    return (
      <PersonaEditor
        id={view.id}
        onDone={async () => { setView({ mode: "list" }); await refresh(); }}
      />
    );
  }

  return (
    <div className={styles.page}>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{t("soul.listTitle")}</h2>
        <p className={styles.sectionDesc}>{t("soul.listDesc")}</p>
        {personas.map((p) => (
          <PersonaCard
            key={p.id}
            persona={p}
            isActive={p.id === active}
            onActivate={() => handleActivate(p.id)}
            onEdit={() => setView({ mode: "edit", id: p.id })}
            onDelete={() => handleDelete(p.id)}
          />
        ))}
        <button className={styles.addBtn} onClick={() => setView({ mode: "edit" })}>
          {t("soul.addPersona")}
        </button>
      </section>
    </div>
  );
}
```

### `PersonaEditor.tsx` 要点

```tsx
export default function PersonaEditor({ id, onDone }: { id?: string; onDone: () => void }) {
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  // id 存在 → 编辑态：进入时并行拉 index（取 name）+ 正文
  useEffect(() => {
    if (!id) return;
    (async () => {
      const [index, text] = await Promise.all([
        window.piDesk.getSoulsIndex(),
        window.piDesk.getPersona(id),
      ]);
      setName(index.personas.find((p) => p.id === id)?.name ?? id);
      setContent(text);
    })();
  }, [id]);

  async function handleSave() {
    if (!name.trim()) return; // 名称必填
    await window.piDesk.savePersona({ id, name: name.trim(), content });
    onDone();
  }
  // ... textarea 样式复用现有 SoulSettings.module.css 的 .textarea（等宽字体）
}
```

### i18n 词条（`src/shared/i18n/index.ts`，中英两块各加）

```ts
// 中文块（保留现有 soul.* 编辑器词条，新增：）
"soul.listTitle": "人格列表",
"soul.listDesc": "创建多个人格，激活的人格会注入到每次对话的系统提示词中。",
"soul.addPersona": "新建人格",
"soul.activate": "激活",
"soul.deactivate": "取消激活",
"soul.activeBadge": "使用中",
"soul.edit": "编辑",
"soul.delete": "删除",
"soul.deleteConfirm": "删除该人格？此操作不可撤销。",
"soul.nameLabel": "人格名称",
"soul.namePlaceholder": "例如：严格审稿人",
```

---

## 8. 旧数据迁移（`soul.md` → 多人格）

在 `readSoulsIndex()` 首次发现"无 `souls.json` 但存在旧 `~/.pi/agent/soul.md` 且非空"时自动迁移（懒迁移，无需启动钩子）：

```ts
// soul.ts 内，readSoulsIndex 的 catch 分支之前插入：
async function migrateLegacySoul(): Promise<SoulsIndex | null> {
  const legacy = join(getAgentDir(), "soul.md");
  if (existsSync(soulsIndexPath()) || !existsSync(legacy)) return null;
  const text = (await readFile(legacy, "utf-8")).trim();
  if (!text) return null;
  await mkdir(soulsDir(), { recursive: true });
  await writeFile(personaPath("default"), text, "utf-8");
  const index: SoulsIndex = {
    active: "default",
    personas: [{ id: "default", name: "默认人格", updatedAt: Date.now() }],
  };
  await writeSoulsIndex(index);
  // 不删 soul.md（留作用户备份），但 watcher 过滤中移除 soul.md 避免双触发
  return index;
}
```

迁移后行为与迁移前完全一致（激活的 default 人格 = 旧 soul 内容）。

---

## 9. 升级路径：会话级人格（预留，不实现）

- `SessionMeta`（会话元数据）加可选 `personaId` 字段；
- `readActiveSoulSync()` 改为接受"当前会话 personaId 优先，回落全局 active"——由于钩子是无参同步函数，需要 session-manager 在切会话时把 personaId 写入一个模块级变量（如 `setSessionPersonaOverride(id)`），钩子读它；
- 切会话时 `invalidateSoul()` 即可（桌面端同一时刻只有一个活跃会话）。
- 与方案 ④（情绪修饰层）完全正交：④ 在 ③ 之上叠加当轮修饰，见 `docs/soul-emotion-layer.md`。

---

## 10. 测试清单

1. 新建人格 A/B → 列表显示两张卡片，均未激活 → 对话无人格。
2. 激活 A → 当前会话下一条消息带 A 人格；新建会话同样带 A。
3. 切换到 B → 不重启，下一条消息立即变 B（验证 `invalidateSoul` 链路）。
4. 再点 B（取消激活）→ 回到无人格。
5. 编辑**激活中**的 B 正文保存 → 立即生效；编辑**未激活**的 A → 不触发 reload（观察主进程日志无 "Soul change"）。
6. 外部编辑器直接改 `souls/b.md` → 300ms 防抖后自动生效（验证 `souls/` 子目录 watcher）。
7. 外部直接改 `souls.json` 的 `active` → 自动生效（验证顶层 watcher 对 `souls.json` 的过滤）。
8. 删除激活中的人格 → active 归 null，对话回到无人格。
9. 旧用户：存在非空 `soul.md`、无 `souls.json` → 首次打开设置页自动出现"默认人格"且激活。
10. `npm run build`（`tsc --noEmit && vite build`）EXIT=0。

---

## 11. 改动文件汇总

| 文件 | 类型 | 内容 |
|---|---|---|
| `src/main/pi/soul.ts` | 重写 | 多人格 CRUD + `readActiveSoulSync` + 懒迁移 |
| `src/main/pi/session-manager.ts` | 修改 | 钩子改 `readActiveSoulSync`；6 个转发方法 + `invalidateSoul`；watcher 加 `souls.json` 过滤 + `souls/` 子目录监听 |
| `src/main/ipc-handlers.ts` | 修改 | 6 个 `pi:*Persona*` handler（替换原 2 个） |
| `src/preload/index.ts` / `api.d.ts` | 修改 | 对应 6 个方法 + `PersonaMeta` 类型 |
| `src/renderer/sidebar/SoulSettings.tsx` | 重写 | 列表/编辑两态容器 |
| `src/renderer/sidebar/PersonaCard.tsx` | 新建 | 人格卡片组件 |
| `src/renderer/sidebar/PersonaEditor.tsx` | 新建 | 人格编辑器组件 |
| `src/renderer/sidebar/SoulSettings.module.css` | 修改 | 卡片列表样式（对齐 UI 基线） |
| `src/shared/i18n/index.ts` | 修改 | `soul.*` 新增词条（中英） |
