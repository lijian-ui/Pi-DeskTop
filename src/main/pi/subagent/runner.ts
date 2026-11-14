import { randomUUID } from "node:crypto";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { getAgent, SubagentDef } from "./agent-discovery";
import { webSearchToolDefs } from "../web-search-extension";

/** One unit of work delegated to a subagent role. */
export interface SubagentTaskSpec {
  agent: string;
  task: string;
  /** Optional stable id so other tasks can declare `dependsOn: [thisId]` and
   *  form a DAG. When omitted, an implicit `t{index}` is assigned but cannot be
   *  referenced. */
  id?: string;
  /** Ids of other tasks that must finish (done) before this one starts. A task
   *  whose dependency errors/skips is itself marked skipped — no wasted work. */
  dependsOn?: string[];
  /** Per-task acceptance criteria; overrides the top-level `acceptance`. */
  acceptance?: string;
}

/** Parameters the model passes to the `subagent` tool. */
export interface SubagentParams {
  agent?: string;
  task?: string;
  /** Parallel / DAG fanout. Tasks may declare `dependsOn` to run after others. */
  tasks?: SubagentTaskSpec[];
  /** Sequential chain: each step depends on the previous one and receives its
   *  output. Internally normalized into a linear dependency DAG. */
  chain?: { agent: string; task: string; acceptance?: string }[];
  /**
   * Acceptance criteria applied to every launched task (a per-task
   * `acceptance` overrides it). Injected into the task text as a hard
   * requirement: the subagent must self-verify against each item before
   * delivery and confirm them item-by-item with evidence in its final reply.
   */
  acceptance?: string;
}

export type SubagentRunStatus =
  | "pending"
  | "running"
  | "done"
  | "error"
  | "skipped";

/** Cumulative resources consumed by one run (summed over the child session's
 *  assistant messages). `elapsedMs` is always known; token/cost fields are
 *  omitted when the transcript carried no usage data (e.g. the run died before
 *  the first model call). Mirrors the usage/cost shape consumed in
 *  src/main/pi/cache-stats.ts. */
export interface SubagentRunStats {
  elapsedMs: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}

/** Every event carries `sessionPath` (the PARENT session's file path) so the
 *  renderer can scope panels per session instead of leaking runs across
 *  concurrent sessions. Same field name as the Pi-Work extension's events —
 *  do not rename. */
export type SubagentEvent =
  | {
      type: "subagent_enqueue";
      sessionPath: string;
      runId: string;
      agent: string;
      /** Planned task text, truncated to 120 chars. */
      task?: string;
      dependsOn: string[];
      model?: string;
    }
  | { type: "subagent_start"; sessionPath: string; runId: string; agent: string; startedAt: number }
  | {
      type: "subagent_done";
      sessionPath: string;
      runId: string;
      agent: string;
      ok: boolean;
      stats: SubagentRunStats;
    }
  | {
      type: "subagent_error";
      sessionPath: string;
      runId: string;
      agent: string;
      error: string;
      stats: SubagentRunStats;
    }
  | { type: "subagent_skip"; sessionPath: string; runId: string; agent: string }
  | {
      type: "subagent_step";
      sessionPath: string;
      runId: string;
      agent: string;
      kind: "tool_call" | "tool_result";
      tool?: string;
      label?: string;
      detail?: string;
      isError?: boolean;
    };

const MAX_PARALLEL = 4;
// Recursion guard is structural: child sessions created in runOne() do NOT
// receive the subagent extension (we never register it on them), so they cannot
// spawn further subagents. A global depth counter is intentionally avoided —
// it would wrongly count concurrent sibling tool calls as nesting and reject
// them once the fan-out exceeds MAX_DEPTH.

// Live child sessions, keyed by runId, so the parent session's stop button can
// interrupt them. Each entry records the PARENT session's sessionPath so
// abortSubagents() can scope the cancellation to exactly the session the user
// stopped — never other concurrent sessions or scheduled tasks running their
// own subagents. We bind on sessionPath (not cwd): a chat session's cwd is ""
// while the renderer's stop button may pass a fallback path, so cwd matching is
// unreliable and would either skip every child or, if made loose, hit others.
const activeSessions = new Map<string, { session: any; parentPath: string }>();

