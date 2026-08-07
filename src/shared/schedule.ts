/**
 * Scheduling kernel shared by the main process and the renderer.
 *
 * The main process uses `computeNextRun` to decide when a task fires; the
 * renderer uses the same function to preview the next run. Keeping a single
 * implementation is deliberate — two copies of "when does this fire next"
 * logic will always drift apart.
 *
 * This module must stay dependency-free (no node:*, no DOM) so both sides can
 * import it.
 */

export type ScheduleType =
  | "interval"
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "once";

/** Sentinel for `monthDay`: the last day of whatever month it lands in, so
 *  "run on the last day of every month" works for 28/29/30/31-day months. */
export const LAST_DAY_OF_MONTH = -1;

/**
 * What to do when a fire window was missed because the app was closed or the
 * machine was asleep.
 *  - "skip": drop the missed window, jump to the next future one (default)
 *  - "once": run once on the next tick to catch up, then resume normally
 */
export type CatchUpPolicy = "skip" | "once";

export interface TaskSchedule {
  type: ScheduleType;
  /** Local "HH:mm" wall-clock time — used by daily / weekly / monthly / yearly. */
  time: string | null;
  /** interval: minutes between runs */
  everyMinutes: number | null;
  /** once: ISO datetime, fires once then auto-disables */
  at: string | null;
  /** weekly: days to fire on, 0 = Sunday … 6 = Saturday. Multiple allowed. */
  weekdays?: number[] | null;
  /** monthly / yearly: day of month 1..31, or LAST_DAY_OF_MONTH. */
  monthDay?: number | null;
  /** yearly: month 1..12. */
  month?: number | null;
  /** Missed-window behaviour. Absent = "skip" (a once-task always catches up). */
  catchUp?: CatchUpPolicy;
}

/**
 * Scheduler bookkeeping, persisted separately from the task itself.
 *
 * It deliberately does NOT live on `ScheduledTask`: the editor does a
 * read-modify-write of the task list when the user hits save, which would
 * clobber whatever the scheduler wrote a moment earlier.
 */
export interface TaskRuntimeState {
  taskId: string;
  /** ISO time of the most recent scheduler-driven run. */
  lastRunAt: string | null;
  /** ISO time of the next planned run; null = not scheduled / spent. */
  nextRunAt: string | null;
  /** How many times the scheduler fired this task (manual runs excluded). */
  runCount: number;
  /** Planned time of the most recent window that was skipped as missed. */
  missedAt: string | null;
}

export type TaskStateMap = Record<string, TaskRuntimeState>;

/**
 * A run counts as "missed" only when it is this far past due. The tick is 30s,
 * so two minutes of slack absorbs a slow tick or a busy event loop without
 * mistaking normal lateness for a missed window.
 */
export const MISS_GRACE_MS = 2 * 60_000;

export function emptyState(taskId: string): TaskRuntimeState {
  return {
    taskId,
    lastRunAt: null,
    nextRunAt: null,
    runCount: 0,
    missedAt: null,
  };
}

/** Effective catch-up policy: a one-shot task must always catch up, otherwise
 *  a task scheduled for last night would silently never run. */
export function catchUpPolicy(schedule: TaskSchedule): CatchUpPolicy {
  if (schedule.type === "once") return "once";
  return schedule.catchUp ?? "skip";
}

function parseHhMm(value: string | null | undefined): { h: number; m: number } | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

/** Sorted, de-duplicated, in-range weekday list (0 = Sunday). */
export function normalizeWeekdays(days: number[] | null | undefined): number[] {
  if (!Array.isArray(days)) return [];
  const seen = new Set<number>();
  for (const d of days) {
    const n = Math.trunc(Number(d));
    if (Number.isFinite(n) && n >= 0 && n <= 6) seen.add(n);
  }
  return [...seen].sort((x, y) => x - y);
}

/** Days in a calendar month. `month` may be out of 0..11 — it rolls over. */
function daysInMonth(year: number, month: number): number {
  // Day 0 of the following month is the last day of this one.
  return new Date(year, month + 1, 0).getDate();
}

/**
 * Resolve a requested day-of-month against a concrete month, or null when that
 * month simply has no such day (Feb 30, or Feb 29 outside a leap year). The
 * caller skips to the next candidate month rather than clamping, so "the 31st"
 * means the 31st and not "the end of February".
 */
function resolveMonthDay(
  year: number,
  month: number,
  day: number,
): number | null {
  const total = daysInMonth(year, month);
  if (day === LAST_DAY_OF_MONTH) return total;
  if (!Number.isFinite(day) || day < 1) return null;
  return day <= total ? Math.trunc(day) : null;
}

