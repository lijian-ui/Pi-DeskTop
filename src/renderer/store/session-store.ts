import { create } from "zustand";
import { useAgentStore, type Message } from "./agent-store";
import { useWorkspaceStore } from "./workspace-store";

export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  allMessagesText: string;
}

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === "text" && b.text)
      .map((b: any) => b.text)
      .join("\n");
  }
  return "";
}

function extractThinking(content: any): string {
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === "thinking" && b.thinking)
      .map((b: any) => b.thinking)
      .join("\n");
  }
  return "";
}

/**
 * Extract toolCall blocks from an assistant message's content array.
 * Returns ToolExecution[] with input (args) populated; output/isError will be
 * filled in later when we process toolResult messages.
 */
function extractToolCalls(content: any): any[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b: any) => b && b.type === "toolCall")
    .map((b: any) => ({
      id: b.id ?? `tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      toolName: b.name ?? "unknown",
      input: b.arguments ?? null,
      output: undefined as string | undefined,
      isError: false,
      isRunning: false,
    }));
}

/**
 * Convert SDK AgentMessages into the renderer's Message[] shape.
 *
 * SDK message roles: "user" | "assistant" | "toolResult"
 * - user/assistant → Message entries (assistant gets toolExecutions attached)
 * - toolResult → folded into the matching assistant message's toolExecutions
 *   by toolCallId
 */
function convertMessages(raw: any[]): Message[] {
  // First pass: collect toolResult messages indexed by toolCallId
  const toolResults = new Map<
    string,
    { content: any[]; isError: boolean; toolName?: string }
  >();
  for (const m of raw ?? []) {
    if (m?.role === "toolResult" && m.toolCallId) {
      toolResults.set(m.toolCallId, {
        content: Array.isArray(m.content) ? m.content : [],
        isError: !!m.isError,
        toolName: m.toolName,
      });
    }
  }

  const out: Message[] = [];
  for (const m of raw ?? []) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const content = extractText(m.content);
    const thinking =
      m.role === "assistant" ? extractThinking(m.content) : "";

    // Build toolExecutions for assistant messages
    let toolExecutions: any[] | undefined;
    if (m.role === "assistant") {
      const calls = extractToolCalls(m.content);
      if (calls.length > 0) {
        // Merge toolResult data into each tool call
        toolExecutions = calls.map((call) => {
          const result = toolResults.get(call.id);
          if (result) {
            // Serialize result content to string (same format as live events)
            const resultText = Array.isArray(result.content)
              ? result.content
                  .filter(
                    (b: any) =>
                      b &&
                      ((b.type === "text" && b.text) ||
                        (b.type === "data" && b.data)),
                  )
                  .map((b: any) =>
                    b.type === "data" ? b.data : b.text,
                  )
                  .join("\n")
              : "";
            return {
              ...call,
              output:
                resultText ||
                JSON.stringify(result.content, null, 2) || undefined,
              isError: result.isError,
              isRunning: false,
            };
          }
          // No matching result yet (shouldn't happen for completed turns,
          // but keep the call visible anyway)
          return { ...call, isRunning: false };
        });
      }
    }

    // Skip empty assistant messages that have no text, thinking, or tools
    if (
      m.role === "assistant" &&
      !content.trim() &&
      !thinking.trim() &&
      !toolExecutions?.length
    ) {
      continue;
    }

    out.push({
      id: m.id ?? `msg-${out.length}-${Date.now()}`,
      role: m.role,
      content,
      thinking: thinking || undefined,
      toolExecutions,
      isStreaming: false,
      // Re-derive the "user manually stopped" badge from the persisted SDK
      // message so it survives a reload/switch-session (the renderer's own
      // stoppedByUser flag is in-memory only).
      stoppedByUser: m.stopReason === "aborted" ? true : undefined,
      timestamp: typeof m.timestamp === "number" ? m.timestamp : Date.now(),
    });
  }
  return out;
}

/**
 * Reload the FOCUSED session's messages from the main process and store them
 * in its buffer (then mirror into the chat panel). Used on first focus of a
 * session whose buffer is empty (the SDK does not replay history as events),
 * or after a workspace switch. Background sessions are NOT affected.
 */
async function reloadMessages(cwd?: string): Promise<void> {
  const state = await window.piDesk.getState(cwd);
  const msgs = state?.messages?.length ? convertMessages(state.messages) : [];
  const sess = useSessionStore.getState();
  const path = sess.currentPath;
  if (path) {
    sess.setBuffer(path, msgs);
    sess.syncFocus(path);
  }
  const agent = useAgentStore.getState();
  if (state?.model) agent.setModel(state.model);
  if (state?.thinkingLevel) agent.setThinkingLevel(state.thinkingLevel);
}

interface SessionStoreState {
  sessions: SessionInfo[];
  currentPath: string | null;
  /**
   * cwd that owns the FOCUSED session. Authoritative for prompt routing.
   *
   * We cannot always derive this from `sessions` — a brand-new session (or one
   * just bound to a workspace) has no file on disk yet, so `listSessions()`
   * does not know about it. Without this field the composer would fall back to
   * the chat-only dir and silently send the message to the wrong runtime unit.
   */
  currentCwd: string;
  /** Path of the chat-only fallback directory (from the main process). Used
   * to tell "task" sessions (no workspace) apart from workspace-bound ones. */
  chatOnlyCwd: string;
  loading: boolean;
  /**
   * Path of a freshly created session that is NOT yet bound to a workspace
   * folder ("待定" task, created via the nav-level 新建任务 button). While set,
   * the sidebar shows it under the「未分组」bucket. It is cleared when:
   *  - the user picks a workspace in the composer selector (bindPending), or
   *  - the session is written to disk (first message sent → bound to the
   *    current workspace implicitly), or
   *  - the user switches to another session.
   */
  pendingPath: string | null;
  /**
   * Paths of sessions that are currently RUNNING a turn (one per busy cwd).
   * Fed by the main process `pi:runningState` broadcast; drives the sidebar
   * spinner and the composer's "stop" affordance for the focused session.
   */
  runningPaths: Set<string>;
  /**
   * Per-session message buffers, keyed by session path. The FOCUSED session's
   * buffer is mirrored into agent-store (so the visible chat panel reads it);
   * BACKGROUND sessions accumulate their streaming output here in real time
   * (every message_start/update/end event is appended), so focusing a
   * background session later shows its complete live history WITHOUT a reload.
   */
  messagesByPath: Map<string, Message[]>;
  /** Transient message shown when a prompt is rejected (e.g. cwd busy). */
  rejectedMessage: string | null;
  load: () => Promise<void>;
  selectSession: (path: string) => Promise<void>;
  createNew: (cwd?: string) => Promise<void>;
  /** Entry ①: create a new session WITHOUT binding it to a folder yet. */
  createNewPending: () => Promise<void>;
  /** Bind the pending session to the (now current) workspace. */
  bindPending: () => void;
  /** Set the focused session path (and optionally its owning cwd) directly.
   * Used after a per-session workspace bind. */
  setCurrentPath: (path: string, cwd?: string) => void;
  /** Clear the pending (unbound) flag. */
  clearPending: () => void;
  removeSession: (path: string) => Promise<void>;
  exportSession: (path: string) => Promise<string | null>;
  /** Persistently rename a session (writes a session_info entry). */
  renameSession: (path: string, name: string) => Promise<void>;
  /**
   * Re-read the active session's messages AND refresh the session list. Used
   * after events that change the active session without going through
   * selectSession/createNew (e.g. a workspace switch in the main process).
   * @param cwd optional cwd to reload messages from (defaults to the global
   *   workspace store cwd).
   */
  refreshCurrent: (cwd?: string) => Promise<void>;
  /** Replace the set of currently-running session paths (from pi:runningState). */
  setRunningPaths: (paths: string[]) => void;
  /** Clear a transient rejection notice. */
  clearRejected: () => void;
  /** Store a session's full message list into its buffer. */
  setBuffer: (path: string, messages: Message[]) => void;
  /** Apply a pure transform to a session's buffered messages; if the session
   * is focused, the result is mirrored into agent-store automatically. */
  mutateBuffer: (path: string, fn: (msgs: Message[]) => Message[]) => void;
  /** Mirror a buffered session's messages into the focused chat panel. */
  syncFocus: (path: string) => void;
  /** Drop a session's buffer (or all buffers when path omitted). */
  clearBuffer: (path?: string) => void;
}

export const useSessionStore = create<SessionStoreState>((set, get) => ({
  sessions: [],
  currentPath: null,
  currentCwd: "",
  chatOnlyCwd: "",
  loading: false,
  pendingPath: null,
  runningPaths: new Set<string>(),
  messagesByPath: new Map<string, Message[]>(),
  rejectedMessage: null,

  load: async () => {
    set({ loading: true });
    try {
      const [sessions, workspaceCwd, chatOnlyCwd] = await Promise.all([
        window.piDesk.listSessions(),
        window.piDesk.getCwd(),
        window.piDesk.getChatOnlyCwd(),
      ]);
      const current = await window.piDesk.getCurrentSession(
        get().currentCwd || workspaceCwd || undefined,
      );
      let pendingPath = get().pendingPath;
      // A pending session that made it into listSessions() has been written
      // to disk — meaning the user sent a message in it, which implicitly
      // binds it to the workspace it was created in. Drop the pending flag.
      // Also drop it if the runtime moved to a different session entirely.
      if (
        pendingPath &&
        (sessions.some((s) => s.path === pendingPath) || current !== pendingPath)
      ) {
        pendingPath = null;
      }
      let finalSessions = sessions;
      let currentCwd = get().currentCwd;
      const persisted = current
        ? sessions.find((s) => s.path === current)
        : undefined;
      if (persisted) {
        // The file exists on disk: its header cwd is the source of truth.
        currentCwd = persisted.cwd;
      } else if (current) {
        // Surface the currently active session even though its file hasn't
        // been written yet (brand-new session with no messages).
        const base = String(current).split(/[\\/]/).pop() ?? "";
        const isPending = pendingPath === current;
        // A "pending" task stays unbound (cwd "") until the user picks a
        // workspace. Otherwise honour the cwd we bound this session to (set by
        // createNew / bindSession); falling back to the chat-only dir means
        // the sidebar groups it under「任务」.
        const placeholderCwd = isPending
          ? ""
          : currentCwd || chatOnlyCwd || workspaceCwd || "";
        currentCwd = placeholderCwd;
        finalSessions = [
          {
            path: current,
            id: base || "current",
            cwd: placeholderCwd,
            created: new Date().toISOString(),
            modified: new Date().toISOString(),
            messageCount: 0,
            firstMessage: "",
            allMessagesText: "",
          } as SessionInfo,
          ...sessions,
        ];
      }
      set({
        sessions: finalSessions,
        // Preserve the existing currentPath when getCurrentSession returns
        // null — that happens when getCurrentSession is called for a unit
        // that has no session yet (e.g. chat unit at boot), and blindly
        // overwriting it would break selectSession which set it beforehand.
        currentPath: current ?? get().currentPath,
        currentCwd,
        pendingPath,
        chatOnlyCwd,
      });
    } catch (err) {
      console.error("Failed to load sessions:", err);
    } finally {
      set({ loading: false });
    }
  },

  selectSession: async (path: string) => {
    const session = get().sessions.find((s) => s.path === path);
    const cwd = session?.cwd || useWorkspaceStore.getState().cwd;
    await window.piDesk.switchSession(cwd, path);
    set({ currentPath: path, currentCwd: cwd });
    // Background sessions accumulate their output live in messagesByPath, so
    // if the buffer already exists we just mirror it — no reload needed and
    // no loss of the in-flight stream. Otherwise pull history once.
    if (!get().messagesByPath.has(path)) {
      await reloadMessages(cwd);
    } else {
      get().syncFocus(path);
    }
    await get().load();
  },

  createNew: async (cwd?: string) => {
    const effectiveCwd = cwd ?? useWorkspaceStore.getState().cwd;
    const current = await window.piDesk.newSession(effectiveCwd);
    if (!current) return;
    // Entry ② semantics: created directly in the current workspace (or an
    // explicit cwd for "new in folder") → bound immediately, so any leftover
    // pending flag is cleared. Reset currentCwd too, otherwise a plain new
    // task would inherit the previously focused workspace and route there.
    set({
      currentPath: current,
      currentCwd: effectiveCwd || get().chatOnlyCwd || "",
      pendingPath: null,
    });
    // Seed the new (empty) session's buffer and mirror it to the panel.
    const sess = useSessionStore.getState();
    sess.setBuffer(current, []);
    sess.syncFocus(current);
    // A fresh session must not inherit a stuck streaming/error flag from a
    // previous (possibly still-generating) chat — otherwise the first send in
    // the new session would wrongly call steer() and error out.
    const agent = useAgentStore.getState();
    agent.setStreaming(false);
    agent.setError(null);
    agent.clearQueue();
    const st = await window.piDesk.getState(effectiveCwd);
    if (st?.model) agent.setModel(st.model);
    if (st?.thinkingLevel) agent.setThinkingLevel(st.thinkingLevel);
    await get().load();
  },

  createNewPending: async () => {
    const cwd = useWorkspaceStore.getState().cwd;
    const current = await window.piDesk.newSession(cwd);
    if (!current) return;
    // Entry ① semantics: the new task is NOT bound to a folder yet — mark it
    // pending so the sidebar shows it under「未分组」until the user picks a
    // workspace (or sends a message, which binds to the current workspace).
    set({ currentPath: current, currentCwd: cwd || "", pendingPath: current });
    const sess = useSessionStore.getState();
    sess.setBuffer(current, []);
    sess.syncFocus(current);
    const agent = useAgentStore.getState();
    agent.setStreaming(false);
    agent.setError(null);
    agent.clearQueue();
    const st = await window.piDesk.getState(cwd);
    if (st?.model) agent.setModel(st.model);
    if (st?.thinkingLevel) agent.setThinkingLevel(st.thinkingLevel);
    await get().load();
  },

  bindPending: () => {
    // The user picked a workspace for the pending task. Clearing the flag
    // makes load() fill the placeholder's cwd with the current workspace,
    // moving it from「未分组」into that folder's group.
    if (get().pendingPath) set({ pendingPath: null });
  },

  setCurrentPath: (path: string, cwd?: string) => {
    set(cwd === undefined ? { currentPath: path } : { currentPath: path, currentCwd: cwd });
  },

  clearPending: () => {
    if (get().pendingPath) set({ pendingPath: null });
  },

  removeSession: async (path: string) => {
    const wasCurrent = get().currentPath === path;
    get().clearBuffer(path);
    try {
      await window.piDesk.deleteSession(path);
    } catch (err) {
      // Main process refused (e.g. the session is still generating). Keep the
      // buffer/list intact so the user can stop it and retry.
      console.error("Failed to delete session:", err);
      return;
    }
    if (wasCurrent) {
      // Don't leave the user staring at a deleted conversation — start fresh.
      await get().createNew();
    } else {
      await get().load();
    }
  },

  exportSession: async (path: string) => {
    return await window.piDesk.exportSession(path);
  },

  renameSession: async (path: string, name: string) => {
    await window.piDesk.renameSession(path, name);
    await get().load();
  },

  refreshCurrent: async (cwd?: string) => {
    await reloadMessages(
      cwd ?? get().currentCwd ?? useWorkspaceStore.getState().cwd,
    );
    await get().load();
  },

  setRunningPaths: (paths: string[]) => {
    set({ runningPaths: new Set(paths) });
  },

  clearRejected: () => {
    set({ rejectedMessage: null });
  },

  setBuffer: (path, messages) => {
    if (!path) return;
    set((state) => {
      const map = new Map(state.messagesByPath);
      map.set(path, messages);
      return { messagesByPath: map };
    });
  },

  mutateBuffer: (path, fn) => {
    if (!path) return;
    const prev = get().messagesByPath.get(path) ?? [];
    const next = fn(prev);
    set((state) => {
      const map = new Map(state.messagesByPath);
      map.set(path, next);
      return { messagesByPath: map };
    });
    // Mirror into the visible chat panel if this is the focused session.
    if (path === get().currentPath) {
      useAgentStore.getState().setMessages(next);
    }
  },

  syncFocus: (path) => {
    const msgs = get().messagesByPath.get(path) ?? [];
    useAgentStore.getState().setMessages(msgs);
  },

  clearBuffer: (path) => {
    set((state) => {
      if (!path) return { messagesByPath: new Map<string, Message[]>() };
      const map = new Map(state.messagesByPath);
      map.delete(path);
      return { messagesByPath: map };
    });
  },
}));
