# 定时任务（Scheduled Tasks）设计文档

> 状态：设计方案，未开发。
> 前置事实（已源码确认，2026-07-30）：Pi SDK **无内置定时任务/cron 机制**（全库搜 schedul/cron/recurring/periodic 均为假阳性；扩展事件全部是会话/轮次生命周期驱动，且 `extensions.md:222` 明确警告扩展 factory 内不要起 timer）。调度器必须放在**我们自己的 Electron 主进程**。

---

## 1. 需求

1. **定时触发 agent 执行任务**：到点自动发起一轮完整的 agent 对话（工具、技能全可用）。
2. **专属系统提示词**：
   - **去掉 Soul 区块**（`<personality>`）——定时任务是执行器人格，不需要加载用户的陪伴人格；
   - **追加 `<scheduled_task>` 区块**，形如：

   ```
   <scheduled_task>
   你是一个定时任务的执行 Agent。你的任务是：

   ## 任务
   现在是早上9点（北京时间），请使用 weather_query 技能查询北京的实时天气和未来3天预报，
   并将结果以友好的格式回复给用户李健。

   ## 规则
   - 专注于完成分配的任务
   - 完成后给出清晰的总结
   - 使用中文回复
   </scheduled_task>
   ```

3. **会话列表集成**：任务执行完成后，产生的会话自动出现在侧栏「会话任务」下方的**「定时任务」专区**，并**以定时任务为分组依据**（每个任务一个组，组内是历次执行的会话）。
4. **不干扰用户**：任务执行使用独立会话，用户当前正在聊的会话零影响。

---

## 2. SDK 关键 API（源码级确认）

| API | 位置 | 用途 |
|---|---|---|
| `PiSessionManager.create(cwd, sessionDir?, options?)` | `session-manager.d.ts:313` | 创建**独立落盘**会话（默认写入 `~/.pi/agent/sessions/<encoded-cwd>/`），与主 runtime 的会话互不干扰 |
| `PiSessionManager.list(cwd)` | `session-manager.d.ts:343` | 现有侧栏会话列表数据源（`listSessions()`，session-manager.ts:1079），定时会话落盘后**自动出现在这里** |
| `createAgentSessionServices({cwd, modelRuntime, resourceLoaderOptions})` | 现有用法 session-manager.ts:587 | 为任务构建**专属 services**：`extensionFactories` 只放任务扩展、不放 `soulExtension` → Soul 天然不注入 |
| `createAgentSessionFromServices({services, sessionManager})` | 现有用法 session-manager.ts:597 | 由专属 services + 独立 SessionManager 组装 headless 会话 |
| `session.prompt(text)` | `sdk.md:73`，现有用法 session-manager.ts:811 | 程序化发起对话，resolve 即整轮跑完 |
| `InlineExtension` + `before_agent_start` | 现有 `soul-extension.ts` 同款 | 注入 `<scheduled_task>` 区块到系统提示词绝对末尾 |
| `NewSessionOptions` 只有 `{id?, parentSession?}` | `session-manager.d.ts:13-16` | **不支持创建时命名会话** → 任务↔会话的关联必须由我们自己的 runs 注册表维护（见 §3.2） |

---

## 3. 数据模型

### 3.1 任务定义 `~/.pi/agent/scheduled-tasks.json`

```jsonc
{
  "tasks": [
    {
      "id": "t-01JXXXXXX",            // nanoid/uuid
      "name": "北京天气播报",           // 侧栏分组名 + 管理页显示名
      "enabled": true,
      "cwd": "E:\\Project\\pi-desktop", // 任务执行的工作目录（决定技能/AGENTS.md 上下文）
      "prompt": "请使用 weather_query 技能查询北京的实时天气和未来3天预报，并将结果以友好的格式回复给用户李健。",
      "rules": "- 专注于完成分配的任务\n- 完成后给出清晰的总结\n- 使用中文回复",
      "schedule": {                    // v1 三种类型，不引入完整 cron 语法
        "type": "daily",               // "daily" | "interval" | "once"
        "time": "09:00",               // daily: 每天 HH:mm（本地时区）
        "everyMinutes": null,          // interval: 每 N 分钟
        "at": null                     // once: ISO datetime，执行一次后自动 enabled=false
      },
      "createdAt": "2026-07-30T10:00:00+08:00"
    }
  ]
}
```

### 3.2 执行记录 `~/.pi/agent/scheduled-runs.json`（任务 ↔ 会话的关联表）

这是**侧栏分组的依据**。SDK 无法在创建会话时打标签（`NewSessionOptions` 无 name/metadata），所以由我们记录 sessionPath → taskId 映射：

