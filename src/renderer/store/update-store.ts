import { create } from "zustand";

export interface UpdateState {
  status:
    | "idle"
    | "checking"
    | "available"
    | "not-available"
    | "downloading"
    | "downloaded"
    | "error";
  version?: string;
  progress?: number;
  message?: string;
}

interface UpdateStore {
  state: UpdateState;
  /** Subscribe to main-process update state broadcasts (call once at app mount). */
  init: () => void;
  setState: (s: UpdateState) => void;
  /** Ask the main process to check for updates now. */
  check: () => Promise<void>;
  /** Quit and install the downloaded update. */
  quitAndInstall: () => void;
}

// Guards against duplicate subscriptions: App's effect can run twice under
// React StrictMode (dev), which would otherwise register two IPC listeners
// and double-process every broadcast.
let initialized = false;

export const useUpdateStore = create<UpdateStore>((set) => ({
  state: { status: "idle" },
  init: () => {
    if (initialized) return;
    initialized = true;
    window.piDesk.onUpdateState((s) => {
      set({ state: s as UpdateState });
    });
  },
  setState: (s) => set({ state: s }),
  check: async () => {
    const s = await window.piDesk.checkForUpdates();
    set({ state: s as UpdateState });
  },
  quitAndInstall: () => {
    window.piDesk.quitAndInstall();
  },
}));