/** Two schedules are equivalent when every field that affects firing matches. */
export function sameSchedule(a: TaskSchedule, b: TaskSchedule): boolean {
  return (
    a.type === b.type &&
    a.time === b.time &&
    a.everyMinutes === b.everyMinutes &&
    a.at === b.at &&
    normalizeWeekdays(a.weekdays).join(",") ===
      normalizeWeekdays(b.weekdays).join(",") &&
    (a.monthDay ?? null) === (b.monthDay ?? null) &&
    (a.month ?? null) === (b.month ?? null) &&
    catchUpPolicy(a) === catchUpPolicy(b)
  );
}

/**
 * Next fire time in epoch ms, or null when the task will never fire again
 * (a spent one-shot, or an unparseable schedule).
 *
 * `lastRunMs === null` means the task has never run. An interval task then
 * fires immediately — this preserves the old behaviour where a freshly created
 * "every N minutes" task runs right away instead of idling for a full period.
 * Calendar-based types (daily/weekly/monthly/yearly) and one-shots still wait
 * for their configured moment.
 *
 * The returned time is strictly greater than `fromMs` except for:
 *  - a one-shot whose moment already passed (returns that original moment, so
 *    the caller can apply its catch-up policy rather than losing the task)
 *  - a never-run interval task (returns `fromMs` = fire now)
 */
export function computeNextRun(
  schedule: TaskSchedule,
  fromMs: number,
  lastRunMs: number | null,
): number | null {
  switch (schedule.type) {
    case "once": {
      const at = schedule.at ? Date.parse(schedule.at) : Number.NaN;
      return Number.isNaN(at) ? null : at;
    }

    case "daily": {
      const hm = parseHhMm(schedule.time);
      if (!hm) return null;
      const d = new Date(fromMs);
      d.setHours(hm.h, hm.m, 0, 0);
      if (d.getTime() <= fromMs) {
        // Advance by calendar day rather than +86_400_000 so a DST shift keeps
        // the wall-clock time the user asked for.
        d.setDate(d.getDate() + 1);
        d.setHours(hm.h, hm.m, 0, 0);
      }
      return d.getTime();
    }

    case "weekly": {
      const hm = parseHhMm(schedule.time);
      if (!hm) return null;
      const days = normalizeWeekdays(schedule.weekdays);
      if (days.length === 0) return null;
      // Walk forward a full week (plus today) and take the first matching slot.
      // Stepping by calendar day keeps the wall-clock time stable across DST.
      for (let i = 0; i <= 7; i++) {
        const d = new Date(fromMs);
        d.setDate(d.getDate() + i);
        d.setHours(hm.h, hm.m, 0, 0);
        if (d.getTime() > fromMs && days.includes(d.getDay())) return d.getTime();
      }
      return null;
    }

    case "monthly": {
      const hm = parseHhMm(schedule.time);
      if (!hm) return null;
      const day = schedule.monthDay ?? 1;
      const base = new Date(fromMs);
      const year = base.getFullYear();
      const month = base.getMonth();
      // 13 candidates covers a full year even when most months are skipped
      // (e.g. day 31 only exists in 7 months).
      for (let i = 0; i <= 13; i++) {
        const resolved = resolveMonthDay(year, month + i, day);
        if (resolved == null) continue;
        const d = new Date(year, month + i, resolved, hm.h, hm.m, 0, 0);
        if (d.getTime() > fromMs) return d.getTime();
      }
      return null;
    }

    case "yearly": {
      const hm = parseHhMm(schedule.time);
      if (!hm) return null;
      const monthIdx = Math.min(12, Math.max(1, schedule.month ?? 1)) - 1;
      const day = schedule.monthDay ?? 1;
      const baseYear = new Date(fromMs).getFullYear();
      // Feb 29 can be up to 8 years away across a non-leap century boundary.
      for (let i = 0; i <= 8; i++) {
        const year = baseYear + i;
        const resolved = resolveMonthDay(year, monthIdx, day);
        if (resolved == null) continue;
        const d = new Date(year, monthIdx, resolved, hm.h, hm.m, 0, 0);
        if (d.getTime() > fromMs) return d.getTime();
      }
      return null;
    }

    case "interval": {
      const every = Math.max(1, Math.floor(schedule.everyMinutes ?? 60));
      const stepMs = every * 60_000;
      if (lastRunMs == null) return fromMs; // never ran → fire on the next tick
      let next = lastRunMs + stepMs;
      if (next <= fromMs) {
        // Windows skipped while the app was closed collapse into one: jump to
        // the first aligned slot after `fromMs` instead of replaying each.
        const behind = Math.floor((fromMs - lastRunMs) / stepMs) + 1;
        next = lastRunMs + behind * stepMs;
      }
      return next;
    }

    default:
      return null;
  }
}
