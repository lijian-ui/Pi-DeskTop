/**
 * Todo checklist — shared types (main process, preload API and renderer).
 *
 * The source of truth is the tool-result snapshot embedded in the session
 * .jsonl; see src/main/pi/todo/todo-state.ts for the pure reducer/replay logic
 * that reads and writes these shapes.
 */

/** Status of a todo item. `deleted` is a tombstone: the item stays in the
 * list (so `blockedBy` references by other items keep resolving) but it is
 * not rendered and cannot transition to a live status again. */
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
 * returned to the renderer over IPC (`pi:getTodoSnapshot`). */
export interface TodoSnapshot {
  tasks: TodoTask[];
  nextId: number;
}
