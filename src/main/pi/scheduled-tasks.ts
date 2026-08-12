import { readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  emptyState,
  sameSchedule,
  type TaskRuntimeState,
  type TaskStateMap,
} from "../../shared/schedule";

// Schedule shapes live in src/shared so the renderer can run the exact same
// next-run computation; re-exported here to keep existing import sites working.
export type {
  ScheduleType,
  CatchUpPolicy,
  TaskSchedule,
  TaskRuntimeState,
  TaskStateMap,
} from "../../shared/schedule";

import type { TaskSchedule } from "../../shared/schedule";

export interface ScheduledTask {
  id: string;
  name: string;
  enabled: boolean;
  cwd: string;
  prompt: string;
  rules: string;
  schedule: TaskSchedule;
  createdAt: string;
  /**
   * Path to this task's single, accumulating session. Every execution appends
   * to the same file (see session-manager.runScheduledTask), so the sidebar can
   * open one conversation that holds the full run history. Null until the task
   * has run at least once.
   */
  sessionPath?: string | null;
  /**
   * Model the task runs with. Null ⇒ follow the global default model. Stored
   * as a provider/modelId pair so it survives restarts and is portable.
   */
  model?: { provider: string; modelId: string } | null;
  /**
   * Bash permission mode for this task. "yolo" auto-allows every command
   * (except the danger blacklist); "ask" blocks any non-whitelisted command
   * because a scheduled, unattended run has no user to approve a prompt.
   * Defaults to "yolo".
   */
  permissionMode?: "yolo" | "ask";
  /**
   * Optional IM channel instance id to PUSH the run result to after the task
   * completes (e.g. "8d1a..."). The message goes to the channel's most recent
   * active peer. Omit / empty ⇒ no push.
   */
  imPushInstanceId?: string;
}

export type RunStatus = "success" | "error" | "running";

export interface ScheduledTaskRun {
  /** Unique per run. Required because one session accumulates MANY runs that
   *  share the same sessionPath — sessionPath alone cannot identify a run. */
  id: string;
  taskId: string;
  sessionPath: string;
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
}

export interface ScheduledTasksData {
  tasks: ScheduledTask[];
  runs: ScheduledTaskRun[];
  /** Scheduler bookkeeping keyed by task id (lastRunAt / nextRunAt / …). */
  states: TaskStateMap;
}

// All scheduled-task config lives under ~/.pi/agent/scheduled/ so the agent
// root stays tidy. Sessions are kept separate (scheduled-sessions/, see
// session-manager) because they must never appear in the normal session list.
const SCHEDULED_DIR = join(getAgentDir(), "scheduled");
const TASKS_FILE = join(SCHEDULED_DIR, "scheduled-tasks.json");
const RUNS_FILE = join(SCHEDULED_DIR, "scheduled-runs.json");
const STATE_FILE = join(SCHEDULED_DIR, "scheduled-state.json");

// One-time migration: scheduled config originally lived directly under
// ~/.pi/agent. Move the three files into the dedicated `scheduled/` subdir so
// the agent root stays tidy. Idempotent and best-effort — safe to call often.
let migrated = false;
async function migrateLegacyScheduledFiles(): Promise<void> {
  if (migrated) return;
  migrated = true;
  const legacyDir = getAgentDir();
  const legacy: Array<[string, string]> = [
    ["scheduled-tasks.json", TASKS_FILE],
    ["scheduled-runs.json", RUNS_FILE],
    ["scheduled-state.json", STATE_FILE],
  ];
  await mkdir(SCHEDULED_DIR, { recursive: true });
  for (const [name, dest] of legacy) {
    const src = join(legacyDir, name);
    if (existsSync(src) && !existsSync(dest)) {
      try {
        await rename(src, dest);
      } catch {
        // Best-effort: leave the legacy file in place if rename fails.
      }
    }
  }
}

/**
 * Serialize every read/write through a single promise chain. A slow read must
 * never race a concurrent write and clobber the file — the same lesson learned
 * from the context-usage GC (concurrent read-modify-write on one file corrupts
 * it). Task frequency is low, so the lock is effectively free.
 */
