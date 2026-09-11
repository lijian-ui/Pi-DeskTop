import { randomUUID } from "node:crypto";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { getAgent, SubagentDef } from "./agent-discovery";

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
}

/** Parameters the model passes to the `subagent` tool. */
export interface SubagentParams {
  agent?: string;
  task?: string;
  /** Parallel / DAG fanout. Tasks may declare `dependsOn` to run after others. */
  tasks?: SubagentTaskSpec[];
  /** Sequential chain: each step depends on the previous one and receives its
   *  output. Internally normalized into a linear dependency DAG. */
  chain?: { agent: string; task: string }[];
}

export type SubagentRunStatus =
  | "pending"
  | "running"
  | "done"
  | "error"
  | "skipped";

export type SubagentEvent =
  | { type: "subagent_enqueue"; runId: string; agent: string; dependsOn: string[]; model?: string }
  | { type: "subagent_start"; runId: string; agent: string }
  | { type: "subagent_done"; runId: string; agent: string; ok: boolean }
  | { type: "subagent_error"; runId: string; agent: string; error: string }
  | { type: "subagent_skip"; runId: string; agent: string }
  | {
      type: "subagent_step";
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
  modelRuntime: any
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
    noTools: "builtin",
    tools: def.tools ?? undefined,
    excludeTools: def.excludeTools.length ? def.excludeTools : undefined,
  });

  // Bind this child to its PARENT session so a stop only kills this parent's
  // subagents, never siblings or scheduled tasks. The parent's sessionPath
  // comes from the tool-execution context (ctx.sessionManager.getSessionFile());
  // fall back to the parent cwd only if that is somehow unavailable.
  const parentPath =
    (ctx as any)?.sessionManager?.getSessionFile?.() ?? ctx?.cwd ?? "";
  activeSessions.set(runId, { session, parentPath });
  sendEvent({ type: "subagent_start", runId, agent: def.name });

  // TEMP DIAGNOSTIC — remove after root cause is confirmed.
  const DEBUG = process.env.PI_SUBAGENT_DEBUG === "1";
  if (DEBUG)
    console.log(
      "[SUBAGENT] runOne start:",
      def.name,
      "| agent?",
      !!session.agent,
      "| has beforeToolCall?",
      typeof session.agent?.beforeToolCall
    );

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
      if (DEBUG) console.log("[SUBAGENT] >> beforeToolCall fired:", toolName);
      sendEvent({
        type: "subagent_step",
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
      if (DEBUG) console.log("[SUBAGENT] << afterToolCall fired:", toolName, "| isError:", !!p?.isError);
      sendEvent({
        type: "subagent_step",
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

    if (DEBUG) {
      console.log(
        "[SUBAGENT] hookFired:",
        hookFired,
        "| roles:",
        (msgs as any[]).map((m) => m?.role).join(",")
      );
      for (const m of msgs as any[]) {
        const types = Array.isArray(m?.content)
          ? m.content.map((b: any) => b?.type).join(",")
          : "(none)";
        console.log("[SUBAGENT] msg role=", m?.role, "blocks=", types);
      }
    }
    const text = extractText(msgs[msgs.length - 1]);
    sendEvent({ type: "subagent_done", runId, agent: def.name, ok: true });
    return { text, ok: true };
  } catch (err: any) {
    const aborted = (session as any)?.aborted === true;
    const msg = aborted ? "已被用户停止" : err?.message ?? String(err);
    sendEvent({ type: "subagent_error", runId, agent: def.name, error: msg });
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
  for (const p of planned) {
    status.set(p.runId, "pending");
    defs.set(p.index, getAgent(ctx.cwd, p.agent));
  }

  // Surface the full plan so the panel can render nodes + edges immediately.
  for (const p of planned) {
    const def = defs.get(p.index);
    sendEvent({
      type: "subagent_enqueue",
      runId: p.runId,
      agent: p.agent,
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
          sendEvent({ type: "subagent_skip", runId: p.runId, agent: p.agent });
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
        if (st === "error") return `[${p.agent}]\n(任务失败)`;
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
      const prevOut =
        next.isChainStep && next.dependsOn.length
          ? outputs.get(indexOfRunId(next.dependsOn[0])) ?? ""
          : "";
      const taskText = prevOut
        ? `${next.task}\n\nPrevious step result:\n${prevOut}`
        : next.task;
      runOne(def, taskText, ctx, sendEvent, next.runId, modelRuntime)
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
  type Spec = { agent: string; task: string; id?: string; depKeys: string[]; isChain: boolean };
  const specs: Spec[] = [];
  const isChain = Array.isArray(params.chain) && params.chain.length > 0;
  const isTasks = Array.isArray(params.tasks) && params.tasks.length > 0;

  if (params.agent && params.task && !isTasks && !isChain) {
    specs.push({ agent: params.agent, task: params.task, depKeys: [], isChain: false });
  } else if (isChain) {
    for (const s of params.chain!) {
      specs.push({ agent: s.agent, task: s.task, depKeys: [], isChain: true });
    }
  } else if (isTasks) {
    for (const s of params.tasks!) {
      specs.push({
        agent: s.agent,
        task: s.task,
        id: s.id,
        depKeys: s.dependsOn ?? [],
        isChain: false,
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