```jsonc
{
  "runs": [
    {
      "taskId": "t-01JXXXXXX",
      "sessionPath": "C:\\Users\\...\\sessions\\...\\01K1ABC.jsonl",
      "startedAt": "2026-07-30T09:00:01+08:00",
      "finishedAt": "2026-07-30T09:00:37+08:00",
      "status": "success"              // "success" | "error" | "running"
    }
  ]
}
```

维护规则：会话被删除（`deleteSession`）时同步清理对应 run 记录；启动时做一次孤儿 GC（sessionPath 不存在 → 删 run），复用 context-usage GC 的成熟模式（含墓碑防复活的教训：**runs 文件读写也走 single-flight**）。

---

## 4. 系统提示词注入

### 4.1 新文件 `src/main/pi/scheduled-task-extension.ts`

工厂函数（每个任务运行时现场构造，携带任务内容）。与 `soul-extension.ts` 完全同构：

```ts
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { ScheduledTask } from "./scheduled-tasks";

/** 注入时间等动态变量：任务 prompt 里可写 {time} / {date} 占位符 */
function renderPrompt(task: ScheduledTask): string {
  const now = new Date();
  const time = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const date = now.toLocaleDateString("zh-CN");
  return task.prompt.replaceAll("{time}", time).replaceAll("{date}", date);
}

export function createScheduledTaskExtension(task: ScheduledTask): InlineExtension {
  return {
    name: "scheduled-task",
    factory: (pi) => {
      pi.on("before_agent_start", (event) => {
        const block = [
          "<scheduled_task>",
          "你是一个定时任务的执行 Agent。你的任务是：",
          "",
          "## 任务",
          `现在是 ${new Date().toLocaleString("zh-CN")}（本地时间），${renderPrompt(task)}`,
          "",
          "## 规则",
          task.rules || "- 专注于完成分配的任务\n- 完成后给出清晰的总结\n- 使用中文回复",
          "</scheduled_task>",
        ].join("\n");
        return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
      });
    },
  };
}
```

### 4.2 去掉 Soul 的方式：**根本不注册 soulExtension**

主会话（用户聊天）走 `buildRuntime` 里的 `extensionFactories: [soulExtension]`（session-manager.ts:591）——**不动**。

定时任务走**独立 services**，只放任务扩展：

```ts
const services = await createAgentSessionServices({
  cwd: task.cwd,
  modelRuntime,          // 复用主进程已有的 this.modelRuntime
  resourceLoaderOptions: {
    extensionFactories: [createScheduledTaskExtension(task)],  // 没有 soulExtension
  },
});
```

Soul 是扩展注入的（不在 resource-loader 静态段），不注册即不存在——**零残留、无需任何"剔除"逻辑**。

最终任务会话的系统提示词结构：

```
1. Pi 原始提示词（工具/编码指令）
2. <project_context>（task.cwd 的 AGENTS.md）
3. skills（weather_query 等技能描述在此 → 任务里才能调用）
4. Current working directory: ...
5. <scheduled_task>  ← 替代原来 <personality> 的位置
```

> 注意：任务专属 services **不放进 `servicesCache`**（那是主会话的单槽缓存）。任务频率低，每次现建（数秒）可接受；如需优化，v2 可为每个 taskId 缓存 services 并沿用同一套失效逻辑。

---

## 5. 调度器 `src/main/pi/scheduler.ts`（新文件，主进程模块）

```ts
import { readScheduledTasks, type ScheduledTask } from "./scheduled-tasks";

const TICK_MS = 30_000; // 30s 轮询，分钟级精度足够

export class TaskScheduler {
  private timer: NodeJS.Timeout | null = null;
  private runningTaskIds = new Set<string>();     // 防重入：同一任务上次未结束则跳过
  private lastFired = new Map<string, string>();  // taskId → "YYYY-MM-DD HH:mm"，防同一分钟重复触发

  constructor(private runTask: (task: ScheduledTask) => Promise<void>) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => this.tick().catch(console.error), TICK_MS);
    this.timer.unref(); // 不阻止进程退出，与 contextFileWatchers 同款约定
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async tick(): Promise<void> {
    const { tasks } = await readScheduledTasks();
    const now = new Date();
    for (const task of tasks) {
      if (!task.enabled || this.runningTaskIds.has(task.id)) continue;
      if (!this.isDue(task, now)) continue;
      this.markFired(task, now);
      this.runningTaskIds.add(task.id);
      this.runTask(task)
        .catch((err) => console.error(`Scheduled task ${task.name} failed:`, err))
        .finally(() => this.runningTaskIds.delete(task.id));
    }
  }

  private isDue(task: ScheduledTask, now: Date): boolean {
    const s = task.schedule;
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const stamp = `${now.toDateString()} ${hhmm}`;
    switch (s.type) {
      case "daily":
        return s.time === hhmm && this.lastFired.get(task.id) !== stamp;
      case "interval": {
        const last = this.lastFired.get(task.id);
        if (!last) return true; // 启动后首个 tick 即跑一次
        return now.getTime() - new Date(last).getTime() >= (s.everyMinutes ?? 60) * 60_000;
      }
      case "once":
        return !!s.at && now >= new Date(s.at) && !this.lastFired.has(task.id);
    }
  }

  private markFired(task: ScheduledTask, now: Date): void {
    this.lastFired.set(task.id, /* daily 用 stamp，interval/once 用 ISO */ now.toISOString());
    // once 类型：触发后立即把 enabled 置 false 并写回文件（防重启后再跑）
  }
}
```

