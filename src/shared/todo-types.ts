/**
 * Todo checklist — shared types (main process, preload API and renderer).
 *
 * The source of truth is the tool-result snapshot embedded in the session
 * .jsonl; see src/main/pi/todo/todo-state.ts for the pure reducer/replay logic
 * that reads and writes these shapes.
 */

/** Status of a todo item. `deleted` only appears in legacy snapshots: delete
 * now removes the task from the list entirely (no tombstone — tombstones used
 * to inflate the MAX_TODOS count and resurrect "deleted" items in replays). */
export type TodoStatus = "pending" | "in_progress" | "completed" | "deleted";

/** Live statuses the model may set (deleted is reducer-managed only). */
export type TodoLiveStatus = Exclude<TodoStatus, "deleted">;

export interface TodoTask {
  id: number;
  content: string;
  status: TodoStatus;
  /** Ids of tasks that must finish first. Order is preserved as given. */
  blockedBy?: number[];
}

/** Full snapshot — embedded in the tool result `details` (persistence) and
 * returned to the renderer over IPC (`pi:getTodoSnapshot`).
 *
 * `seq` is a monotonically increasing mutation counter used to defend the
 * in-memory authoritative state against a stale branch replay (compaction may
 * drop old tool results, forks may expose older branches): replayed snapshots
 * with a lower seq never overwrite a newer in-memory state. */
export interface TodoSnapshot {
  tasks: TodoTask[];
  nextId: number;
  seq?: number;
}
