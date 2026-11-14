import { create } from "zustand";

export type SubagentRunStatus = "pending" | "running" | "done" | "error" | "skipped";

const TERMINAL: SubagentRunStatus[] = ["done", "error", "skipped"];
export const isTerminal = (s: SubagentRunStatus): boolean => TERMINAL.includes(s);

export interface SubagentStep {
  kind: "tool_call" | "tool_result";
  tool?: string;
  label?: string;
  detail?: string;
  isError?: boolean;
}

/** Cumulative run stats as sent by the runner on done/error. All fields
 *  optional on the wire: older producers (or runs that died early) may carry
 *  only elapsedMs — the UI must degrade gracefully when a field is absent. */
export interface SubagentRunStats {
  elapsedMs?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}

export interface SubagentRun {
  runId: string;
  agent: string;
  status: SubagentRunStatus;
  error?: string;
  steps?: SubagentStep[];
  /** runIds of tasks this one waits on (DAG edges). */
  dependsOn?: string[];
  /** Resolved model id this run uses (role override or parent default). */
  model?: string;
  /** Planned task text (≤120 chars, from subagent_enqueue). */
  task?: string;
  /** Epoch ms the child session started (from subagent_start). */
  startedAt?: number;
  /** Epoch ms the run reached its terminal status (renderer-side, event arrival). */
  endedAt?: number;
  /** Token/cost totals, present on done (and partially on error). */
  stats?: SubagentRunStats;
  /** Parent session file path — panels only render runs of the current session. */
  sessionPath?: string;
  /** Internal monotonic counter for step-dedup (see the step handler). */
  stepsSeq?: number;
}

interface SubagentState {
  runs: SubagentRun[];
  /** runIds the user explicitly hid via the panel X. Tombstones are pruned
   *  whenever their run leaves `runs` (session-switch cleanup). */
  dismissed: string[];
  init: () => void;
  dismissRuns: (runIds: string[]) => void;
  /** Session-switch cleanup: drop terminal runs owned by `sessionPath` (their
   *  cards survive until the user leaves the session, then dies here) and
   *  prune the dismissed tombstones of runs that no longer exist. */
  cleanupSession: (sessionPath: string) => void;
}

let inited = false;

export const useSubagentStore = create<SubagentState>((set) => ({
  runs: [],
  dismissed: [],
  init: () => {
    if (inited) return;
    inited = true;
    window.piDesk.onEvent((e: any) => {
      if (!e || typeof e.type !== "string" || !e.type.startsWith("subagent_")) return;
      if (e.type === "subagent_enqueue") {
        // Surface the full plan up-front: a pending node with its edges.
        // Idempotent by runId: a re-delivered enqueue merges fields instead
        // of duplicating the card.
        set((s) => {
          const patch = {
            dependsOn: e.dependsOn,
            model: e.model,
            task: e.task,
            sessionPath: e.sessionPath,
          };
          return {
            runs: s.runs.some((r) => r.runId === e.runId)
              ? s.runs.map((r) => (r.runId === e.runId ? { ...r, ...patch } : r))
              : [
                  ...s.runs,
                  {
                    runId: e.runId,
                    agent: e.agent,
                    status: "pending" as SubagentRunStatus,
                    steps: [],
                    ...patch,
                  },
                ],
          };
        });
      } else if (e.type === "subagent_start") {
        // A run may already exist as `pending` (enqueued) — just flip status.
        // Terminal runs are never revived (idempotent replay guard).
        set((s) => ({
          runs: s.runs.some((r) => r.runId === e.runId)
            ? s.runs.map((r) =>
                r.runId === e.runId && !isTerminal(r.status)
                  ? { ...r, status: "running" as SubagentRunStatus, startedAt: e.startedAt ?? Date.now() }
                  : r
              )
            : [
                ...s.runs,
                {
                  runId: e.runId,
                  agent: e.agent,
                  status: "running" as SubagentRunStatus,
                  startedAt: e.startedAt ?? Date.now(),
                  sessionPath: e.sessionPath,
                  steps: [],
                },
              ],
        }));
      } else if (e.type === "subagent_step") {
        const step: SubagentStep = {
          kind: e.kind,
          tool: e.tool,
          label: e.label,
          detail: e.detail,
          isError: e.isError,
        };
        set((s) => ({
          runs: s.runs.map((r) => {
            if (r.runId !== e.runId) return r;
            // Steps only stream into a live run: a step arriving after the
            // terminal event is a stale duplicate — the length sentinel below
            // (stepsSeq = accepted count) additionally lets a future `seq`
            // field dedup out-of-order deliveries.
            if (isTerminal(r.status)) return r;
            if (typeof e.seq === "number" && e.seq <= (r.stepsSeq ?? 0)) return r;
            const steps = [...(r.steps ?? []), step];
            return { ...r, steps, stepsSeq: typeof e.seq === "number" ? e.seq : steps.length };
          }),
        }));
      } else if (e.type === "subagent_done") {
        set((s) => ({
          runs: s.runs.map((r) =>
            r.runId === e.runId && !isTerminal(r.status)
              ? { ...r, status: "done" as SubagentRunStatus, stats: e.stats, endedAt: Date.now() }
              : r
          ),
        }));
      } else if (e.type === "subagent_error") {
        set((s) => ({
          runs: s.runs.map((r) =>
            r.runId === e.runId && !isTerminal(r.status)
              ? {
                  ...r,
                  status: "error" as SubagentRunStatus,
                  error: e.error,
                  stats: e.stats,
                  endedAt: Date.now(),
                }
              : r
          ),
        }));
      } else if (e.type === "subagent_skip") {
        set((s) => ({
          runs: s.runs.map((r) =>
            r.runId === e.runId && !isTerminal(r.status)
              ? { ...r, status: "skipped" as SubagentRunStatus, endedAt: Date.now() }
              : r
          ),
        }));
      }
    });
  },
  dismissRuns: (runIds) =>
    set((s) => ({
      dismissed: [...new Set([...s.dismissed, ...runIds])],
    })),
  cleanupSession: (sessionPath) =>
    set((s) => {
      const runs = s.runs.filter(
        (r) => !(r.sessionPath === sessionPath && isTerminal(r.status))
      );
      if (runs.length === s.runs.length) return s;
      const alive = new Set(runs.map((r) => r.runId));
      return { runs, dismissed: s.dismissed.filter((id) => alive.has(id)) };
    }),
}));

// Start listening as soon as the module is loaded on the renderer.
useSubagentStore.getState().init();