设计要点：
- **调度精度**：30s tick + 分钟级配置。不引入 node-cron 依赖（v1 三种 schedule 类型用不上 cron 表达式的复杂度）。
- **防重入**：`runningTaskIds`，任务本身跑几分钟很正常。
- **错过不补**（v1 取舍）：应用没开时到点的任务直接跳过（Electron 进程内调度，非系统级；要系统级需 OS 任务计划程序，超出范围）。`daily` 的判断是"当前分钟 === 配置分钟"，重启后错过就等明天。
- `timer.unref()`：不影响应用退出。

---

## 6. 执行链路：`session-manager.ts` 新增 `runScheduledTask`

注入点与现有代码完全同构（对照 buildRuntime 的 session-manager.ts:587-603）：

```ts
// session-manager.ts 新增方法
async runScheduledTask(task: ScheduledTask): Promise<void> {
  if (!this.modelRuntime) throw new Error("Model runtime not ready");

  // 1. 独立 services：只带任务扩展，无 soulExtension（→ 无 <personality>）
  const services = await createAgentSessionServices({
    cwd: task.cwd,
    modelRuntime: this.modelRuntime,
    resourceLoaderOptions: {
      extensionFactories: [createScheduledTaskExtension(task)],
    },
  });

  // 2. 独立落盘会话（不碰 this.session / this.runtime → 用户当前对话零影响）
  const sm = PiSessionManager.create(task.cwd);
  const { session } = await createAgentSessionFromServices({ services, sessionManager: sm });

  // 3. 先登记 run（status: running），拿到 sessionPath
  const sessionPath = sm.getSessionFile()!;
  await appendRun({ taskId: task.id, sessionPath, startedAt: new Date().toISOString(), status: "running" });
  this.webContents?.send("scheduledTask:started", { taskId: task.id, sessionPath });

  // 4. 固定触发语发起对话（任务内容在系统提示词里，用户消息只是扳机）
  try {
    await session.prompt("请开始执行本次定时任务。");
    await updateRun(sessionPath, { finishedAt: new Date().toISOString(), status: "success" });
  } catch (err) {
    await updateRun(sessionPath, { finishedAt: new Date().toISOString(), status: "error" });
    throw err;
  } finally {
    session.dispose();
    // 5. 通知渲染端刷新侧栏（sessionStore.load() 会重新 listSessions + 读 runs）
    this.webContents?.send("scheduledTask:completed", { taskId: task.id, sessionPath });
  }
}
```

生命周期接入：

```ts
// init() 末尾
this.scheduler = new TaskScheduler((task) => this.runScheduledTask(task));
this.scheduler.start();

// dispose() 里
this.scheduler?.stop();
```

> **cwd 注意**：任务的 `cwd` 可以 ≠ 当前工作区。`PiSessionManager.create(task.cwd)` 会把会话写进对应 cwd 的 sessions 目录；侧栏 `listSessions()` 目前只列**当前工作区**的会话（`PiSessionManager.list(this.cwd)`），所以 v1 建议：**管理页创建任务时默认锁定 cwd = 当前工作区**，跨工作区任务的会话在切到那个工作区后可见（v2 可改用 `PiSessionManager.listAll()` 全局呈现）。

---

## 7. 侧栏「定时任务」分组

### 7.1 现状（Sidebar.tsx）

- `groupSessions(sessions, ungroupedLabel)`（Sidebar.tsx:91）按 `cwd` 分组为折叠组，「未分组」置底。
- 数据源：`useSessionStore.load()` → `window.piDesk.listSessions()`。

