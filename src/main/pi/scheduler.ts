import {
  readScheduledTasks,
  saveScheduledTask,
  updateTaskState,
  recordTaskRun,
  type ScheduledTask,
} from "./scheduled-tasks";
import {
  computeNextRun,
  catchUpPolicy,
  emptyState,
  MISS_GRACE_MS,
  type TaskRuntimeState,
} from "../../shared/schedule";

const TICK_MS = 30_000; // 30s polling → minute-level precision is plenty
/** Evaluate soon after launch so a task that came due while the app was closed
 *  is judged right away, but late enough for the model runtime to settle. */
const FIRST_TICK_DELAY_MS = 3_000;

/**
 * In-process scheduler for scheduled tasks. Electron-process-local (NOT a
 * system-level scheduler): while the app is closed nothing fires — that
 * boundary is accepted (system-level residency would be a separate feature).
 * Each task runs in its own SDK session, fully isolated from the user's active
 * conversation.
 *
 * Scheduling works off a persisted `nextRunAt` rather than "does the current
 * minute match". That distinction matters:
 *  - a restart no longer replays a window (the old in-memory `lastFired` map
 *    was wiped on every launch, so interval tasks fired immediately on startup
 *    and a daily task could double-fire if the app restarted on its minute)
 *  - a window missed while the app was closed is detectable instead of
 *    silently vanishing, so a catch-up policy can be applied
 *  - the UI can show when the task will actually run next
 */
export class TaskScheduler {
  private timer: NodeJS.Timeout | null = null;
  private firstTimer: NodeJS.Timeout | null = null;
  /** Re-entrancy guard: a task that is still running is skipped, not stacked. */
  private runningTaskIds = new Set<string>();

  constructor(private runTask: (task: ScheduledTask) => Promise<void>) {}

  start(): void {
    this.stop();
    this.firstTimer = setTimeout(() => this.safeTick(), FIRST_TICK_DELAY_MS);
    this.timer = setInterval(() => this.safeTick(), TICK_MS);
    // Don't keep the app alive solely for the scheduler (matches the
    // contextFileWatchers convention).
    this.firstTimer.unref();
    this.timer.unref();
  }

  stop(): void {
    if (this.firstTimer) {
      clearTimeout(this.firstTimer);
      this.firstTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private safeTick(): void {
    this.tick().catch((err) => console.error("Scheduler tick failed:", err));
  }

  private async tick(): Promise<void> {
    const { tasks, states } = await readScheduledTasks();
    const now = Date.now();
    for (const task of tasks) {
      if (!task.enabled || this.runningTaskIds.has(task.id)) continue;
      try {
        await this.evaluate(task, states[task.id] ?? emptyState(task.id), now);
      } catch (err) {
        console.error(`Scheduler failed to evaluate "${task.name}":`, err);
      }
    }
  }

  /** Decide what happens to one task at this instant: arm, skip, or fire. */
  private async evaluate(
    task: ScheduledTask,
    state: TaskRuntimeState,
    now: number,
  ): Promise<void> {
    const lastRunMs = parseTime(state.lastRunAt);

    // Arm the task the first time we see it — either brand new, or the editor
    // invalidated nextRunAt because the schedule changed.
    let nextMs = parseTime(state.nextRunAt);
    if (nextMs == null) {
      const computed = computeNextRun(task.schedule, now, lastRunMs);
      if (computed == null) {
        // Unschedulable (malformed config). Leave it parked rather than
        // spinning on it every tick.
        if (state.nextRunAt !== null) await updateTaskState(task.id, { nextRunAt: null });
        return;
      }
      nextMs = computed;
      await updateTaskState(task.id, { nextRunAt: new Date(nextMs).toISOString() });
    }

    if (now < nextMs) return; // not due yet

    // Past due by more than the grace window means the app was closed or the
    // machine was asleep — this is a missed window, not ordinary lateness.
    if (now - nextMs > MISS_GRACE_MS && catchUpPolicy(task.schedule) === "skip") {
      const advanced = computeNextRun(task.schedule, now, lastRunMs);
      await updateTaskState(task.id, {
        missedAt: new Date(nextMs).toISOString(),
        nextRunAt: advanced == null ? null : new Date(advanced).toISOString(),
      });
      console.warn(
        `Scheduled task "${task.name}" missed its ${new Date(
          nextMs,
        ).toLocaleString()} window; skipped per catch-up policy.`,
      );
      return;
    }

    await this.fire(task, now);
  }

  private async fire(task: ScheduledTask, now: number): Promise<void> {
    const nowIso = new Date(now).toISOString();
    // A one-shot is spent; everything else advances relative to this run so a
    // long-running task doesn't immediately look due again.
    const nextMs =
      task.schedule.type === "once" ? null : computeNextRun(task.schedule, now, now);

    // Advance state BEFORE dispatching. If the app crashes mid-run, the next
    // launch must not replay the same window.
    await recordTaskRun(task.id, nowIso, nextMs == null ? null : new Date(nextMs).toISOString());

    // A "once" task is disabled the moment it fires so a restart can't replay
    // it. runScheduledTask defends this too, but flipping it here keeps the
    // file consistent even if the run later fails.
    if (task.schedule.type === "once" && task.enabled) {
      await saveScheduledTask({ ...task, enabled: false }).catch((err) =>
        console.error(`Failed to disable once-task "${task.name}":`, err),
      );
    }

    this.runExclusive(task);
  }

  /**
   * Dispatch a task through the same re-entrancy guard the tick loop uses, so a
   * manual "run now" can't stack on top of an in-flight scheduled run (and vice
   * versa). Returns false when a run is already in flight.
   *
   * A manual run deliberately does NOT touch the persisted state: it is a
   * one-off preview and must not shift the task's cadence.
   */
  runExclusive(task: ScheduledTask): boolean {
    if (this.runningTaskIds.has(task.id)) return false;
    this.runningTaskIds.add(task.id);
    this.runTask(task)
      .catch((err) => console.error(`Scheduled task "${task.name}" failed:`, err))
      .finally(() => this.runningTaskIds.delete(task.id));
    return true;
  }
}

function parseTime(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}
