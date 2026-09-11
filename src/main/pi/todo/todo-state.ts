/**
 * Todo checklist — pure state: types, reducer, blockedBy graph validation,
 * and snapshot replay.
 *
 * The reducer / cycle-detection design is adapted from `@juicesharp/rpiv-todo`
 * (MIT, https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo),
 * deliberately simplified to this project's needs: tasks carry a single
 * `content` line (no subject/description/owner/metadata), `create` is batch,
 * `blockedBy` is whole-list replace on `update`. All functions here are pure —
 * zero I/O, no SDK imports — so the tool extension and the IPC snapshot
 * reader share them without coupling.
 *
 * Task/snapshot shapes live in src/shared/todo-types.ts (shared with the
 * preload API and the renderer) and are re-exported here for convenience.
 */
import type { TodoLiveStatus, TodoSnapshot, TodoStatus, TodoTask } from "../../../shared/todo-types";

export type { TodoLiveStatus, TodoSnapshot, TodoStatus, TodoTask } from "../../../shared/todo-types";

export const MAX_TODOS = 20;
export const MAX_TODO_TEXT = 120;

/** Normalized mutation (params already coerced to numbers by the caller). */
export type TodoMutation =
  | { action: "create"; tasks: string[] }
  | { action: "update"; id: number; content?: string; status?: TodoLiveStatus; blockedBy?: number[] }
  | { action: "delete"; id: number }
  | { action: "clear" };

/** Reducer outcome — mirrors rpiv's closed Op union but slimmer. `error`
 * keeps the state unchanged so a rejected mutation never corrupts the list. */
export type TodoOp =
  | { kind: "error"; message: string }
  | { kind: "create"; ids: number[] }
  | { kind: "update"; id: number; fromStatus: TodoStatus; toStatus: TodoStatus; changed: boolean }
  | { kind: "delete"; id: number }
  | { kind: "clear"; count: number };

export interface TodoApplyResult {
  state: TodoSnapshot;
  op: TodoOp;
}

export function emptyTodoState(): TodoSnapshot {
  return { tasks: [], nextId: 1 };
}

function errorResult(state: TodoSnapshot, message: string): TodoApplyResult {
  return { state, op: { kind: "error", message } };
}

/** Allowed status transitions. `deleted` is terminal (no outgoing edges);
 * live statuses may move freely between one another (a task can be reopened). */
const TRANSITIONS: Record<TodoStatus, ReadonlySet<TodoStatus>> = {
  pending: new Set(["in_progress", "completed"]),
  in_progress: new Set(["pending", "completed"]),
  completed: new Set(["pending", "in_progress"]),
  deleted: new Set(),
};

export function isTransitionValid(from: TodoStatus, to: TodoStatus): boolean {
  return TRANSITIONS[from].has(to);
}

/**
 * Would merging `newBlockedBy` into `taskId`'s blockedBy set introduce a cycle?
 * Pure DFS over the blockedBy graph (blockedBy = "must wait for"). Cycle is
 * present when following dependencies from a node reaches a node still on the
 * DFS visiting stack. Adapted from rpiv-todo `detectCycle` (MIT).
 */
export function detectCycle(
  taskList: readonly TodoTask[],
  taskId: number,
  newBlockedBy: readonly number[],
): boolean {
  const edges = new Map<number, number[]>();
  for (const t of taskList) {
    if (t.id === taskId) {
      const merged = new Set([...(t.blockedBy ?? []), ...newBlockedBy]);
      edges.set(t.id, [...merged]);
    } else {
      edges.set(t.id, t.blockedBy ? [...t.blockedBy] : []);
    }
  }

  const visiting = new Set<number>();
  const visited = new Set<number>();
  const hasCycleFrom = (node: number): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const nb of edges.get(node) ?? []) {
      if (hasCycleFrom(nb)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };

  for (const node of edges.keys()) {
    if (hasCycleFrom(node)) return true;
  }
  return false;
}

/** Shared blockedBy validation: every referenced id must exist and not be a
 * deleted tombstone. Returns an error message, or null when valid. */
function blockedByProblem(state: TodoSnapshot, blockedBy: readonly number[]): string | null {
  for (const dep of blockedBy) {
    const depTask = state.tasks.find((t) => t.id === dep);
    if (!depTask) return `blockedBy 引用了不存在的任务 #${dep}`;
    if (depTask.status === "deleted") return `blockedBy 引用的任务 #${dep} 已删除`;
  }
  return null;
}

function trimContent(content: string): string {
  return content.trim().slice(0, MAX_TODO_TEXT);
}

/**
 * Pure reducer: (state, mutation) → (state, op). Every failure path returns
 * the SAME state plus an `error` op — the caller surfaces the message to the
 * model in-band (no exception, no conversation break).
 */
