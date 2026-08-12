import { create } from "zustand";

export type BashMode = "yolo" | "ask";

export interface PendingApproval {
  requestId: number;
  command: string;
  cwd?: string;
  sessionPath?: string | null;
}

interface BashGuardState {
  /** Current permission mode. Persisted to localStorage so it survives reload. */
  mode: BashMode;
  /**
   * The approval request currently SHOWN in the modal, or null.
   * cwd/sessionPath identify which workspace spawned the prompt
   * (multi-cwd concurrency).
   */
  pending: PendingApproval | null;
  /**
   * Additional approval requests waiting behind the one on screen. The modal
   * is single-slot; without a queue, a second cwd's request would overwrite
   * the first and the first cwd's tool call would hang forever waiting.
   */
  queue: PendingApproval[];

  setMode: (mode: BashMode) => void;
  /** Show a new request immediately, or enqueue it if one is already showing. */
  enqueuePending: (p: PendingApproval) => void;
  /** Respond to the CURRENTLY shown request and advance to the next queued one. */
  respondAndAdvance: (
    requestId: number,
    decision: "allow" | "deny" | "allow-session" | "allow-whitelist",
  ) => void;
  /** Dismiss the current request WITHOUT answering it (rare: e.g. reset). */
  skipPending: () => void;
}

const STORAGE_KEY = "pi-desk:bashGuardMode";

function loadMode(): BashMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "yolo" || v === "ask") return v;
  } catch {
    /* localStorage unavailable */
  }
  return "ask";
}

export const useBashGuardStore = create<BashGuardState>((set, get) => ({
  mode: loadMode(),
  pending: null,
  queue: [],

  setMode: (mode) => {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* ignore */
    }
    set({ mode });
    // Push the new mode into the main process (which holds the authoritative
    // policy used by the wrapped executeBash).
    window.piDesk.setBashGuardMode(mode);
  },

  enqueuePending: (p) => {
    const s = get();
    if (!s.pending) {
      set({ pending: p });
    } else {
      set({ queue: [...s.queue, p] });
    }
  },

  respondAndAdvance: (requestId, decision) => {
    window.piDesk.respondBashApproval({ requestId, decision });
    const s = get();
    const next = s.queue[0] ?? null;
    set({ pending: next, queue: next ? s.queue.slice(1) : [] });
  },

  skipPending: () => {
    const s = get();
    const next = s.queue[0] ?? null;
    set({ pending: next, queue: next ? s.queue.slice(1) : [] });
  },
}));
