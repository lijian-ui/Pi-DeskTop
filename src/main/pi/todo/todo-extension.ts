/**
 * Pi inline extension: registers the `todo` tool.
 *
 * Same first-party inline mechanism as webSearchExtension / createSubagent
 * extension — a permanent part of the app (NOT an installable package). The
 * tool lets the model maintain a live execution checklist whose full snapshot
 * is embedded in each tool result's `details` and therefore persisted with the
 * conversation (.jsonl) — state is rebuilt by replaying the branch
 * (last-write-wins), so no in-memory store and no lifecycle hooks are needed.
 *
 * Design constraints (mirroring web-search-extension.ts):
 *  - The `promptSnippet`/`promptGuidelines` below are STATIC (they land in the
 *    tool list section of the system prompt, which Pi rebuilds only when the
 *    tool set changes). NO `before_agent_start` rewrite — that would mutate
 *    the per-turn prefix and bust the prompt cache on every call.
 *  - Master switch: `todo-config.json` `enabled` (default ON). When off, the
 *    tool is not registered at all so the model never calls a doomed tool. A
 *    runtime guard in execute() still re-reads the config so a change applies
 *    without a reload.
 */
import { Type } from "typebox";
import {
  defineTool,
  type AgentToolResult,
  type InlineExtension,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { readTodoConfigSync } from "./todo-config";
import {
  applyTodoMutation,
  emptyTodoState,
  MAX_TODO_TEXT,
  MAX_TODOS,
  replayTodoFromEntries,
  type TodoOp,
  type TodoSnapshot,
} from "./todo-state";

function textContent(text: string): TextContentLike[] {
  return [{ type: "text", text }];
}

// Structural alias — avoids importing TextContent from the nested
// @earendil-works/pi-ai package (not hoisted to the project root).
type TextContentLike = { type: "text"; text: string };

/** Tool params per the doc (docs/todo-extension.md §3.1). Ids are accepted as
 * numbers or numeric strings — models occasionally emit either. */
const todoParams = Type.Object(
  {
    action: Type.Union([
      Type.Literal("create"),
      Type.Literal("update"),
      Type.Literal("delete"),
      Type.Literal("clear"),
    ]),
    tasks: Type.Optional(
      Type.Array(Type.String({ maxLength: MAX_TODO_TEXT }), { maxItems: MAX_TODOS }),
    ),
    id: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    content: Type.Optional(Type.String({ maxLength: MAX_TODO_TEXT })),
    status: Type.Optional(
      Type.Union([
        Type.Literal("pending"),
        Type.Literal("in_progress"),
        Type.Literal("completed"),
      ]),
    ),
    blockedBy: Type.Optional(
      Type.Array(Type.Union([Type.String(), Type.Number()]), { maxItems: MAX_TODOS }),
    ),
  },
  { additionalProperties: false },
);

/** Normalize a schema-level id (`number | string`) to a number, or NaN. */
function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return Number.NaN;
}

function formatTasks(snapshot: TodoSnapshot): string {
  const live = snapshot.tasks.filter((t) => t.status !== "deleted");
  if (live.length === 0) return "（清单为空）";
  return live
    .map((t) => {
      const dep = t.blockedBy?.length ? `  ↳ 依赖 #${t.blockedBy.join(",#")}` : "";
      return `#${t.id} [${t.status}] ${t.content}${dep}`;
    })
    .join("\n");
}

function renderSummary(prev: TodoSnapshot, next: TodoSnapshot, op: TodoOp): string {
  if (op.kind === "error") {
    const total = prev.tasks.filter((t) => t.status !== "deleted").length;
    return `✗ ${op.message}（当前 ${total} 项）\n${formatTasks(prev)}`;
  }
  const live = next.tasks.filter((t) => t.status !== "deleted");
  const done = live.filter((t) => t.status === "completed").length;
  const head =
    op.kind === "create"
      ? `✓ 已创建 ${op.ids.length} 项（#${op.ids.join(",#")}）`
      : op.kind === "update"
        ? op.changed
          ? `✓ #${op.id} 已更新（${op.fromStatus} → ${op.toStatus}）`
          : `#${op.id} 无变化（已是 ${op.toStatus}）`
        : op.kind === "delete"
          ? `✓ #${op.id} 已删除`
          : `✓ 已清空清单（${op.count} 项）`;
  const body = op.kind === "clear" ? "" : `\n${formatTasks(next)}`;
  return `${head}（待办 ${live.length} 项，已完成 ${done}）${body}`;
}

