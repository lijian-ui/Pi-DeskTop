/**
 * Pi inline extension: registers the `schedule` tool.
 *
 * Same first-party inline mechanism as todoExtension / createSendFileExtension —
 * a permanent part of the app (NOT an installable package). It gives the model
 * CRUD over the SAME scheduled tasks the 自动化 page manages: the tool is a thin
 * shell over `src/main/pi/scheduled-tasks.ts` (the persistence layer the UI also
 * uses), so a task created from chat shows up in the page and vice-versa.
 *
 * Design constraints (mirroring todo-extension.ts):
 *  - `promptSnippet`/`promptGuidelines` are STATIC — no `before_agent_start`
 *    rewrite, which would bust the prompt cache on every call.
 *  - Master switch: `schedule-config.json` `enabled` (default ON). When off the
 *    tool is not registered at all, so the model never calls a doomed tool. A
 *    runtime guard in execute() still re-reads the config.
 *  - Mounted ONLY in normal/workspace sessions — never in a scheduled-task
 *    session (that would let a task schedule more tasks).
 *
 * Deliberately NOT cron: this app's scheduler (src/shared/schedule.ts) speaks
 * interval / daily / weekly / monthly / yearly / once, not cron expressions.
 * The tool exposes exactly those shapes so results match what the UI previews.
 */
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import {
  defineTool,
  type AgentToolResult,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { readScheduleConfigSync } from "./schedule-config";
import {
  deleteScheduledTask,
  readScheduledTasks,
  saveScheduledTask,
  type ScheduledTask,
} from "../scheduled-tasks";
import {
  computeNextRun,
  LAST_DAY_OF_MONTH,
  normalizeWeekdays,
  type TaskSchedule,
} from "../../../shared/schedule";

type TextContentLike = { type: "text"; text: string };

function textContent(text: string): TextContentLike[] {
  return [{ type: "text", text }];
}

export interface ScheduleToolResult {
  ok: boolean;
  message: string;
}

function buildResult(text: string, ok: boolean): AgentToolResult<ScheduleToolResult> {
  return { content: textContent(text), details: { ok, message: text } };
}

// ── Limits ─────────────────────────────────────────────────────────────────
const MAX_NAME = 100;
const MAX_PROMPT = 8000;
/** Cap rendered task lists so a long list can't flood the context. */
const MAX_LISTED = 30;

// ── Schema ─────────────────────────────────────────────────────────────────
const scheduleShape = Type.Object(
  {
    type: Type.Union([
      Type.Literal("interval"),
      Type.Literal("daily"),
      Type.Literal("weekly"),
      Type.Literal("monthly"),
      Type.Literal("yearly"),
      Type.Literal("once"),
    ]),
    time: Type.Optional(
      Type.String({ description: "本地墙钟时间 HH:mm，daily/weekly/monthly/yearly 必填。" }),
    ),
    everyMinutes: Type.Optional(
      Type.Number({ description: "interval：间隔分钟数（≥1）。" }),
    ),
    weekdays: Type.Optional(
      Type.Array(Type.Number(), {
        description: "weekly：星期几，0=周日 … 6=周六，可多个。",
      }),
    ),
    monthDay: Type.Optional(
      Type.Number({ description: "monthly/yearly：几号（1-31），-1 表示当月最后一天。" }),
    ),
    month: Type.Optional(Type.Number({ description: "yearly：月份（1-12）。" })),
    at: Type.Optional(
      Type.String({ description: "once：ISO 时间字符串，必须晚于当前时间。" }),
    ),
    catchUp: Type.Optional(
      Type.Union([Type.Literal("skip"), Type.Literal("once")], {
        description: "错过触发窗口时：skip 跳过（默认），once 补跑一次。",
      }),
    ),
  },
  { additionalProperties: false },
);

const scheduleParams = Type.Object(
  {
    action: Type.Union([
      Type.Literal("create"),
      Type.Literal("list"),
      Type.Literal("update"),
      Type.Literal("delete"),
      Type.Literal("run"),
    ]),
    taskId: Type.Optional(Type.String({ description: "update / delete / run 必填。" })),
    name: Type.Optional(Type.String({ maxLength: MAX_NAME })),
    prompt: Type.Optional(
      Type.String({
        maxLength: MAX_PROMPT,
        description: "到点后该任务要执行的指令。定时会话看不到当前对话，必须自包含。",
      }),
    ),
    cwd: Type.Optional(
      Type.String({ description: "任务的工作目录；省略则用当前会话目录。" }),
    ),
    enabled: Type.Optional(Type.Boolean()),
    schedule: Type.Optional(scheduleShape),
  },
  { additionalProperties: false },
);

// ── Formatting ─────────────────────────────────────────────────────────────
const WEEKDAY_CN = ["日", "一", "二", "三", "四", "五", "六"];

/** One-line Chinese rendering of a schedule, for tool output. */
function describeSchedule(s: TaskSchedule): string {
  switch (s.type) {
    case "interval":
      return `每 ${s.everyMinutes ?? 60} 分钟`;
    case "daily":
      return `每天 ${s.time ?? "--:--"}`;
    case "weekly": {
      const days = normalizeWeekdays(s.weekdays);
      const label = days.length ? days.map((d) => WEEKDAY_CN[d] ?? d).join("/") : "?";
      return `每周${label} ${s.time ?? "--:--"}`;
    }
    case "monthly": {
      const day = s.monthDay === LAST_DAY_OF_MONTH ? "最后一天" : `${s.monthDay ?? 1} 号`;
      return `每月 ${day} ${s.time ?? "--:--"}`;
    }
    case "yearly":
      return `每年 ${s.month ?? 1} 月 ${s.monthDay ?? 1} 日 ${s.time ?? "--:--"}`;
    case "once":
      return `一次性 ${formatTime(s.at ? Date.parse(s.at) : null)}`;
    default:
      return String(s.type);
  }
}

function formatTime(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "（无法计算）";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function truncate(text: string, max = 100): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

// ── Validation ─────────────────────────────────────────────────────────────
const HHMM_RE = /^(\d{1,2}):(\d{2})$/;

function validHhMm(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = HHMM_RE.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** Turn the model's `schedule` object into a fully-populated TaskSchedule, or
 *  return a human-readable reason why it can't run. Populating every field
 *  (nulls included) keeps `sameSchedule` comparisons in the persistence layer
 *  meaningful. */
function buildSchedule(input: unknown): { schedule: TaskSchedule } | { error: string } {
  if (!input || typeof input !== "object") {
    return { error: "缺少 schedule 参数（需要 type 及对应的字段）。" };
  }
  const raw = input as Record<string, unknown>;
  const type = raw.type;
  const base: TaskSchedule = {
    type: type as TaskSchedule["type"],
    time: null,
    everyMinutes: null,
    at: null,
    weekdays: null,
    monthDay: null,
    month: null,
    ...(raw.catchUp === "once" || raw.catchUp === "skip" ? { catchUp: raw.catchUp } : {}),
  };

  switch (type) {
    case "interval": {
      const every = Number(raw.everyMinutes);
      if (!Number.isFinite(every) || every < 1) {
        return { error: "interval 需要 everyMinutes ≥ 1。" };
      }
      if (every > 10080) return { error: "interval 的 everyMinutes 不能超过 10080（一周）。" };
      return { schedule: { ...base, everyMinutes: Math.floor(every) } };
    }
    case "once": {
      const at = typeof raw.at === "string" ? Date.parse(raw.at) : Number.NaN;
      if (Number.isNaN(at)) {
        return { error: "once 需要合法的 ISO 时间字符串 at（如 2026-10-01T09:00:00）。" };
      }
      if (at <= Date.now()) {
        return {
          error: `once 的 at 必须晚于当前时间（收到 ${formatTime(at)}）。需要立即执行请直接用普通对话。`,
        };
      }
      return { schedule: { ...base, at: new Date(at).toISOString() } };
    }
    case "daily":
    case "weekly":
    case "monthly":
    case "yearly": {
      const time = validHhMm(raw.time);
      if (!time) return { error: `${type} 需要合法的 time（HH:mm，24 小时制）。` };
      if (type === "weekly") {
        const days = normalizeWeekdays(raw.weekdays as number[] | null | undefined);
        if (days.length === 0) {
          return { error: "weekly 需要 weekdays（0=周日 … 6=周六，可多个）。" };
        }
        return { schedule: { ...base, time, weekdays: days } };
      }
      if (type === "monthly") {
        const day = Number(raw.monthDay);
        const ok = day === LAST_DAY_OF_MONTH || (Number.isInteger(day) && day >= 1 && day <= 31);
        if (!ok) return { error: "monthly 需要 monthDay（1-31，-1 表示当月最后一天）。" };
        return { schedule: { ...base, time, monthDay: day } };
      }
      if (type === "yearly") {
        const month = Number(raw.month);
        const day = Number(raw.monthDay);
        if (!Number.isInteger(month) || month < 1 || month > 12) {
          return { error: "yearly 需要 month（1-12）。" };
        }
        if (!Number.isInteger(day) || day < 1 || day > 31) {
          return { error: "yearly 需要 monthDay（1-31）。" };
        }
        return { schedule: { ...base, time, month, monthDay: day } };
      }
      return { schedule: { ...base, time } };
    }
    default:
      return { error: `不支持的 type：${JSON.stringify(type)}。` };
  }
}

// ── Tool ───────────────────────────────────────────────────────────────────
function renderTask(
  task: ScheduledTask,
  nextMs: number | null,
  lastMs: number | null,
): string {
  const next =
    task.schedule.type === "once" && !task.enabled
      ? "（已执行完毕）"
      : formatTime(nextMs);
  const lines = [
    `- id: ${task.id}`,
    `  名称: ${task.name}${task.enabled ? "" : "（已暂停）"}`,
    `  计划: ${describeSchedule(task.schedule)}`,
    `  下次运行: ${next}`,
  ];
  if (lastMs) lines.push(`  上次运行: ${formatTime(lastMs)}`);
  if (task.cwd) lines.push(`  工作目录: ${task.cwd}`);
  lines.push(`  指令: ${truncate(task.prompt, 120)}`);
  return lines.join("\n");
}

export interface ScheduleExtensionDeps {
  /** Fire a task immediately (management-page "run now" path). Injected by
   *  PiSessionManager to avoid an extension → session-manager import cycle. */
  runNow?: (taskId: string) => Promise<void>;
}

export function createScheduleExtension(deps: ScheduleExtensionDeps = {}): InlineExtension {
  return {
    name: "schedule",
    factory: (pi) => {
      if (!readScheduleConfigSync().enabled) return; // master switch off → no tool

      pi.registerTool(
        defineTool({
          name: "schedule",
          label: "定时任务",
          description:
            "创建和管理定时任务（应用内的计划任务，到点后自动开一个隔离会话执行指定指令）。" +
            "支持的计划：interval（每 N 分钟）、daily（每天 HH:mm）、weekly（每周几 HH:mm）、" +
            "monthly（每月几号 HH:mm）、yearly（每年某月某日 HH:mm）、once（一次性 ISO 时间）。" +
            "action=create/list/update/delete/run；list 会给出 taskId，update/delete/run 需要它。\n" +
            "注意：定时任务的 prompt 必须自包含——到点执行时看不到当前对话；" +
            "应用关闭期间不会触发（进程内调度，不是系统级计划任务）。",
          promptSnippet:
            "Create and manage scheduled tasks (interval / daily / weekly / monthly / yearly / once) that run a self-contained prompt later.",
          promptGuidelines: [
            "用户提出「每天/每周/定时/到点提醒/自动执行」类需求时，用 schedule create 建任务；prompt 里写清到点后要做什么，必须自包含（定时会话看不到当前对话上下文）。",
            "用户没说清触发时间就不要替他猜——先问清楚再创建。",
            "创建/修改后，把「计划」和「下次运行时间」明确告诉用户；改或删之前先用 list 拿到 taskId。",
            "应用关闭期间定时任务不会触发（进程内调度）；如果需要这一点，要如实告知用户。",
          ],
          parameters: scheduleParams,
          execute: async (
            _toolCallId,
            params,
            _signal,
            _onUpdate,
            ctx,
          ): Promise<AgentToolResult<ScheduleToolResult>> => {
            if (!readScheduleConfigSync().enabled) {
              return buildResult(
                "schedule 工具当前未启用（schedule-config.json enabled=false）。",
                false,
              );
            }

            const p = params as unknown as {
              action: string;
              taskId?: string;
              name?: string;
              prompt?: string;
              cwd?: string;
              enabled?: boolean;
              schedule?: unknown;
            };
            const { tasks, states } = await readScheduledTasks();

            if (p.action === "list") {
              if (tasks.length === 0) return buildResult("当前没有任何定时任务。", true);
              const shown = tasks.slice(0, MAX_LISTED);
              const body = shown
                .map((t) => {
                  const st = states[t.id];
                  const lastMs = st?.lastRunAt ? Date.parse(st.lastRunAt) : null;
                  // The scheduler only persists nextRunAt on its next tick, so a
                  // task created seconds ago has none — preview it instead of
                  // reporting "无法计算".
                  const nextMs = st?.nextRunAt
                    ? Date.parse(st.nextRunAt)
                    : computeNextRun(t.schedule, Date.now(), lastMs);
                  return renderTask(t, nextMs, lastMs);
                })
                .join("\n");
              const more =
                tasks.length > shown.length
                  ? `\n（共 ${tasks.length} 个，已省略 ${tasks.length - shown.length} 个）`
                  : "";
              return buildResult(`共 ${tasks.length} 个定时任务：\n${body}${more}`, true);
            }

            // create
            if (p.action === "create") {
              const name = typeof p.name === "string" ? p.name.trim() : "";
              if (!name) return buildResult("create 需要 name（任务名称）。", false);
              const prompt = typeof p.prompt === "string" ? p.prompt.trim() : "";
              if (!prompt) {
                return buildResult(
                  "create 需要 prompt（到点后要执行的指令，必须自包含）。",
                  false,
                );
              }
              const built = buildSchedule(p.schedule);
              if ("error" in built) return buildResult(`计划无效：${built.error}`, false);

              const cwd =
                (typeof p.cwd === "string" && p.cwd.trim()) ||
                ((ctx as unknown as { cwd?: string }).cwd ?? "");
              const task: ScheduledTask = {
                id: randomUUID(),
                name,
                enabled: p.enabled !== false,
                cwd,
                prompt,
                rules: "",
                schedule: built.schedule,
                createdAt: new Date().toISOString(),
                model: null,
                permissionMode: "yolo",
              };
              await saveScheduledTask(task);
              const next = computeNextRun(built.schedule, Date.now(), null);
              const note =
                built.schedule.type === "interval"
                  ? "（interval 任务首次会在下一个调度周期内立即触发）"
                  : "";
              return buildResult(
                `✓ 已创建定时任务「${name}」\n- id: ${task.id}\n- 计划: ${describeSchedule(built.schedule)}\n- 下次运行: ${formatTime(next)}${note}\n- 工作目录: ${cwd || "（默认定时任务目录）"}\n- 状态: ${task.enabled ? "启用" : "已暂停"}`,
                true,
              );
            }

            // update / delete / run all need an existing task
            const taskId = typeof p.taskId === "string" ? p.taskId.trim() : "";
            if (!taskId) {
              return buildResult(`${p.action} 需要 taskId（可先 action="list" 获取）。`, false);
            }
            const existing = tasks.find((t) => t.id === taskId);
            if (!existing) {
              return buildResult(`找不到 id 为 ${taskId} 的定时任务。`, false);
            }

            if (p.action === "delete") {
              await deleteScheduledTask(taskId);
              return buildResult(`✓ 已删除定时任务「${existing.name}」（${taskId}）。`, true);
            }

            if (p.action === "run") {
              if (!deps.runNow) {
                return buildResult("当前环境不支持立即运行定时任务。", false);
              }
              try {
                await deps.runNow(taskId);
              } catch (err) {
                return buildResult(
                  `立即运行失败：${err instanceof Error ? err.message : String(err)}`,
                  false,
                );
              }
              return buildResult(
                `✓ 已触发「${existing.name}」，正在后台运行（本次手动运行不会改变原有计划节奏）。`,
                true,
              );
            }

            // update — merge only the fields the model actually supplied.
            const patch: Partial<ScheduledTask> = {};
            if (typeof p.name === "string" && p.name.trim()) patch.name = p.name.trim();
            if (typeof p.prompt === "string" && p.prompt.trim()) patch.prompt = p.prompt.trim();
            if (typeof p.cwd === "string" && p.cwd.trim()) patch.cwd = p.cwd.trim();
            if (typeof p.enabled === "boolean") patch.enabled = p.enabled;
            if (p.schedule !== undefined) {
              const built = buildSchedule(p.schedule);
              if ("error" in built) return buildResult(`计划无效：${built.error}`, false);
              patch.schedule = built.schedule;
            }
            if (Object.keys(patch).length === 0) {
              return buildResult(
                "update 没有收到任何要修改的字段（name / prompt / cwd / enabled / schedule）。",
                false,
              );
            }
            const updated: ScheduledTask = { ...existing, ...patch };
            await saveScheduledTask(updated);
            const next = computeNextRun(updated.schedule, Date.now(), null);
            return buildResult(
              `✓ 已更新定时任务「${updated.name}」\n- id: ${updated.id}\n- 计划: ${describeSchedule(updated.schedule)}\n- 下次运行: ${formatTime(next)}\n- 状态: ${updated.enabled ? "启用" : "已暂停"}`,
              true,
            );
          },
        }),
      );
    },
  };
}