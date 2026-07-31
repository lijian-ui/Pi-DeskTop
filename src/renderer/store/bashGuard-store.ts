import { create } from "zustand";

export type BashMode = "yolo" | "ask";

interface BashGuardState {
  /** Current permission mode. Persisted to localStorage so it survives reload. */
  mode: BashMode;
  /** A bash command awaiting the user's decision, or null. cwd/sessionPath
   *  identify which workspace spawned the prompt (multi-cwd concurrency). */
  pending: {
    requestId: number;
    command: string;
    cwd?: string;
    sessionPath?: string | null;
  } | null;

  setMode: (mode: BashMode) => void;
  setPending: (
    p: {
      requestId: number;
      command: string;
      cwd?: string;
      sessionPath?: string | null;
    } | null
  ) => void;
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

export const useBashGuardStore = create<BashGuardState>((set) => ({
  mode: loadMode(),
  pending: null,

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

  setPending: (p) => set({ pending: p }),
}));