let chain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  // Keep the chain alive but swallow errors so one failure doesn't poison it.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, path);
}

// ── Tasks ──
async function readTasks(): Promise<ScheduledTask[]> {
  const data = await readJson<{ tasks?: ScheduledTask[] }>(TASKS_FILE, { tasks: [] });
  return Array.isArray(data.tasks) ? data.tasks : [];
}

async function writeTasks(tasks: ScheduledTask[]): Promise<void> {
  await writeJson(TASKS_FILE, { tasks });
}

// ── Runs ──
async function readRuns(): Promise<ScheduledTaskRun[]> {
  const data = await readJson<{ runs?: ScheduledTaskRun[] }>(RUNS_FILE, { runs: [] });
  return Array.isArray(data.runs) ? data.runs : [];
}

async function writeRuns(runs: ScheduledTaskRun[]): Promise<void> {
  await writeJson(RUNS_FILE, { runs });
}

// ── Runtime state ──
// Kept in its own file on purpose: the editor rewrites the whole task list on
// save, and folding scheduler bookkeeping into the task object would let that
// write clobber a nextRunAt the scheduler had just advanced.
async function readStates(): Promise<TaskStateMap> {
  const data = await readJson<{ states?: TaskStateMap }>(STATE_FILE, { states: {} });
  return data.states && typeof data.states === "object" ? data.states : {};
}

async function writeStates(states: TaskStateMap): Promise<void> {
  await writeJson(STATE_FILE, { states });
}

/**
 * Read tasks + runs + scheduler state, with orphan GC: a run whose session file
 * no longer exists (the user deleted the session) is dropped, and state rows for
 * tasks that no longer exist are removed. Write-backs are idempotent so running
 * them under the lock is safe.
 */
export async function readScheduledTasks(): Promise<ScheduledTasksData> {
  return withLock(async () => {
    await migrateLegacyScheduledFiles();
    const tasks = await readTasks();
    const runs = await readRuns();
    const alive = runs.filter((r) => r.sessionPath && existsSync(r.sessionPath));
    if (alive.length !== runs.length) await writeRuns(alive);

    const states = await readStates();
    const ids = new Set(tasks.map((t) => t.id));
    let pruned = false;
    for (const id of Object.keys(states)) {
      if (!ids.has(id)) {
        delete states[id];
        pruned = true;
      }
    }
    if (pruned) await writeStates(states);

    return { tasks, runs: alive, states };
  });
}

/**
 * Upsert by id — mirrors the custom-model handler's lesson: never
 * blanket-replace.
 *
 * The persisted `nextRunAt` is invalidated (recomputed on the next tick) when:
 *  - the schedule changed — otherwise moving a daily task from 09:00 to 10:00
 *    would still fire at 09:00 until the next natural rollover;
 *  - the task was re-enabled — a paused task keeps a stale plan, and reviving it
 *    with a long-past nextRunAt would immediately read as a missed window.
 */
export async function saveScheduledTask(task: ScheduledTask): Promise<void> {
  return withLock(async () => {
    const tasks = await readTasks();
    const idx = tasks.findIndex((t) => t.id === task.id);
    const previous = idx >= 0 ? tasks[idx] : null;
    if (idx >= 0) tasks[idx] = task;
    else tasks.push(task);
    await writeTasks(tasks);

    if (!previous) return;
    const rescheduled = !sameSchedule(previous.schedule, task.schedule);
    const reEnabled = !previous.enabled && task.enabled;
    if (rescheduled || reEnabled) {
      const states = await readStates();
      const st = states[task.id];
      if (st?.nextRunAt || st?.missedAt) {
        states[task.id] = { ...st, nextRunAt: null, missedAt: null };
        await writeStates(states);
      }
    }
  });
}

/**
 * Stamp the path of a task's single accumulating session onto the task, so the
 * sidebar can open it. Separated from `saveScheduledTask` so first-run wiring
 * never trips the schedule-change / re-enable nextRunAt invalidation.
 */