### 7.2 改造

**session-store.ts**：新增 `scheduledRuns` 状态，`load()` 里并行拉取：

```ts
const [sessions, current, workspaceCwd, scheduled] = await Promise.all([
  window.piDesk.listSessions(),
  window.piDesk.getCurrentSession(),
  window.piDesk.getCwd(),
  window.piDesk.getScheduledRuns(),   // { tasks: ScheduledTask[], runs: Run[] }
]);
```

**Sidebar.tsx**：分组逻辑扩展为三层结构：

```ts
// 1. runs 里出现过的 sessionPath 集合
const scheduledPaths = new Set(scheduled.runs.map((r) => r.sessionPath));

// 2. 常规分组：过滤掉定时任务会话，避免在文件夹组里重复出现
const normalGroups = groupSessions(sessions.filter((s) => !scheduledPaths.has(s.path)), t("sessions.ungrouped"));

// 3. 定时任务分组：以 task 为组，组内按执行时间倒序
const scheduledGroups = scheduled.tasks
  .map((task) => ({
    key: `sched:${task.id}`,
    label: task.name,                          // ← 以定时任务作为分组依据
    sessions: scheduled.runs
      .filter((r) => r.taskId === task.id)
      .map((r) => sessions.find((s) => s.path === r.sessionPath))
      .filter(Boolean)
      .sort((a, b) => +new Date(b!.modified) - +new Date(a!.modified)),
  }))
  .filter((g) => g.sessions.length > 0);
```

渲染结构（会话任务下方新增区块）：

```
会话任务
├─ 📁 pi-desktop           ← 现有 cwd 分组（不含定时会话）
│   ├─ 会话 A
│   └─ 会话 B
├─ 📁 未分组
│
⏰ 定时任务                 ← 新区块标题（AlarmClock 图标）
├─ 🗂 北京天气播报 (3)       ← 以任务为组，可折叠
│   ├─ 07-30 09:00 ✅      ← 每次执行一个会话项，点击 = selectSession(path)
│   ├─ 07-29 09:00 ✅
│   └─ 07-28 09:00 ❌      ← status=error 标红点
└─ 🗂 每日代码巡检 (1)
```

- 会话项标题用执行时间（`run.startedAt` 格式化），而非 firstMessage（每次都是同一句触发语，无区分度）。
- 点击行为复用现成 `selectSession(path)` —— 定时会话就是普通落盘会话，可查看、可继续追问、可删除、可导出。
- 折叠状态并入现有 `collapsedGroups` Set（key 用 `sched:` 前缀防碰撞）。
- 主进程 `scheduledTask:completed` 事件到达时调用 `sessionStore.load()` 刷新（在现有事件订阅处注册，与 `workspace:changed` 同款模式）。

---

## 8. 任务管理页（UI）

位置：**设置 → 定时任务**（SettingsPage.tsx 新增 nav 项 `scheduled` + 渲染分支，与 SoulSettings 接入方式相同）。

组件（模块化拆分，对齐 UI 一致性基线：卡片 12px 16px padding / 32×32 图标盒 / radius-10 / max-width 640）：

| 文件 | 职责 |
|---|---|
| `src/renderer/sidebar/ScheduledTasksPage.tsx` | 任务卡片列表 + 新建按钮；每卡片显示 name/schedule 摘要/enabled 开关/最近一次执行状态 |
| `src/renderer/sidebar/ScheduledTaskEditor.tsx` | 新建/编辑表单：名称、任务内容（textarea，提示可用 `{time}`/`{date}` 占位符）、规则（textarea，预填默认三条）、调度类型三选一（daily 时间选择 / interval 分钟数 / once 日期时间）、启用开关。立即执行按钮（调 `runScheduledTaskNow`，方便调试） |
| `ScheduledTasks.module.css` | 风格对齐 SecurityPage/SoulSettings（var(--spacer-*) + 既有调色板） |

---

## 9. IPC 链路（标准三段，对照 soul 的现成模式）

| 通道 | 签名 | 说明 |
|---|---|---|
| `pi:getScheduledTasks` | `(): Promise<{tasks, runs}>` | 管理页 + 侧栏共用 |
| `pi:saveScheduledTask` | `(task: ScheduledTask): Promise<void>` | 按 id upsert（**沿用模型 upsert 的教训，不整体替换**） |
| `pi:deleteScheduledTask` | `(taskId): Promise<void>` | 同时删 runs 记录（可选保留会话文件，确认框询问） |
| `pi:runScheduledTaskNow` | `(taskId): Promise<void>` | 手动立即执行（调试/管理页按钮） |
| 事件 `scheduledTask:started` / `scheduledTask:completed` | main → renderer | 侧栏刷新 + 可选 toast 通知 |