export const todoExtension: InlineExtension = {
  name: "todo",
  factory: (pi) => {
    if (!readTodoConfigSync().enabled) return; // master switch off → no tool

    pi.registerTool(
      defineTool({
        name: "todo",
        label: "任务清单",
        description:
          "维护当前会话的执行任务清单：把多步工作拆成若干任务，随执行推进同步更新状态。" +
          "状态流转：pending（待办）→ in_progress（进行中）→ completed（已完成），可回退；delete 移除任务。" +
          "任务可声明 blockedBy 依赖（等某任务完成后再开始）。",
        promptSnippet:
          "Maintain a live task checklist for multi-step work: create items up front, update their status as you go.",
        promptGuidelines: [
          "需要 3 步以上的工作，先调用 todo create 建立完整清单，再逐步执行并同步更新状态；不要攒到最后一次更新。",
          "每完成一步立即把对应任务 update 到 completed；开始处理某任务前先 update 到 in_progress。",
          "依赖表达用 blockedBy 的 id 数组（如 [#2, #3]）；一次 update 改一个任务。",
        ],
        parameters: todoParams,
        execute: async (
          _id,
          params,
          _signal,
          _onUpdate,
          ctx,
        ): Promise<AgentToolResult<TodoSnapshot>> => {
          if (!readTodoConfigSync().enabled) {
            return {
              content: textContent("todo 工具当前未启用（todo-config.json enabled=false）。"),
              details: emptyTodoState(),
            };
          }

          const entries: readonly SessionEntry[] = ctx.sessionManager.getBranch();
          const prev = replayTodoFromEntries(entries) ?? emptyTodoState();

          // Normalize schema params → pure mutation (numbers resolved here so
          // todo-state.ts stays SDK-free).
          const action = params.action as "create" | "update" | "delete" | "clear";
          let mutation:
            | { action: "create"; tasks: string[] }
            | { action: "update"; id: number; content?: string; status?: "pending" | "in_progress" | "completed"; blockedBy?: number[] }
            | { action: "delete"; id: number }
            | { action: "clear" };

          if (action === "create") {
            mutation = { action, tasks: Array.isArray(params.tasks) ? (params.tasks as string[]) : [] };
          } else if (action === "clear") {
            mutation = { action };
          } else {
            const id = toNum(params.id);
            if (!Number.isInteger(id) || id < 1) {
              return {
                content: textContent(`✗ id 必须是正整数（收到：${JSON.stringify(params.id)}）\n${formatTasks(prev)}`),
                details: prev,
              };
            }
            if (action === "delete") {
              mutation = { action, id };
            } else {
              const status =
                params.status === "pending" ||
                params.status === "in_progress" ||
                params.status === "completed"
                  ? params.status
                  : undefined;
              const blockedBy = Array.isArray(params.blockedBy)
                ? params.blockedBy.map(toNum).filter((n) => Number.isInteger(n) && n >= 1)
                : undefined;
              mutation = {
                action: "update",
                id,
                ...(params.content !== undefined ? { content: params.content } : {}),
                ...(status !== undefined ? { status } : {}),
                ...(blockedBy !== undefined ? { blockedBy } : {}),
              };
            }
          }

          const result = applyTodoMutation(prev, mutation);
          return {
            content: textContent(renderSummary(prev, result.state, result.op)),
            // Full snapshot rides in details → persisted with the .jsonl and
            // served to the renderer via pi:getTodoSnapshot. On error the
            // state is unchanged (reducer guarantee) and prev is returned.
            details: result.state,
          };
        },
      }),
    );
  },
};
