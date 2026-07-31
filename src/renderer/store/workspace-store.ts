import { create } from "zustand";
import { useSessionStore } from "./session-store";
import { useSkillStore } from "./skill-store";

/**
 * Tracks the desktop's current "workspace" (a directory used as cwd for
 * new sessions and project-scoped resources like `.pi/skills`). Each
 * session file on disk already records its own cwd in its header, so
 * sessions remain bound to the workspace they were created in even after
 * the user switches — switching just changes the default for *new*
 * sessions and which sessions show up in the sidebar.
 */
interface WorkspaceState {
  /** Current workspace path. Empty string until the first load. */
  cwd: string;
  /** Recently used workspace paths, most-recent first, capped at 10. */
  recents: string[];
  loading: boolean;
  error: string | null;

  /** Fetch current cwd + recents from the main process. */
  load: () => Promise<void>;
  /** Open the OS directory picker and switch to whatever the user picks. */
  pickAndSet: () => Promise<void>;
  /** Switch to a specific cwd (e.g. from the recents dropdown). */
  setCwd: (cwd: string) => Promise<void>;
  /** Bind a still-empty session to a workspace directory (per-session; does
   * NOT set the global workspace). */
  bindSession: (sessionPath: string, workspaceCwd: string) => Promise<void>;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  cwd: "",
  recents: [],
  loading: false,
  error: null,

  load: async () => {
    try {
      const [cwd, recents] = await Promise.all([
        window.piDesk.getCwd(),
        window.piDesk.getRecentWorkspaces(),
      ]);
      set({ cwd, recents });
    } catch (err) {
      console.error("Failed to load workspace state:", err);
    }
  },

  pickAndSet: async () => {
    const picked = await window.piDesk.pickWorkspace();
    if (!picked) return;
    await get().setCwd(picked);
  },

  setCwd: async (cwd: string) => {
    set({ loading: true, error: null });
    try {
      const newCwd = await window.piDesk.setCwd(cwd);
      const recents = await window.piDesk.getRecentWorkspaces();
      set({ cwd: newCwd, recents });

      // Picking a workspace binds any "pending" (未分组) new task to it:
      //  - different cwd → the main process focuses that cwd's existing runtime
      //    (or lazily creates one); the pending session stays and is simply
      //    bound to the chosen workspace.
      //  - same cwd → main early-returned, the pending session stays.
      // Either way the pending flag must be cleared so the sidebar regroups
      // the task under the chosen folder.
      useSessionStore.getState().bindPending();

      // Switching the focused workspace means the visible chat/session list
      // now reflect a DIFFERENT runtime unit, so refresh everything that
      // depended on the previous focus:
      //   - session list (re-scoped)
      //   - chat messages (the focused unit's current session)
      //   - skill list (project skills come from <cwd>/.pi/skills)
      // Note: other cwds' units keep running in the background (cwd-level
      // concurrency) — they are NOT disposed here.
      await useSessionStore.getState().refreshCurrent();
      await useSkillStore.getState().load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ error: msg });
      console.error("Failed to switch workspace:", err);
    } finally {
      set({ loading: false });
    }
  },

  bindSession: async (sessionPath, workspaceCwd) => {
    set({ loading: true, error: null });
    try {
      const res = await window.piDesk.bindSessionToWorkspace(sessionPath, workspaceCwd);
      const sess = useSessionStore.getState();
      // The session now lives in the workspace dir — focus it and clear any
      // pending flag, then reload messages + list from the new cwd.
      sess.setCurrentPath(res.newPath, res.cwd);
      sess.clearPending();
      await sess.refreshCurrent(res.cwd);
      await useSkillStore.getState().load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ error: msg });
      console.error("Failed to bind session to workspace:", err);
    } finally {
      set({ loading: false });
    }
  },
}));