`ipc-handlers.ts` / `preload/index.ts` / `preload/api.d.ts` 三处按 `pi:getSoul`/`pi:saveSoul` 同款模式添加。

---

## 10. 新增/改动文件清单

| 文件 | 新建/改动 | 内容 |
|---|---|---|
| `src/main/pi/scheduled-tasks.ts` | 新建 | 任务 + runs 的 JSON 读写（single-flight 加载、runs 孤儿 GC、appendRun/updateRun） |
| `src/main/pi/scheduled-task-extension.ts` | 新建 | `createScheduledTaskExtension(task)`（§4.1） |
| `src/main/pi/scheduler.ts` | 新建 | `TaskScheduler`（§5） |
| `src/main/pi/session-manager.ts` | 改动 | `runScheduledTask()`（§6）+ init/dispose 接入 scheduler + `deleteSession` 联动清 run |
| `src/main/ipc-handlers.ts` | 改动 | 4 个 handler（§9） |
| `src/preload/index.ts` + `api.d.ts` | 改动 | 4 方法 + 2 事件订阅 |
| `src/renderer/sidebar/ScheduledTasksPage.tsx` + `Editor` + `.module.css` | 新建 | 管理页（§8） |
| `src/renderer/sidebar/SettingsPage.tsx` | 改动 | nav 项 + 渲染分支 |
| `src/renderer/layout/Sidebar.tsx` | 改动 | 定时任务分组区块（§7.2） |
| `src/renderer/store/session-store.ts` | 改动 | `scheduledRuns` 状态 + load 并行拉取 |
| `src/shared/i18n/index.ts` | 改动 | `scheduled.*` 中英词条 |

---

## 11. 取舍与风险

| 决策 | 选择 | 理由 |
|---|---|---|
| 调度语法 | v1 三种类型（daily/interval/once），不做 cron 表达式 | 覆盖 95% 场景；cron 学习成本高、UI 难做 |
| 应用关闭时到点 | **不执行、不补跑** | 进程内调度的天然边界；系统级驻留（开机自启 + 托盘常驻）是独立需求 |
| Soul 处理 | 任务 services 不注册 soulExtension | 扩展不注册即不存在，零剔除逻辑 |
| Memory 区块（未来） | 任务默认**也不带** `<user_memory>` | 执行器不需要用户记忆；如某任务需要（如"给李健的天气播报"要知道李健偏好），v2 给任务加 `useMemory: true` 开关 |
| 任务会话的模型 | 跟随全局 defaultModel | v2 可给任务配独立模型（如便宜快的小模型跑巡检） |
| 并发 | 同一任务防重入跳过；不同任务允许并行 | 独立 session 天然隔离；LM Studio 单模型串行时 SDK 自己排队 |
| 会话归属 | v1 任务 cwd 锁定当前工作区 | `listSessions` 是 per-cwd 的（§6 注意事项）；v2 用 `listAll` 做全局呈现 |

---

## 12. 验证清单

1. 创建 daily 任务（时间设为 2 分钟后）→ 到点自动执行，侧栏出现「定时任务 → 任务名 → 会话」，点击可查看完整对话。
2. 让模型复述系统提示词末尾 → 应为 `<scheduled_task>` 区块，**且全文无 `<personality>`**（Soul 已去除）。
3. 任务执行期间用户正常聊天 → 主会话不受影响（消息不串、流式不断）。
4. 「立即执行」按钮 → 秒级触发一次，run 记录 status 正确流转 running→success。
5. 任务 prompt 写 `{time}` 占位符 → 执行会话里被替换为实际时间。
6. 删除定时会话 → runs 记录同步清理，侧栏分组计数正确；删除任务 → 分组消失。
7. once 类型执行一次后 → enabled 自动置 false，重启应用不重跑。
8. 应用重启 → runs/tasks 从磁盘恢复，历史分组完整。

---

## 13. 与既有功能的关系

- **Soul（已上线）**：主会话继续带 `<personality>`；定时会话不带。两者互不影响（不同 services、不同 extension 集合）。
- **Memory（docs/agent-memory.md，未开发）**：若先做 Memory，`memory-extension` 同样只注册进主会话 services；定时任务默认不带（见 §11）。
- **多人格/情绪层（docs/soul-multi-persona.md / soul-emotion-layer.md）**：正交，不冲突。