/**
 * Interrupt running subagents so the parent session's stop button actually
 * halts them. Without this, a child AgentSession keeps running in its own
 * prompt() loop even after the parent session is aborted.
 *  - parentPath given → abort only the subagents owned by that parent session
 *  - no parentPath → abort every active subagent (defensive fallback; normal
 *    callers always pass the parent's sessionPath)
 */
export function abortSubagents(parentPath?: string): void {
  for (const [runId, entry] of activeSessions) {
    if (parentPath && entry.parentPath !== parentPath) continue;
    try {
      entry.session?.abort?.();
    } catch {
      /* best-effort; runOne's finally cleans the entry up */
    }
  }
}

function extractText(msg: unknown): string {
  const content = (msg as { content?: unknown[] })?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text ?? "")
    .join("\n")
    .trim();
}

function summarizeToolInput(tool: string | undefined, input: any): string {
  if (!input || typeof input !== "object") return tool ?? "";
  const pick =
    input.path ?? input.file_path ?? input.filePattern ?? input.pattern ??
    input.command ?? input.cmd ?? input.query ?? input.regex ?? input.expression;
  const s = pick != null ? String(pick) : JSON.stringify(input);
  return s.length > 120 ? s.slice(0, 117) + "…" : s;
}

function summarizeToolResult(content: any): string {
  if (!Array.isArray(content)) return "";
  const text = content
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text ?? "")
    .join("\n")
    .trim();
  if (!text) return "";
  return text.length > 160 ? text.slice(0, 157) + "…" : text;
}

/** Resolve the PARENT session's file path (fallback: its cwd). Tagged onto
 *  every event as `sessionPath` so the renderer scopes panels per session. */
function resolveSessionPath(ctx: any): string {
  return (ctx as any)?.sessionManager?.getSessionFile?.() ?? ctx?.cwd ?? "";
}

/** Event payload for the planned task text, capped at 120 chars. */
function truncateTask(t: string): string {
  return t.length > 120 ? t.slice(0, 117) + "…" : t;
}

/** Sum usage/cost over the child session's assistant messages. Tolerant of a
 *  missing/partial transcript: the result always carries `elapsedMs`, token
 *  and cost fields appear only when at least one usage/cost was recorded. */
function sumRunStats(msgs: unknown, startedAt: number): SubagentRunStats {
  const stats: SubagentRunStats = { elapsedMs: Math.max(0, Date.now() - startedAt) };
  for (const m of (Array.isArray(msgs) ? msgs : []) as any[]) {
    if (m?.role !== "assistant") continue;
    const u = m.usage;
    const c = m.cost;
    if (!u && !c) continue;
    stats.input = (stats.input ?? 0) + (u?.input ?? 0);
    stats.output = (stats.output ?? 0) + (u?.output ?? 0);
    stats.cacheRead = (stats.cacheRead ?? 0) + (u?.cacheRead ?? 0);
    stats.cacheWrite = (stats.cacheWrite ?? 0) + (u?.cacheWrite ?? 0);
    stats.cost = (stats.cost ?? 0) + (c?.total ?? 0);
  }
  return stats;
}

function okResult(text: string): any {
  return {
    content: [{ type: "text", text }],
    details: { isError: false },
  };
}

function errorResult(text: string): any {
  return {
    content: [{ type: "text", text }],
    details: { isError: true },
  };
}


/**
 * Run a single child agent in-process: create a fresh AgentSession with the
 * role's tool allowlist + thinking level, inject the role prompt, run the task,
 * and return the final assistant text.
 */