export async function setTaskSessionPath(
  taskId: string,
  sessionPath: string,
): Promise<void> {
  return withLock(async () => {
    const tasks = await readTasks();
    const idx = tasks.findIndex((t) => t.id === taskId);
    if (idx < 0) return;
    if (tasks[idx].sessionPath === sessionPath) return;
    tasks[idx] = { ...tasks[idx], sessionPath };
    await writeTasks(tasks);
  });
}

export async function deleteScheduledTask(taskId: string): Promise<void> {
  return withLock(async () => {
    const tasks = await readTasks();
    const task = tasks.find((t) => t.id === taskId);
    // Best-effort removal of the task's single run session so it doesn't linger
    // orphaned in the dedicated scheduled-sessions directory.
    if (task?.sessionPath && existsSync(task.sessionPath)) {
      try {
        await unlink(task.sessionPath);
      } catch {
        /* non-fatal: the task is already gone from the index */
      }
    }
    await writeTasks(tasks.filter((t) => t.id !== taskId));
    const runs = await readRuns();
    await writeRuns(runs.filter((r) => r.taskId !== taskId));
    const states = await readStates();
    if (states[taskId]) {
      delete states[taskId];
      await writeStates(states);
    }
  });
}

/**
 * Fail any run still marked "running" at startup. A run can only be in flight
 * inside a live process, so anything still marked running was killed by a crash
 * or a force-quit — without this the sidebar status dot spins forever and the
 * task looks permanently busy. Returns how many rows were reconciled.
 */
export async function reconcileStaleRuns(): Promise<number> {
  return withLock(async () => {
    const runs = await readRuns();
    let changed = 0;
    for (const run of runs) {
      if (run.status === "running") {
        run.status = "error";
        run.finishedAt = run.finishedAt ?? new Date().toISOString();
        changed++;
      }
    }
    if (changed > 0) await writeRuns(runs);
    return changed;
  });
}

/** Patch a task's scheduler state, creating the row if it doesn't exist yet. */
export async function updateTaskState(
  taskId: string,
  patch: Partial<Omit<TaskRuntimeState, "taskId">>,
): Promise<void> {
  return withLock(async () => {
    const states = await readStates();
    states[taskId] = { ...(states[taskId] ?? emptyState(taskId)), ...patch, taskId };
    await writeStates(states);
  });
}

/**
 * Record a scheduler-driven run: stamps lastRunAt, advances nextRunAt, clears
 * the missed marker and increments the counter atomically (a plain patch can't
 * express the increment without a read-modify-write race).
 */
export async function recordTaskRun(
  taskId: string,
  lastRunAt: string,
  nextRunAt: string | null,
): Promise<void> {
  return withLock(async () => {
    const states = await readStates();
    const st = states[taskId] ?? emptyState(taskId);
    states[taskId] = {
      ...st,
      taskId,
      lastRunAt,
      nextRunAt,
      runCount: st.runCount + 1,
      missedAt: null,
    };
    await writeStates(states);
  });
}

export async function appendRun(run: ScheduledTaskRun): Promise<void> {
  return withLock(async () => {
    const runs = await readRuns();
    runs.push(run);
    await writeRuns(runs);
  });
}

export async function updateRun(
  id: string,
  patch: Partial<ScheduledTaskRun>,
): Promise<void> {
  return withLock(async () => {
    const runs = await readRuns();
    // Match by run id, NOT sessionPath: every execution of the same task
    // appends a new record that shares the task's sessionPath, so a
    // sessionPath lookup would patch the OLDEST record and leave the current
    // one stuck in "running" (the sidebar spinner would spin forever).
    const idx = runs.findIndex((r) => r.id === id);
    if (idx >= 0) {
      runs[idx] = { ...runs[idx], ...patch };
      await writeRuns(runs);
    }
  });
}

export async function deleteRun(sessionPath: string): Promise<void> {
  return withLock(async () => {
    const runs = await readRuns();
    const next = runs.filter((r) => r.sessionPath !== sessionPath);
    if (next.length !== runs.length) await writeRuns(next);
  });
}