export function applyTodoMutation(state: TodoSnapshot, mutation: TodoMutation): TodoApplyResult {
  switch (mutation.action) {
    case "create": {
      const subjects = mutation.tasks
        .map((s) => s?.trim?.() ?? "")
        .filter((s) => s.length > 0)
        .map((s) => s.slice(0, MAX_TODO_TEXT));
      if (subjects.length === 0) {
        return errorResult(state, "create 需要至少一条非空任务内容");
      }
      if (state.tasks.length + subjects.length > MAX_TODOS) {
        return errorResult(
          state,
          `任务数超出上限 ${MAX_TODOS}（当前 ${state.tasks.length} 项，本次新增 ${subjects.length} 项）；请先删除或完成部分任务`,
        );
      }
      let nextId = state.nextId;
      const newTasks: TodoTask[] = subjects.map((content, i) => ({
        id: nextId + i,
        content,
        status: "pending",
      }));
      nextId += subjects.length;
      const created: TodoTask[] = [...state.tasks, ...newTasks];
      return {
        state: { tasks: created, nextId },
        op: { kind: "create", ids: newTasks.map((t) => t.id) },
      };
    }

    case "update": {
      const idx = state.tasks.findIndex((t) => t.id === mutation.id);
      if (idx === -1) return errorResult(state, `#${mutation.id} 不存在`);
      const current = state.tasks[idx];
      if (current.status === "deleted") {
        return errorResult(state, `#${current.id} 已删除，不能更新`);
      }

      const hasMutation =
        mutation.content !== undefined ||
        mutation.status !== undefined ||
        mutation.blockedBy !== undefined;
      if (!hasMutation) {
        return errorResult(state, "update 至少需要一个可修改字段：content / status / blockedBy");
      }

      let newStatus = current.status;
      if (mutation.status !== undefined) {
        if (!isTransitionValid(current.status, mutation.status)) {
          return errorResult(
            state,
            `非法状态迁移：${current.status} → ${mutation.status}（deleted 状态不可恢复）`,
          );
        }
        newStatus = mutation.status;
      }

      let newBlockedBy: number[] | undefined;
      if (mutation.blockedBy !== undefined) {
        const dedup = [...new Set(mutation.blockedBy)];
        if (dedup.includes(current.id)) {
          return errorResult(state, `#${current.id} 不能依赖自己`);
        }
        const problem = blockedByProblem(state, dedup);
        if (problem) return errorResult(state, problem);
        if (detectCycle(state.tasks, current.id, dedup)) {
          return errorResult(state, `blockedBy 会形成循环依赖`);
        }
        newBlockedBy = dedup.length > 0 ? dedup : undefined;
      }

      const updated: TodoTask = { ...current, status: newStatus };
      if (mutation.content !== undefined) {
        const trimmed = trimContent(mutation.content);
        if (!trimmed) return errorResult(state, `任务内容不能为空`);
        updated.content = trimmed;
      }
      if (mutation.blockedBy !== undefined) {
        if (newBlockedBy) updated.blockedBy = newBlockedBy;
        else delete updated.blockedBy;
      }

      const changed =
        updated.content !== current.content ||
        updated.status !== current.status ||
        JSON.stringify(updated.blockedBy ?? null) !== JSON.stringify(current.blockedBy ?? null);

      const newTasks = [...state.tasks];
      newTasks[idx] = updated;
      return {
        state: { tasks: newTasks, nextId: state.nextId },
        op: { kind: "update", id: updated.id, fromStatus: current.status, toStatus: newStatus, changed },
      };
    }

    case "delete": {
      const idx = state.tasks.findIndex((t) => t.id === mutation.id);
      if (idx === -1) return errorResult(state, `#${mutation.id} 不存在`);
      const current = state.tasks[idx];
      if (current.status === "deleted") return errorResult(state, `#${current.id} 已删除`);
      const newTasks = [...state.tasks];
      newTasks[idx] = { ...current, status: "deleted" };
      return {
        state: { tasks: newTasks, nextId: state.nextId },
        op: { kind: "delete", id: current.id },
      };
    }

    case "clear": {
      return {
        state: emptyTodoState(),
        op: { kind: "clear", count: state.tasks.length },
      };
    }
  }
}

/* ── Snapshot replay (last-write-wins) ────────────────────────────────────
 *
 * The source of truth is the conversation itself: every successful `todo`
 * tool result carries the FULL snapshot in its `details`, which is persisted
 * with the session .jsonl. To rebuild state we walk the message entries and
 * take the LAST `todo` tool result — no separate storage, so it survives
 * /reload, compaction and app restarts by construction.
 *
 * Both callers feed this the same shape:
 *  - tool extension:  ctx.sessionManager.getBranch() → SessionEntry[]
 *  - IPC snapshot:    parsed rows of the session .jsonl (FileEntry[])
 *
 * A message entry is `{ type: "message", message: {...} }`; a tool result
 * message is a ToolResultMessage `{ role: "toolResult", toolName, details,
 * isError, ... }`. We duck-type against the minimal surface so this module
 * needs no nested SDK imports.
 */

/** Minimal structural view of a session entry — anything with an optional
 * `message` whose relevant fields we can read defensively. */
export interface TodoEntryLike {
  type?: unknown;
  message?: {
    role?: unknown;
    toolName?: unknown;
    details?: unknown;
    isError?: unknown;
  };
}

export function replayTodoFromEntries(entries: readonly TodoEntryLike[]): TodoSnapshot | null {
  let last: TodoSnapshot | null = null;
  for (const entry of entries) {
    if (!entry || entry.type !== "message") continue;
    const m = entry.message;
    if (!m || m.role !== "toolResult" || m.toolName !== "todo") continue;
    if (m.isError === true) continue;
    const snap = isTodoSnapshot(m.details) ? m.details : null;
    if (snap) last = snap;
  }
  return last;
}

export function isTodoSnapshot(value: unknown): value is TodoSnapshot {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.nextId === "number" &&
    Array.isArray(v.tasks) &&
    v.tasks.every(
      (t) =>
        !!t &&
        typeof t === "object" &&
        typeof (t as TodoTask).id === "number" &&
        typeof (t as TodoTask).content === "string" &&
        typeof (t as TodoTask).status === "string",
    )
  );
}
