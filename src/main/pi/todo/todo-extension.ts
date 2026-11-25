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
    ids: Type.Optional(
      Type.Array(Type.Union([Type.String(), Type.Number()]), { maxItems: MAX_TODOS }),
    ),
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
  if (live.length === 0) return "(checklist is empty)";
  return live
    .map((t) => {
      const dep = t.blockedBy?.length ? `  ↳ blocked by #${t.blockedBy.join(",#")}` : "";
      return `#${t.id} [${t.status}] ${t.content}${dep}`;
    })
    .join("\n");
}

function renderSummary(prev: TodoSnapshot, next: TodoSnapshot, op: TodoOp): string {
  if (op.kind === "error") {
    // 拒绝消息自带 "currently N, adding M"（active 口径）。括号统计若只给一个
    // 总数，会和 16+5=21 撞车被误读成假想值——这里拆成 active/completed 明细。
    const total = prev.tasks.filter((t) => t.status !== "deleted").length;
    const active = prev.tasks.filter((t) => t.status === "pending" || t.status === "in_progress").length;
    const done = prev.tasks.filter((t) => t.status === "completed").length;
    return `✗ ${op.message}\n(list now: ${total} item(s) = ${active} active + ${done} completed)\n${formatTasks(prev)}`;
  }
  const live = next.tasks.filter((t) => t.status !== "deleted");
  const done = live.filter((t) => t.status === "completed").length;
  const active = live.length - done;
  const head =
    op.kind === "create"
      ? `✓ Created ${op.ids.length} item(s) (#${op.ids.join(",#")})`
      : op.kind === "update"
        ? op.changed
          ? `✓ #${op.id} updated (${op.fromStatus} → ${op.toStatus})`
          : `#${op.id} unchanged (already ${op.toStatus})`
        : op.kind === "delete"
          ? // 批删：报删除明细 + 未命中明细；单删保持原格式。
            op.ids.length === 1 && op.missing.length === 0
            ? `✓ #${op.ids[0]} deleted`
            : `✓ Deleted ${op.ids.length} item(s) (#${op.ids.join(",#")})` +
              (op.missing.length > 0 ? `; not found: ${op.missing.map((n) => `#${n}`).join(", ")}` : "")
          : `✓ Cleared the checklist (${op.count} item(s))`;
  const body = op.kind === "clear" ? "" : `\n${formatTasks(next)}`;
  // 注意口径：active = 未完成任务数（pending/in_progress），不能标成 pending——
  // 实测报告曾抓到 "(8 pending, 5 completed)" 实为 3 pending + 5 completed。
  return `${head} (${active} active, ${done} completed)${body}`;
}

export const todoExtension: InlineExtension = {
  name: "todo",
  factory: (pi) => {
    if (!readTodoConfigSync().enabled) return; // master switch off → no tool

    // 进程内权威状态（按会话隔离）。回放式设计（从 session 分支重放最后一个
    // 快照）在「同一响应里并行发多个 todo 调用」时有竞态：每个 execute 都回放
    // 到同一个基线（看不到兄弟调用的结果），last-write-wins 会把兄弟的变更
    // 覆盖掉——实测导致「删除成功但条目复活」「nextId 回退」「容量计数虚高」。
    // 修复：工厂持有 Map<sessionId, TodoSnapshot>，execute 的读-改-写全同步，
    // JS 单线程天然串行；快照带 seq 只增，分支回放（压缩后可能缺失/回退）
    // 仅在 seq 更新时才覆盖内存态（跨重启 / 换分支兜底）。
    const stateBySession = new Map<string, TodoSnapshot>();

    const resolveAuthoritativeState = (
      sid: string,
      entries: readonly SessionEntry[],
    ): TodoSnapshot => {
      const replayed = replayTodoFromEntries(entries);
      const mem = stateBySession.get(sid);
      if (!mem) return replayed ?? emptyTodoState();
      if (replayed && (replayed.seq ?? 0) > (mem.seq ?? 0)) return replayed;
      return mem;
    };

    pi.registerTool(
      defineTool({
        name: "todo",
        label: "任务清单",
        description:
          "Maintain the execution checklist for the current session: split multi-step work into tasks and keep their status in sync as you progress. " +
          "Status flow: pending → in_progress → completed, and back; delete removes one task (id) or many at once (ids[]). " +
          "A task can declare blockedBy dependencies (start only after the named tasks complete).",
        promptSnippet:
          "Maintain a live task checklist for multi-step work: create items up front, update their status as you go.",
        promptGuidelines: [
          "For work needing 3+ steps, first call todo create to build the full checklist, then execute step by step and keep status updated; do not save all updates until the end.",
          "Immediately update the corresponding task to completed as soon as a step finishes; update to in_progress before starting a task.",
          // blockedBy 用法与"每次 update 改一个任务"已在 description（依赖语义）与参数 schema（单个 id）。
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
              content: textContent("The todo tool is currently disabled (todo-config.json enabled=false)."),
              details: emptyTodoState(),
            };
          }

          const entries: readonly SessionEntry[] = ctx.sessionManager.getBranch();
          const sid = ctx.sessionManager.getSessionId?.() ?? "";
          const prev = resolveAuthoritativeState(sid, entries);

          // Normalize schema params → pure mutation (numbers resolved here so
          // todo-state.ts stays SDK-free).
          const action = params.action as "create" | "update" | "delete" | "clear";
          let mutation:
            | { action: "create"; tasks: string[] }
            | { action: "update"; id: number; content?: string; status?: "pending" | "in_progress" | "completed"; blockedBy?: number[] }
            | { action: "delete"; ids: number[] }
            | { action: "clear" };

          if (action === "create") {
            const list = Array.isArray(params.tasks) ? (params.tasks as string[]) : [];
            // schema 里 content 就是任务文本字段——create 只传 content 视作单条任务，
            // 别让模型因为报错文案再来回试错一个回合。
            const single = typeof params.content === "string" ? params.content.trim() : "";
            mutation = { action, tasks: list.length > 0 ? list : single ? [single] : [] };
          } else if (action === "clear") {
            mutation = { action };
          } else if (action === "delete") {
            // 单删（id）或批删（ids[]）二选一；批删部分命中也生效（missing 明细回给模型）。
            const batchIds = Array.isArray(params.ids)
              ? (params.ids as Array<string | number>).map(toNum).filter((n) => Number.isInteger(n) && n >= 1)
              : [];
            const singleId = toNum(params.id);
            if (batchIds.length === 0 && (!Number.isInteger(singleId) || singleId < 1)) {
              return {
                content: textContent(`✗ delete needs id (single) or ids[] (batch)\n${formatTasks(prev)}`),
                details: prev,
              };
            }
            mutation = { action, ids: batchIds.length > 0 ? batchIds : [singleId] };
          } else {
            const id = toNum(params.id);
            if (!Number.isInteger(id) || id < 1) {
              return {
                content: textContent(`✗ id must be a positive integer (got: ${JSON.stringify(params.id)})\n${formatTasks(prev)}`),
                details: prev,
              };
            }
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

          const result = applyTodoMutation(prev, mutation);
          stateBySession.set(sid, result.state);
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

    // —— 结算兜底（Stop-hook 语义）——
    // 模型常在干完最后一步后直接写总结，清单永远停在 in_progress。提示词压不住
    // （见 promptGuidelines 已有同义要求），所以在 agent_before_settle 上做确定
    // 性拦截：清单还有非 completed 项时，注入一条 custom_message（会被转成
    // user 消息进下一次请求）并 continue: true，强制模型先把状态落定。
    // 每个用户 run 最多 nudge 一次（无条件 continue 会死循环，见 SDK 文档）。
    let nudgedThisRun = false;

    pi.on("before_agent_start", () => {
      // 只观察不改提示词（不碰 prompt 缓存）。新 run 开始 → 重新给一次机会；
      // nudge 触发的续跑不经过 before_agent_start，标记不会被误清。
      nudgedThisRun = false;
    });

    pi.on("agent_before_settle", (event, ctx) => {
      if (!readTodoConfigSync().enabled) return;
      if (event.outcome !== "completed" || nudgedThisRun) return;
      if (!event.context.canContinue) return;

      const snapshot = replayTodoFromEntries(ctx.sessionManager.getBranch());
      if (!snapshot) return;
      const open = snapshot.tasks.filter((t) => t.status !== "completed" && t.status !== "deleted");
      if (open.length === 0) return;

      nudgedThisRun = true;
      const list = open.map((t) => `#${t.id} [${t.status}] ${t.content}`).join("\n");
      return {
        entries: [
          ...event.entries,
          {
            type: "custom_message" as const,
            customType: "todo/settle-nudge",
            content:
              `Your task checklist still has ${open.length} item(s) not at a final state:\n${list}\n` +
              "Before finishing: update each one — completed if actually done; if not applicable now, " +
              "reopen as pending or delete. If an update errors, fix the call. Then give your final answer.",
            display: false,
          },
        ],
        continue: true,
      };
    });
  },
};
