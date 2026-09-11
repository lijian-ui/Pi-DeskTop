import { create } from "zustand";

export type SubagentRunStatus = "pending" | "running" | "done" | "error" | "skipped";

export interface SubagentStep {
  kind: "tool_call" | "tool_result";
  tool?: string;
  label?: string;
  detail?: string;
  isError?: boolean;
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
}

interface SubagentState {
  runs: SubagentRun[];
  /** runIds the user explicitly hid via the panel X. Hidden only until the
   *  run leaves `runs` (done/error → 4s auto-remove) — a later brand-new run
   *  reappears naturally instead of being stuck hidden. */
  dismissed: string[];
  init: () => void;
  dismissRuns: (runIds: string[]) => void;
}

let inited = false;

export const useSubagentStore = create<SubagentState>((set) => ({
  runs: [],
  dismissed: [],
  init: () => {
    if (inited) return;
    inited = true;
    window.piDesk.onEvent((e: any) => {
      if (!e || typeof e.type !== "string") return;
      if (e.type === "subagent_enqueue") {
        // Surface the full plan up-front: a pending node with its edges.
        set((s) => ({
          runs: [
            ...s.runs,
            {
              runId: e.runId,
              agent: e.agent,
              status: "pending",
              dependsOn: e.dependsOn,
              model: e.model,
              steps: [],
            },
          ],
        }));
      } else if (e.type === "subagent_skip") {
        set((s) => ({
          runs: s.runs.map((r) =>
            r.runId === e.runId ? { ...r, status: "skipped" } : r
          ),
        }));
        scheduleRemove(e.runId);
      } else if (e.type === "subagent_start") {
        // A run may already exist as `pending` (enqueued) — just flip status.
        set((s) => ({
          runs: s.runs.some((r) => r.runId === e.runId)
            ? s.runs.map((r) =>
                r.runId === e.runId ? { ...r, status: "running" } : r
              )
            : [
                ...s.runs,
                { runId: e.runId, agent: e.agent, status: "running", steps: [] },
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
          runs: s.runs.map((r) =>
            r.runId === e.runId
              ? { ...r, steps: [...(r.steps ?? []), step] }
              : r
          ),
        }));
      } else if (e.type === "subagent_done") {
        set((s) => ({
          runs: s.runs.map((r) => (r.runId === e.runId ? { ...r, status: "done" } : r)),
        }));
        scheduleRemove(e.runId);
      } else if (e.type === "subagent_error") {
        set((s) => ({
          runs: s.runs.map((r) =>
            r.runId === e.runId ? { ...r, status: "error", error: e.error } : r
          ),
        }));
        scheduleRemove(e.runId);
      }
    });
  },
  dismissRuns: (runIds) =>
    set((s) => ({
      dismissed: [...new Set([...s.dismissed, ...runIds])],
    })),
}));

function scheduleRemove(runId: string): void {
  setTimeout(() => {
    useSubagentStore.setState((s) => ({
      runs: s.runs.filter((r) => r.runId !== runId),
      // The run no longer exists, so hiding it is moot — prune the tombstone.
      dismissed: s.dismissed.filter((id) => id !== runId),
    }));
  }, 4000);
}

// Start listening as soon as the module is loaded on the renderer.
useSubagentStore.getState().init();