async function runOne(
  def: SubagentDef,
  task: string,
  ctx: any,
  sendEvent: (e: SubagentEvent) => void,
  runId: string,
  modelRuntime: any,
  sessionPath: string
): Promise<{ text: string; ok: boolean }> {
  // Resolve the role's optional model override (best-effort). Falls back to the
  // parent session's model when the override can't be resolved.
  let model = ctx.model;
  if (def.model && modelRuntime) {
    const parts = def.model.includes("/") ? def.model.split("/") : [undefined, def.model];
    const resolved = modelRuntime.getModel(parts[0] ?? "", parts[1] ?? def.model);
    if (resolved) model = resolved as any;
  }

  // A subagent child is an INTERNAL tool execution, NOT a first-class
  // conversation the user can open. Use an in-memory SessionManager so the SDK
  // never writes a persistent session file to disk: previously the child used
  // the parent's (bare-chat) cwd and produced a stray, persistent session under
  //   ~/.pi/agent/sessions/<encoded-bare-chat>/
  // which `listAll()` then leaked into the sidebar as a confusing extra
  // "session" appearing after every subagent run. In-memory keeps the run fully
  // isolated and disposable while still resolving the parent's tools/context
  // via `cwd` (workspace path in workspace mode, chat root in task mode).
  const childCwd = ctx.cwd || process.cwd();
  const { session } = await createAgentSession({
    cwd: childCwd,
    sessionManager: SessionManager.inMemory(childCwd),
    // Critical: reuse the SAME ModelRuntime the parent session uses, so the
    // child can resolve the configured provider + API key and actually call
    // the model. Without this the child builds a fresh default runtime that
    // has no credentials and fails with "no API key".
    modelRuntime: modelRuntime ?? undefined,
    model,
    thinkingLevel: (def.thinking as any) ?? ctx.thinkingLevel,
    // 只在角色显式声明 tools 白名单时才置空默认集再做 allowlist 限定。
    // 不能无条件传 noTools：SDK（sdk.js `defaultToolNames = options.noTools ? [] : …`）
    // 会把任何 noTools 都当作"默认工具集为空"，导致未写 tools: 的角色零工具，
    // 与 agent-discovery 注释的 "omitted => all built-ins" 相反。
    noTools: def.tools ? ("builtin" as const) : undefined,
    tools: def.tools ?? undefined,
    excludeTools: def.excludeTools.length ? def.excludeTools : undefined,
    // 角色白名单点名的 web 工具：父会话的 inline 扩展进不了子会话，
    // 把同源定义经 customTools 注入（配置门控，未启用时自然为空）。
    customTools: def.tools
      ? webSearchToolDefs().filter((t) => def.tools!.includes(t.name))
      : undefined,
  });

  // Bind this child to its PARENT session so a stop only kills this parent's
  // subagents, never siblings or scheduled tasks. The parent's sessionPath was
  // resolved once by runDag from the tool-execution context.
  activeSessions.set(runId, { session, parentPath: sessionPath });
  const startedAt = Date.now();
  sendEvent({ type: "subagent_start", sessionPath, runId, agent: def.name, startedAt });

  // Realtime path: hook the Agent's beforeToolCall/afterToolCall (the same
  // intercept points the SDK uses internally for extensions). We count whether
  // the hooks actually fire; if they never do (SDK internal quirk — the tool
  // loop reads `config.beforeToolCall`, which may differ from `session.agent`),
  // we fall back to reading tool_call/tool_result blocks from the transcript
  // after prompt() completes.
  let hookFired = 0;
  const origBefore = session.agent?.beforeToolCall;
  const origAfter = session.agent?.afterToolCall;
  if (session.agent) {
    session.agent.beforeToolCall = async (p: any) => {
      try {
        await origBefore?.(p);
      } catch {
        /* keep forwarding even if the original hook throws */
      }
      hookFired++;
      const toolName = p?.toolCall?.name ?? p?.toolName;
      sendEvent({
        type: "subagent_step",
        sessionPath,
        runId,
        agent: def.name,
        kind: "tool_call",
        tool: toolName,
        label: summarizeToolInput(toolName, p?.args ?? p?.input),
      });
      return undefined;
    };
    session.agent.afterToolCall = async (p: any) => {
      let res: any;
      try {
        res = await origAfter?.(p);
      } catch {
        /* keep forwarding even if the original hook throws */
      }
      hookFired++;
      const toolName = p?.toolCall?.name ?? p?.toolName;
      sendEvent({
        type: "subagent_step",
        sessionPath,
        runId,
        agent: def.name,
        kind: "tool_result",
        tool: toolName,
        isError: !!p?.isError,
        label: p?.isError ? "失败" : "完成",
        detail: summarizeToolResult(p?.result?.content),
      });
      return res;
    };
  }
  try {
    const full = def.body ? `${def.body}\n\n---\nTASK:\n${task}` : task;
    await session.prompt(full);
    const msgs = session.messages as unknown[];
    // Fallback: if the realtime hooks never fired, surface tool activity from the
    // final transcript. Tolerant of block-type naming variants.
    if (hookFired === 0) {
      const nameById = new Map<string, string>();
      for (const m of msgs as any[]) {
        const content = Array.isArray(m?.content) ? m.content : [];
        for (const b of content) {
          const t = b?.type;
          const isCall =
            t === "toolCall" || t === "tool_use" ||
            (typeof t === "string" && (t.includes("tool_call") || t.includes("tool_use")));
          const isRes =
            t === "tool_result" || t === "toolResult" ||
            (typeof t === "string" && (t.includes("tool_result") || t.includes("toolResult")));
          if (isCall) {
            if (b?.id) nameById.set(b.id, b?.name ?? b?.toolName);
            sendEvent({
              type: "subagent_step",
              sessionPath,
              runId,
              agent: def.name,
              kind: "tool_call",
              tool: b?.name ?? b?.toolName,
              label: summarizeToolInput(b?.name ?? b?.toolName, b?.input ?? b?.args),
            });
          } else if (isRes) {
            const name =
              (b?.toolCallId && nameById.get(b.toolCallId)) || b?.name || b?.toolName;
            sendEvent({
              type: "subagent_step",
              sessionPath,
              runId,
              agent: def.name,
              kind: "tool_result",
              tool: name,
              isError: !!b?.isError,
              label: b?.isError ? "失败" : "完成",
              detail: summarizeToolResult(b?.content),
            });
          }
        }
      }
    }

    const text = extractText(msgs[msgs.length - 1]);
    sendEvent({
      type: "subagent_done",
      sessionPath,
      runId,
      agent: def.name,
      ok: true,
      stats: sumRunStats(msgs, startedAt),
    });
    return { text, ok: true };
  } catch (err: any) {
    const aborted = (session as any)?.aborted === true;
    const msg = aborted ? "已被用户停止" : err?.message ?? String(err);
    // Partial usage: whatever the child recorded before dying, best-effort.
    let partial: unknown = [];
    try {
      partial = session.messages;
    } catch {
      /* transcript unavailable — stats degrades to elapsedMs only */
    }
    sendEvent({
      type: "subagent_error",
      sessionPath,
      runId,
      agent: def.name,
      error: msg,
      stats: sumRunStats(partial, startedAt),
    });
    return {
      text: aborted
        ? `(agent ${def.name} 已被用户停止)`
        : `(agent ${def.name} failed: ${msg})`,
      ok: false,
    };
  } finally {
    activeSessions.delete(runId);
    if (session.agent) {
      session.agent.beforeToolCall = origBefore;
      session.agent.afterToolCall = origAfter;
    }
  }
}

