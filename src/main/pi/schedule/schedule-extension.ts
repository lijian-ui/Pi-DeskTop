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
      Type.String({ description: "Local wall-clock time HH:mm; required for daily/weekly/monthly/yearly." }),
    ),
    everyMinutes: Type.Optional(
      Type.Number({ description: "interval: interval in minutes (≥1)." }),
    ),
    weekdays: Type.Optional(
      Type.Array(Type.Number(), {
        description: "weekly: day of week, 0=Sunday … 6=Saturday, multiple allowed.",
      }),
    ),
    monthDay: Type.Optional(
      Type.Number({ description: "monthly/yearly: day of month (1-31); -1 means the last day of the month." }),
    ),
    month: Type.Optional(Type.Number({ description: "yearly: month (1-12)." })),
    at: Type.Optional(
      Type.String({ description: "once: ISO timestamp string, must be later than the current time." }),
    ),
    catchUp: Type.Optional(
      Type.Union([Type.Literal("skip"), Type.Literal("once")], {
        description: "When a trigger window is missed: skip = skip (default), once = run once to catch up.",
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
    taskId: Type.Optional(Type.String({ description: "Required for update / delete / run." })),
    name: Type.Optional(Type.String({ maxLength: MAX_NAME })),
    prompt: Type.Optional(
      Type.String({
        maxLength: MAX_PROMPT,
        description: "The instruction this task runs when due. The scheduled session cannot see this conversation, so it must be self-contained.",
      }),
    ),
    cwd: Type.Optional(
      Type.String({ description: "Working directory for the task; if omitted, the current session directory is used." }),
    ),
    enabled: Type.Optional(Type.Boolean()),
    schedule: Type.Optional(scheduleShape),
  },
  { additionalProperties: false },
);

// ── Formatting ─────────────────────────────────────────────────────────────
const WEEKDAY_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** One-line English rendering of a schedule, for tool output. */
function describeSchedule(s: TaskSchedule): string {
  switch (s.type) {
    case "interval":
      return `every ${s.everyMinutes ?? 60} min`;
    case "daily":
      return `daily at ${s.time ?? "--:--"}`;
    case "weekly": {
      const days = normalizeWeekdays(s.weekdays);
      const label = days.length ? days.map((d) => WEEKDAY_EN[d] ?? String(d)).join("/") : "?";
      return `weekly on ${label} at ${s.time ?? "--:--"}`;
    }
    case "monthly": {
      const day = s.monthDay === LAST_DAY_OF_MONTH ? "the last day" : `day ${s.monthDay ?? 1}`;
      return `monthly on ${day} at ${s.time ?? "--:--"}`;
    }
    case "yearly":
      return `yearly on ${s.month ?? 1}/${s.monthDay ?? 1} at ${s.time ?? "--:--"}`;
    case "once":
      return `once at ${formatTime(s.at ? Date.parse(s.at) : null)}`;
    default:
      return String(s.type);
  }
}

function formatTime(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "(n/a)";
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
    return { error: "Missing schedule parameter (needs type plus the fields it requires)." };
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
        return { error: "interval requires everyMinutes ≥ 1." };
      }
      if (every > 10080) return { error: "interval everyMinutes must not exceed 10080 (one week)." };
      return { schedule: { ...base, everyMinutes: Math.floor(every) } };
    }
    case "once": {
      const at = typeof raw.at === "string" ? Date.parse(raw.at) : Number.NaN;
      if (Number.isNaN(at)) {
        return { error: "once requires a valid ISO time string at (e.g. 2026-10-01T09:00:00)." };
      }
      if (at <= Date.now()) {
        return {
          error: `once at must be later than the current time (got ${formatTime(at)}). To run immediately, just use a normal chat turn.`,
        };
      }
      return { schedule: { ...base, at: new Date(at).toISOString() } };
    }
    case "daily":
    case "weekly":
    case "monthly":
    case "yearly": {
      const time = validHhMm(raw.time);
      if (!time) return { error: `${type} requires a valid time (HH:mm, 24-hour).` };
      if (type === "weekly") {
        const days = normalizeWeekdays(raw.weekdays as number[] | null | undefined);
        if (days.length === 0) {
          return { error: "weekly requires weekdays (0=Sunday … 6=Saturday, multiple allowed)." };
        }
        return { schedule: { ...base, time, weekdays: days } };
      }
      if (type === "monthly") {
        const day = Number(raw.monthDay);
        const ok = day === LAST_DAY_OF_MONTH || (Number.isInteger(day) && day >= 1 && day <= 31);
        if (!ok) return { error: "monthly requires monthDay (1-31; -1 means the last day of the month)." };
        return { schedule: { ...base, time, monthDay: day } };
      }
      if (type === "yearly") {
        const month = Number(raw.month);
        const day = Number(raw.monthDay);
        if (!Number.isInteger(month) || month < 1 || month > 12) {
          return { error: "yearly requires month (1-12)." };
        }
        if (!Number.isInteger(day) || day < 1 || day > 31) {
          return { error: "yearly requires monthDay (1-31)." };
        }
        return { schedule: { ...base, time, month, monthDay: day } };
      }
      return { schedule: { ...base, time } };
    }
    default:
      return { error: `Unsupported type: ${JSON.stringify(type)}.` };
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
      ? "(already ran)"
      : formatTime(nextMs);
  const lines = [
    `- id: ${task.id}`,
    `  name: ${task.name}${task.enabled ? "" : " (paused)"}`,
    `  schedule: ${describeSchedule(task.schedule)}`,
    `  next run: ${next}`,
  ];
  if (lastMs) lines.push(`  last run: ${formatTime(lastMs)}`);
  if (task.cwd) lines.push(`  cwd: ${task.cwd}`);
  lines.push(`  prompt: ${truncate(task.prompt, 120)}`);
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
            "Create and manage scheduled tasks (in-app planned tasks that open an isolated session to run the given instruction when due). " +
            "Supported schedules: interval (every N minutes), daily (every day at HH:mm), weekly (given weekday at HH:mm), " +
            "monthly (given day of month at HH:mm), yearly (given month/day at HH:mm), once (single ISO timestamp). " +
            "action=create/list/update/delete/run; list returns the taskId required by update/delete/run.\n" +
            "Note: a scheduled task's prompt must be self-contained — the run cannot see this conversation; " +
            "tasks do not fire while the app is closed (in-process scheduling, not a system-level scheduler).",
          promptSnippet:
            "Create and manage scheduled tasks (interval / daily / weekly / monthly / yearly / once) that run a self-contained prompt later.",
          promptGuidelines: [
            "When the user asks for something like 'every day / weekly / on a schedule / remind me at a time / run automatically', create a task with schedule create; write clearly in prompt what to do when it fires, and it must be self-contained (the scheduled session cannot see this conversation's context).",
            "If the user has not specified the trigger time, do not guess for them — clarify first, then create.",
            "After creating/modifying, clearly tell the user the schedule and the next run time; before update or delete, first use list to get the taskId.",
            "Scheduled tasks do not fire while the app is closed (in-process scheduling); if this matters, tell the user honestly.",
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
                "The schedule tool is currently disabled (schedule-config.json enabled=false).",
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
              if (tasks.length === 0) return buildResult("No scheduled tasks yet.", true);
              const shown = tasks.slice(0, MAX_LISTED);
              const body = shown
                .map((t) => {
                  const st = states[t.id];
                  const lastMs = st?.lastRunAt ? Date.parse(st.lastRunAt) : null;
                  // The scheduler only persists nextRunAt on its next tick, so a
                  // task created seconds ago has none — preview it instead of
                  // reporting "(n/a)".
                  const nextMs = st?.nextRunAt
                    ? Date.parse(st.nextRunAt)
                    : computeNextRun(t.schedule, Date.now(), lastMs);
                  return renderTask(t, nextMs, lastMs);
                })
                .join("\n");
              const more =
                tasks.length > shown.length
                  ? `\n(${tasks.length} total, ${tasks.length - shown.length} omitted)`
                  : "";
              return buildResult(`${tasks.length} scheduled task(s):\n${body}${more}`, true);
            }

            // create
            if (p.action === "create") {
              const name = typeof p.name === "string" ? p.name.trim() : "";
              if (!name) return buildResult("create requires name (the task name).", false);
              const prompt = typeof p.prompt === "string" ? p.prompt.trim() : "";
              if (!prompt) {
                return buildResult(
                  "create requires prompt (the instruction to run when due; must be self-contained).",
                  false,
                );
              }
              const built = buildSchedule(p.schedule);
              if ("error" in built) return buildResult(`Invalid schedule: ${built.error}`, false);

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
                  ? "(interval tasks fire once within the next scheduling cycle)"
                  : "";
              return buildResult(
                `✓ Created scheduled task "${name}"\n- id: ${task.id}\n- schedule: ${describeSchedule(built.schedule)}\n- next run: ${formatTime(next)}${note}\n- cwd: ${cwd || "(default scheduled-task dir)"}\n- status: ${task.enabled ? "enabled" : "paused"}`,
                true,
              );
            }

            // update / delete / run all need an existing task
            const taskId = typeof p.taskId === "string" ? p.taskId.trim() : "";
            if (!taskId) {
              return buildResult(`${p.action} requires taskId (call action="list" first to get one).`, false);
            }
            const existing = tasks.find((t) => t.id === taskId);
            if (!existing) {
              return buildResult(`No scheduled task found with id ${taskId}.`, false);
            }

            if (p.action === "delete") {
              await deleteScheduledTask(taskId);
              return buildResult(`✓ Deleted scheduled task "${existing.name}" (${taskId}).`, true);
            }

            if (p.action === "run") {
              if (!deps.runNow) {
                return buildResult("Running a scheduled task immediately is not supported in this environment.", false);
              }
              try {
                await deps.runNow(taskId);
              } catch (err) {
                return buildResult(
                  `Failed to run immediately: ${err instanceof Error ? err.message : String(err)}`,
                  false,
                );
              }
              return buildResult(
                `✓ Triggered "${existing.name}"; it is running in the background (a manual run does not change the existing schedule cadence).`,
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
              if ("error" in built) return buildResult(`Invalid schedule: ${built.error}`, false);
              patch.schedule = built.schedule;
            }
            if (Object.keys(patch).length === 0) {
              return buildResult(
                "update received no fields to change (name / prompt / cwd / enabled / schedule).",
                false,
              );
            }
            const updated: ScheduledTask = { ...existing, ...patch };
            await saveScheduledTask(updated);
            const next = computeNextRun(updated.schedule, Date.now(), null);
            return buildResult(
              `✓ Updated scheduled task "${updated.name}"\n- id: ${updated.id}\n- schedule: ${describeSchedule(updated.schedule)}\n- next run: ${formatTime(next)}\n- status: ${updated.enabled ? "enabled" : "paused"}`,
              true,
            );
          },
        }),
      );
    },
  };
}