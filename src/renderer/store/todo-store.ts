import { create } from "zustand";
import type { TodoSnapshot } from "../../shared/todo-types";
import { useUIStore } from "./ui-store";
import { useSessionStore } from "./session-store";

/**
 * Todo checklist snapshots per session file, fetched lazily from the main
 * process (`pi:getTodoSnapshot`, which replays the LAST `todo` tool result
 * from the session's own .jsonl — the conversation itself is the source of
 * truth). Fetching on demand means switching sessions / restarting the app
 * always shows the correct list with no push channel to maintain.
 */
interface TodoStore {
  /** sessionPath → snapshot (null = fetched & confirmed absent). */
  snapshots: Record<string, TodoSnapshot | null>;
  /** sessionPath → user explicitly closed the panel for this session. While
   *  set, model updates do NOT auto-reopen the panel (the user opted out);
   *  the titlebar Todo toggle is the way back in. Cleared on reopen. */
  dismissed: Record<string, boolean>;
  /** IPC fetch + cache; auto-opens the right-side panel when the FOCUSED
   *  session has a non-empty checklist and the user has not manually closed
   *  it for that session. No-op when the snapshot is unchanged (avoids
   *  re-render churn on every tool event of a live loop). */
  fetchTodo: (sessionPath: string) => Promise<void>;
  /** Remember that the user closed the panel for this session. */
  setDismissed: (sessionPath: string, dismissed: boolean) => void;
  /** Drop the cached snapshot (session deleted / closed). */
  clearTodo: (sessionPath: string) => void;
}

function sameSnapshot(a: TodoSnapshot | null | undefined, b: TodoSnapshot | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.nextId !== b.nextId || a.tasks.length !== b.tasks.length) return false;
  return a.tasks.every((t, i) => {
    const u = b.tasks[i];
    return (
      t.id === u.id &&
      t.content === u.content &&
      t.status === u.status &&
      JSON.stringify(t.blockedBy ?? null) === JSON.stringify(u.blockedBy ?? null)
    );
  });
}

export const useTodoStore = create<TodoStore>((set, get) => ({
  snapshots: {},
  dismissed: {},

  fetchTodo: async (sessionPath) => {
    if (!sessionPath) return;
    try {
      const snapshot = await window.piDesk.getTodoSnapshot(sessionPath);
      const prev = get().snapshots[sessionPath];
      if (sameSnapshot(prev, snapshot)) return; // nothing changed
      set((s) => ({ snapshots: { ...s.snapshots, [sessionPath]: snapshot } }));
      // Auto-open the panel only when this is the session the user is looking
      // at, the model actually has a live checklist to show, AND the user has
      // not manually closed the panel for this session (respect their choice).
      if (sessionPath === useSessionStore.getState().currentPath) {
        const live = (snapshot?.tasks ?? []).some((t) => t.status !== "deleted");
        const ui = useUIStore.getState();
        if (live && !ui.todoPanelOpen && !get().dismissed[sessionPath]) {
          ui.setTodoPanelOpen(true);
        }
      }
    } catch {
      // IPC failure — leave whatever we had; a later tool event retries.
    }
  },

  setDismissed: (sessionPath, dismissed) => {
    set((s) => {
      if (!!s.dismissed[sessionPath] === dismissed) return s;
      const next = { ...s.dismissed };
      if (dismissed) next[sessionPath] = true;
      else delete next[sessionPath];
      return { dismissed: next };
    });
  },

  clearTodo: (sessionPath) => {
    set((s) => {
      const hasSnap = sessionPath in s.snapshots;
      const hasDismiss = sessionPath in s.dismissed;
      if (!hasSnap && !hasDismiss) return s;
      const snapshots = { ...s.snapshots };
      const dismissed = { ...s.dismissed };
      delete snapshots[sessionPath];
      delete dismissed[sessionPath];
      return { snapshots, dismissed };
    });
  },
}));