interface PlannedTask {
  index: number;
  runId: string;
  agent: string;
  task: string;
  dependsOn: string[]; // runIds that must be `done` before this starts
  isChainStep: boolean; // feeds the previous step's output forward
  acceptance?: string; // self-verify-against-each-item requirement (借鉴 dsh-agent-teams 验收合同)
}

/** 把验收标准包成任务级硬要求：交付前逐条自验、最终答复逐条带证据确认。 */
function withAcceptance(task: string, acceptance: string): string {
  return (
    `${task}\n\n<acceptance>\n验收标准（硬要求）：\n${acceptance}\n\n` +
    "交付前必须逐条自我验证，并在最终答复末尾以清单形式逐条确认：已满足的给出可核查证据（file:line / 命令与输出 / 测试结果）；" +
    "未满足或无法验证的必须如实说明，禁止未经验证就宣称完成。\n</acceptance>"
  );
}

function parentModelLabel(ctx: any): string | undefined {
  const m = ctx?.model;
  if (!m) return undefined;
  if (typeof m === "object") return (m as any).id ?? (m as any).name;
  return String(m);
}

/**
 * Dependency-aware scheduler. Every task is enqueued up-front so the renderer
 * can draw the whole DAG at once (pending nodes + edges). A bounded worker pool
 * launches *ready* tasks (all deps done) up to MAX_PARALLEL; a task whose
 * dependency errors/skips is itself marked skipped, cascading downstream so we
 * never run work that cannot succeed. Chain steps receive the prior step's
 * output as context. Resolves with the joined result of every non-skipped task.
 */
