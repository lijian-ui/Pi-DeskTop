import type {
  ScheduledTask,
  ScheduledTaskRun,
  TaskRuntimeState,
} from "../../preload/api";
import { LAST_DAY_OF_MONTH, normalizeWeekdays } from "../../shared/schedule";

export type TaskStatus = "running" | "success" | "error" | "never";

/** i18next's `t`, narrowed to what this module needs (key + interpolation). */
type TFn = (key: string, options?: Record<string, unknown>) => string;

/** Format an ISO timestamp for display, falling back to the raw string. */
function fmt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Latest run (by startedAt desc) for a given scheduled task. */
export function latestRunFor(
  runs: ScheduledTaskRun[],
  taskId: string,
): ScheduledTaskRun | undefined {
  let best: ScheduledTaskRun | undefined;
  for (const r of runs) {
    if (r.taskId !== taskId) continue;
    if (!best || r.startedAt > best.startedAt) best = r;
  }
  return best;
}

/** Coarse status of a task for the status dot: running > last finished > never. */
export function taskStatus(
  runs: ScheduledTaskRun[],
  taskId: string,
): TaskStatus {
  const latest = latestRunFor(runs, taskId);
  if (!latest) return "never";
  if (latest.status === "running") return "running";
  return latest.status;
}

/** "15 日" / "day 15" / "最后一天", depending on locale and sentinel. */
function dayLabel(day: number | null | undefined, t: TFn): string {
  if (day === LAST_DAY_OF_MONTH) return t("scheduled.lastDay");
  return t("scheduled.dayValue", { n: day ?? 1 });
}

/**
 * Human-readable schedule summary, e.g. "每天 09:00" / "每周一、三 09:00".
 *
 * Word order differs too much between locales to build by concatenation, so
 * each type has an interpolated template in the i18n bundle.
 */
export function scheduleText(task: ScheduledTask, t: TFn): string {
  const s = task.schedule;
  const time = s.time ?? "";

  switch (s.type) {
    case "daily":
      return t("scheduled.summary.daily", { time });

    case "interval":
      return t("scheduled.summary.interval", { n: s.everyMinutes ?? "?" });

    case "weekly": {
      const days = normalizeWeekdays(s.weekdays);
      const names = days.map((d) => t(`scheduled.weekdayShort.${d}`));
      return t("scheduled.summary.weekly", {
        days: names.join(t("scheduled.listSep")),
        time,
      });
    }

    case "monthly":
      return t("scheduled.summary.monthly", { day: dayLabel(s.monthDay, t), time });

    // A yearly date is a concrete calendar day, so it reads as a plain number
    // ("每年 3月15日" / "Yearly on March 15") rather than the "day N" phrasing
    // monthly needs to disambiguate from the last-day sentinel.
    case "yearly":
      return t("scheduled.summary.yearly", {
        month: t(`scheduled.monthName.${s.month ?? 1}`),
        n: s.monthDay ?? 1,
        time,
      });

    case "once": {
      const d = s.at ? new Date(s.at) : null;
      const txt = d && !isNaN(d.getTime()) ? d.toLocaleString() : s.at ?? "";
      return t("scheduled.summary.once", { at: txt });
    }

    default:
      return "";
  }
}

/** Build a fresh task template (used by the "new" button). */
export function createBlankTask(defaultCwd: string): ScheduledTask {
  return {
    id: crypto.randomUUID(),
    name: "",
    enabled: true,
    cwd: defaultCwd,
    prompt: "",
    rules: "",
    schedule: {
      type: "daily",
      time: "09:00",
      everyMinutes: 60,
      at: null,
      weekdays: null,
      monthDay: null,
      month: null,
    },
    createdAt: new Date().toISOString(),
    model: null,
    permissionMode: "yolo",
  };
}

/** One-line "last run" summary shown on a task card. */
export function lastRunText(
  latest: ScheduledTaskRun | undefined,
  t: TFn,
): string {
  if (!latest) return `${t("scheduled.lastRun")}: ${t("scheduled.never")}`;
  const when = fmt(latest.startedAt) ?? latest.startedAt;
  const label =
    latest.status === "running"
      ? t("scheduled.status.running")
      : latest.status === "success"
        ? t("scheduled.status.success")
        : t("scheduled.status.error");
  return `${t("scheduled.lastRun")}: ${when} · ${label}`;
}

/**
 * One-line "next run" summary. A disabled task is never armed, and a task the
 * scheduler hasn't evaluated yet (or a spent one-shot) has no next time.
 */
export function nextRunText(
  task: ScheduledTask,
  state: TaskRuntimeState | undefined,
  t: TFn,
): string {
  if (!task.enabled) return `${t("scheduled.nextRun")}: ${t("scheduled.notScheduled")}`;
  const when = fmt(state?.nextRunAt);
  return `${t("scheduled.nextRun")}: ${when ?? t("scheduled.pending")}`;
}

/**
 * Warning line for a window that elapsed while the app was closed. Cleared the
 * next time the task actually runs.
 */
export function missedText(
  state: TaskRuntimeState | undefined,
  t: TFn,
): string | null {
  const when = fmt(state?.missedAt);
  return when ? `${t("scheduled.missed")}: ${when}` : null;
}