async function runDag(
  planned: PlannedTask[],
  ctx: any,
  onUpdate: ((partial: any) => void) | undefined,
  sendEvent: (e: SubagentEvent) => void,
  modelRuntime: any
): Promise<any> {
  const status = new Map<string, SubagentRunStatus>();
  const outputs = new Map<number, string>();
  const defs = new Map<number, SubagentDef | undefined>();
  const sessionPath = resolveSessionPath(ctx);
  for (const p of planned) {
    status.set(p.runId, "pending");
    defs.set(p.index, getAgent(ctx.cwd, p.agent));
  }

  // Surface the full plan so the panel can render nodes + edges immediately.
  for (const p of planned) {
    const def = defs.get(p.index);
    sendEvent({
      type: "subagent_enqueue",
      sessionPath,
      runId: p.runId,
      agent: p.agent,
      task: truncateTask(p.task),
      dependsOn: p.dependsOn,
      model: def?.model ?? parentModelLabel(ctx),
    });
  }

  let active = 0;
  let finished = 0;
  let resolveAll!: (res: any) => void;
  const done = new Promise<any>((r) => (resolveAll = r));

  const indexOfRunId = (runId: string): number =>
    planned.find((p) => p.runId === runId)?.index ?? -1;

  const markBlocked = () => {
    // Fixpoint: a skipped task force-skips its own dependents, which may in turn
    // skip theirs, so repeat until no new skip appears. Crucially, every skip
    // must count toward `finished` — otherwise the `done` promise below would
    // never resolve and runSubagent would hang.
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of planned) {
        if (status.get(p.runId) !== "pending") continue;
        const blocked = p.dependsOn.some(
          (d) => status.get(d) === "error" || status.get(d) === "skipped"
        );
        if (blocked) {
          status.set(p.runId, "skipped");
          sendEvent({ type: "subagent_skip", sessionPath, runId: p.runId, agent: p.agent });
          finished++;
          changed = true;
        }
      }
    }
  };

  const emitFinal = () => {
    const joined = planned
      .map((p) => {
        const st = status.get(p.runId);
        const out = outputs.get(p.index) ?? "";
        if (st === "skipped") return `[${p.agent}]\n(已跳过：上游依赖失败)`;
        // 失败必须把 runOne 捕获的真实错误带回主会话（outputs 里是
        // `(agent X failed: <msg>)`），否则模型和用户只能看到「(任务失败)」四字。
        if (st === "error") return `[${p.agent}]\n${out || "(任务失败)"}`;
        return `[${p.agent}]\n${out}`;
      })
      .join("\n\n---\n\n");
    onUpdate?.(okResult(joined));
    resolveAll(okResult(joined));
  };

  const tryLaunch = () => {
    while (active < MAX_PARALLEL) {
      const next = planned.find(
        (p) =>
          status.get(p.runId) === "pending" &&
          p.dependsOn.every((d) => status.get(d) === "done")
      );
      if (!next) break;
      status.set(next.runId, "running");
      active++;
      const def = defs.get(next.index)!;
      // 上游结果注入：chain 步骤与 DAG dependents 统一生效（此前只喂 chain）。
      // DAG 汇聚任务的价值正是拿到全部上游输出 —— 逐个带上游角色名拼接。
      const prevOut = next.dependsOn
        .map((d) => {
          const i = indexOfRunId(d);
          const t = i >= 0 ? outputs.get(i) ?? "" : "";
          return t ? `[${planned[i]?.agent ?? "upstream"}]\n${t}` : "";
        })
        .filter(Boolean)
        .join("\n\n---\n\n");
      let taskText = prevOut ? `${next.task}\n\nUpstream results:\n${prevOut}` : next.task;
      if (next.acceptance) taskText = withAcceptance(taskText, next.acceptance);
      runOne(def, taskText, ctx, sendEvent, next.runId, modelRuntime, sessionPath)
        .then(({ text, ok }) => {
          outputs.set(next.index, text);
          status.set(next.runId, ok ? "done" : "error");
        })
        .finally(() => {
          active--;
          finished++;
          markBlocked();
          tryLaunch();
          if (finished === planned.length) emitFinal();
        });
    }
  };

  tryLaunch();
  return done;
}

/**
 * Entry point invoked by the `subagent` tool. Normalizes the three call shapes
 * into a dependency DAG and hands it to runDag:
 *  - single:  { agent, task }
 *  - parallel:{ tasks: [{agent, task, id?, dependsOn?}, ...] }  (DAG fanout)
 *  - chain:   { chain: [{agent, task}, ...] }  (linear dependency chain)
 */
export async function runSubagent(
  params: SubagentParams,
  ctx: any,
  onUpdate: ((partial: any) => void) | undefined,
  sendEvent: (e: SubagentEvent) => void,
  modelRuntime: any
): Promise<any> {
  // Normalize into intermediate specs, then assign runIds + resolve deps.
  type Spec = {
    agent: string;
    task: string;
    id?: string;
    depKeys: string[];
    isChain: boolean;
    acceptance?: string;
  };
  const specs: Spec[] = [];
  const isChain = Array.isArray(params.chain) && params.chain.length > 0;
  const isTasks = Array.isArray(params.tasks) && params.tasks.length > 0;

  if (params.agent && params.task && !isTasks && !isChain) {
    specs.push({ agent: params.agent, task: params.task, depKeys: [], isChain: false, acceptance: params.acceptance });
  } else if (isChain) {
    for (const s of params.chain!) {
      specs.push({ agent: s.agent, task: s.task, depKeys: [], isChain: true, acceptance: s.acceptance ?? params.acceptance });
    }
  } else if (isTasks) {
    for (const s of params.tasks!) {
      specs.push({
        agent: s.agent,
        task: s.task,
        id: s.id,
        depKeys: s.dependsOn ?? [],
        isChain: false,
        acceptance: s.acceptance ?? params.acceptance,
      });
    }
  } else {
    return errorResult(
      "Missing subagent target. Provide { agent, task }, { tasks: [...] }, or { chain: [...] }."
    );
  }

  // Validate every role exists before launching anything.
  for (const s of specs) {
    if (!getAgent(ctx.cwd, s.agent)) {
      return errorResult(`Unknown agent: ${s.agent}`);
    }
  }

  const planned: PlannedTask[] = specs.map((s, i) => ({
    index: i,
    runId: randomUUID(),
    agent: s.agent,
    task: s.task,
    dependsOn: [],
    isChainStep: s.isChain,
    acceptance: s.acceptance,
  }));
  const idToRunId = new Map<string, string>();
  specs.forEach((s, i) => {
    if (s.id) idToRunId.set(s.id, planned[i].runId);
  });

  // Linear chain: step i depends on step i-1.
  if (isChain) {
    for (let i = 1; i < planned.length; i++) {
      planned[i].dependsOn = [planned[i - 1].runId];
    }
  } else if (isTasks) {
    // Resolve dependsOn id references → runIds (post-registration).
    planned.forEach((p, i) => {
      p.dependsOn = specs[i].depKeys
        .map((k) => idToRunId.get(k))
        .filter((v): v is string => !!v);
    });
  }

  return runDag(planned, ctx, onUpdate, sendEvent, modelRuntime);
}
