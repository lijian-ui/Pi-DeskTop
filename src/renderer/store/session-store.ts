import { create } from "zustand";
import { useAgentStore, type Message } from "./agent-store";
import { useWorkspaceStore } from "./workspace-store";
import { extractText, extractThinking, extractImages } from "../utils/content-utils";
import { hydrateArtifacts } from "../utils/artifact-utils";
import type { ScheduledTasksData } from "../../preload/api";

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
 * Each task created without an explicit workspace gets its OWN timestamped
 * subdir under the chat-only dir (e.g. `~/.pi/agent/chat/2026-09-02-14-59-28`).
 * The shared `chat` dir can only host one active generation, so a flat cwd
 * would mean "new task aborts the previously running one". A unique cwd gives
 * every task its own runtime/unit in the main process → tasks run in parallel.
 */
function taskTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(
    d.getHours(),
  )}-${p(d.getMinutes())}-${p(d.getSeconds())}-${ms}`;
}
function newTaskCwd(chatOnly: string): string {
  const sep = chatOnly.includes("\\") ? "\\" : "/";
  return `${chatOnly.replace(/[\\/]+$/, "")}${sep}${taskTimestamp()}`;
}

/**
 * True when `cwd` is one of the per-task timestamped subdirs under the
 * chat-only dir (see {@link newTaskCwd}) — i.e. a task-mode session that owns
 * its own runtime unit.
 */
function isTimestampedTaskCwd(cwd: string | undefined, chatOnly: string): boolean {
  if (!cwd || !chatOnly) return false;
  const root = chatOnly.replace(/[\\/]+$/, "");
  const norm = cwd.replace(/[\\/]+$/, "");
  if (norm === root || !norm.startsWith(root + (cwd.includes("\\") ? "\\" : "/"))) return false;
  const rel = norm.slice(root.length).replace(/^[\\/]/, "");
  // A timestamped task dir sits DIRECTLY under the chat root — anything nested
  // deeper (e.g. `chat/im/<channel>`) is not a task cwd.
  return /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}(-\d{1,3})?$/.test(rel);
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
    // Images the user attached are persisted in the session file — restore
    // them so reopening a conversation still shows the thumbnails.
    const images =
      m.role === "user"
        ? extractImages(m.content, m.id ?? `h${out.length}`)
        : [];

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
      images: images.length ? images : undefined,
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
  // Load the FULL transcript (pre-compaction history included). getState().messages
  // is the SDK's compaction-aware LLM context and omits everything before the
  // compaction point — which is exactly the user's first question in a long
  // session, so it must never be the source for the chat panel's history.
  const rawMessages = await window.piDesk.getFullMessages(cwd);
  let msgs = rawMessages?.length ? convertMessages(rawMessages) : [];
  if (msgs.length) {
    // Artifacts are NOT persisted separately — live turns derive them from
    // tool events, so a reload must REPLAY them from the same source
    // (the persisted tool calls just converted above) or the cards would
    // vanish on every refresh / session switch. Idempotent, and mirrors
    // live behaviour: file-writer tools are replayed without stat, shell
    // candidates are stat()-verified.
    msgs = await hydrateArtifacts(msgs, cwd ?? "");
  }
  const sess = useSessionStore.getState();
  const path = sess.currentPath;
  if (path) {
    sess.setBuffer(path, msgs);
    sess.syncFocus(path);
  }
  const agent = useAgentStore.getState();
  if (state?.model) agent.setModel(state.model);
  if (state?.thinkingLevel) agent.setThinkingLevel(state.thinkingLevel);
  if (state?.commands) agent.setCommands(state.commands);
  // Resync the running set from the main process. `pi:runningState` is only
  // broadcast when a run starts/ends, so after switching sessions (or missing
  // a broadcast while another page was mounted) the local set can go stale and
  // hide the stop button on a session that is still generating. getState() now
  // carries the authoritative snapshot — apply it on every reload.
  if (Array.isArray(state?.running)) {
    useSessionStore.getState().setRunningPaths(state.running);
  }
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
  /**
   * Path of a task-mode session that exists only as a reserved placeholder:
   * the user clicked「新建任务」but has NOT sent its first message yet, so no
   * unit was built and no file was written. Such a draft is deliberately kept
   * OUT of the sidebar (an empty entry per click is noise) — it becomes a
   * normal session the moment the first message is sent, which builds the unit
   * and adopts this very path as the real session file.
   *
   * Cleared when: the path shows up in listSessions() (persisted), the user
   * switches to another session, or a new draft replaces it.
   */
  draftTaskPath: string | null;
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
   *
   * Capped at MAX_BUFFERED_SESSIONS (20); when the limit is hit the oldest
   * non-current entry is evicted (Map iterates insertion order). Focusing the
   * evicted session triggers a normal reload from disk — only the live-stream
   * state is lost, which is acceptable for a session the user hasn't touched
   * in a long time.
   */
  messagesByPath: Map<string, Message[]>;
  /** Transient message shown when a prompt is rejected (e.g. cwd busy). */
  rejectedMessage: string | null;
  /** Scheduled tasks + their run history, surfaced in the sidebar. */
  scheduledRuns: ScheduledTasksData;
  /** Re-fetch scheduled tasks/runs only (used by event-driven refresh). */
  refreshScheduledTasks: () => Promise<void>;
  /**
   * Lightweight session-list refresh (listSessions only — no currentPath /
   * currentCwd side effects). Used when a scheduled run creates a new session
   * file so the sidebar picks it up without a full page reload.
   */
  refreshSessions: () => Promise<void>;
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
  /** Mark/clear the unsent draft task (see `draftTaskPath`). */
  setDraftTaskPath: (path: string | null) => void;
  /**
   * Promote a draft task to a real, visible sidebar entry — called the moment
   * the user sends its first message. The SDK writes the session file
   * asynchronously, so listSessions() can lag behind by a whole turn (the
   * entry would only appear once the reply finished). Materializing it from
   * the in-memory buffer keeps the sidebar in sync with what the user did.
   * No-op when `path` isn't the current draft (or isn't in the list yet).
   */
  graduateDraft: (path: string) => void;
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

/** Cap the number of cached per-session message buffers so switching between
 *  many workspaces doesn't endlessly accumulate memory. When exceeded, the
 *  oldest non-current entry is evicted. */
const MAX_BUFFERED_SESSIONS = 20;

/**
 * Hide the still-unsent draft task (if any) from a session list.
 *
 * A draft is a task the user created with「新建任务」but never messaged: it has
 * no unit and no file, so it shows up in neither listSessions() nor the user's
 * mental model of "my tasks". It graduates — i.e. becomes a normal, visible
 * session — the instant its first message is sent, which writes the file under
 * this very path and makes it appear in the list.
 */
function filterDraftSession(
  sessions: SessionInfo[],
  draftPath: string | null,
): { sessions: SessionInfo[]; draftPath: string | null } {
  if (!draftPath) return { sessions, draftPath: null };
  if (sessions.some((s) => s.path === draftPath)) {
    // It hit the disk → no longer a draft.
    return { sessions, draftPath: null };
  }
  return {
    sessions: sessions.filter((s) => s.path !== draftPath),
    draftPath,
  };
}

export const useSessionStore = create<SessionStoreState>((set, get) => ({
  sessions: [],
  currentPath: null,
  currentCwd: "",
  chatOnlyCwd: "",
  draftTaskPath: null,
  loading: false,
  pendingPath: null,
  runningPaths: new Set<string>(),
  messagesByPath: new Map<string, Message[]>(),
  rejectedMessage: null,
  scheduledRuns: { tasks: [], runs: [], states: {} },

  load: async () => {
    set({ loading: true });
    try {
      const [sessions, workspaceCwd, chatOnlyCwd, scheduled] = await Promise.all([
        window.piDesk.listSessions(),
        window.piDesk.getCwd(),
        window.piDesk.getChatOnlyCwd(),
        window.piDesk
          .getScheduledTasks()
          .catch(() => ({ tasks: [], runs: [], states: {} })),
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
      // A draft task (「新建任务」clicked, first message not sent yet) is
      // invisible in the sidebar. It graduates the moment it hits disk —
      // sending the first message builds the unit and writes this exact path.
      const draft = filterDraftSession(sessions, get().draftTaskPath);
      let finalSessions = draft.sessions;
      let currentCwd = get().currentCwd;
      const persisted = current
        ? sessions.find((s) => s.path === current)
        : undefined;
      if (persisted) {
        // The file exists on disk: its header cwd is the source of truth.
        currentCwd = persisted.cwd;
      } else if (current && current !== draft.draftPath) {
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
        draftTaskPath: draft.draftPath,
        chatOnlyCwd,
        scheduledRuns: scheduled,
      });
    } catch (err) {
      console.error("Failed to load sessions:", err);
    } finally {
      set({ loading: false });
    }
  },

  refreshScheduledTasks: async () => {
    try {
      const scheduled = await window.piDesk.getScheduledTasks();
      set({ scheduledRuns: scheduled });
    } catch (err) {
      console.error("Failed to load scheduled tasks:", err);
    }
  },

  refreshSessions: async () => {
    try {
      const sessions = await window.piDesk.listSessions();
      // Same draft filtering as load(): an unsent task stays out of the list,
      // and a draft that just hit the disk (first message sent) graduates.
      const draft = filterDraftSession(sessions, get().draftTaskPath);
      let finalSessions = draft.sessions;
      // Preserve the FOCUSED session's in-memory entry when it isn't on disk
      // yet — e.g. a draft graduated by graduateDraft() whose .jsonl hasn't been
      // scanned by listAll() on this exact refresh. Without this, a
      // refreshSessions() fired right after the first prompt would briefly drop
      // the brand-new task from the sidebar until the next list reload.
      const cur = get().currentPath;
      if (cur && !finalSessions.some((s) => s.path === cur)) {
        const live = get().sessions.find((s) => s.path === cur);
        if (live) finalSessions = [live, ...finalSessions];
      }
      set({ sessions: finalSessions, draftTaskPath: draft.draftPath });
    } catch (err) {
      console.error("Failed to refresh sessions:", err);
    }
  },

  selectSession: async (path: string) => {
    const session = get().sessions.find((s) => s.path === path);
    // Never pass "" — the main process would try to build a unit for an empty
    // cwd and throw, turning the click into a silent no-op.
    const cwd =
      session?.cwd || useWorkspaceStore.getState().cwd || get().chatOnlyCwd;
    // Scheduled-task sessions are written externally (each run streams from an
    // isolated SDK session), so their unit copy can go stale. Always re-open
    // them from disk instead of letting switchSession short-circuit. A task now
    // owns one session per run — those are listed on run rows — plus the legacy
    // single accumulating session stamped directly on the task.
    const sched = get().scheduledRuns;
    const isScheduled =
      sched.runs.some((r) => r.sessionPath === path) ||
      sched.tasks.some((t) => t.sessionPath === path);
    await window.piDesk.switchSession(cwd, path, isScheduled);
    // Switching away abandons any unsent draft task (it never had a file, so
    // nothing is lost — the sidebar simply stays clean).
    set({ currentPath: path, currentCwd: cwd, draftTaskPath: null });
    // ALWAYS reload the full history from the main process. The buffer only
    // accumulates live events since subscription — for long-lived sessions
    // (IM / scheduled tasks) whose earlier turns happened before the desktop
    // app subscribed, the buffer alone would show only the recent tail.
    // session.messages includes any in-flight streaming message, so nothing
    // is lost; subsequent pi:event deltas keep appending on top.
    await reloadMessages(cwd);
    await get().load();
  },

  createNew: async (cwd?: string) => {
    let effectiveCwd = cwd ?? useWorkspaceStore.getState().cwd;
    // Task mode (no workspace chosen): give every new task its own timestamped
    // subdir under chatOnlyCwd so it lands in an independent runtime/unit and
    // can run in parallel with other tasks — instead of all sharing (and
    // aborting each other via) the single shared chat unit.
    let isTaskDraft = false;
    if (!effectiveCwd) {
      // No-op guard: if the FOCUSED session is already an empty task (created
      // by a previous click, never sent a message), reuse it instead of
      // stacking another empty placeholder entry in the sidebar.
      const st = get();
      const cur = st.currentPath;
      if (
        cur &&
        isTimestampedTaskCwd(st.currentCwd, st.chatOnlyCwd) &&
        (st.messagesByPath.get(cur)?.length ?? 0) === 0 &&
        !st.runningPaths.has(cur) &&
        !useAgentStore.getState().isStreaming
      ) {
        return;
      }
      effectiveCwd = newTaskCwd(st.chatOnlyCwd);
      isTaskDraft = true;
    }
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
      // Task mode with no workspace → this session is only a reserved
      // placeholder (no unit, no file). Mark it as a draft so the sidebar
      // stays empty until the first message is sent.
      draftTaskPath: isTaskDraft ? current : null,
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
    if (st?.commands) agent.setCommands(st.commands);
    await get().load();
  },

  createNewPending: async () => {
    const cwd = useWorkspaceStore.getState().cwd;
    // Same no-op guard as createNew: repeatedly clicking the nav-level new
    // task button must not stack empty task entries in the sidebar.
    if (!cwd) {
      const st = get();
      const cur = st.currentPath;
      if (
        cur &&
        isTimestampedTaskCwd(st.currentCwd, st.chatOnlyCwd) &&
        (st.messagesByPath.get(cur)?.length ?? 0) === 0 &&
        !st.runningPaths.has(cur) &&
        !useAgentStore.getState().isStreaming
      ) {
        return;
      }
    }
    // No workspace bound yet → timestamped chat task (independent unit).
    const effectiveCwd = cwd || newTaskCwd(get().chatOnlyCwd);
    const current = await window.piDesk.newSession(effectiveCwd);
    if (!current) return;
    // Entry ① semantics: the new task is NOT bound to a folder yet — mark it
    // pending so the sidebar shows it under「未分组」until the user picks a
    // workspace (or sends a message, which binds to the current workspace).
    // With no workspace it is also a DRAFT (placeholder only): it stays out of
    // the sidebar until the first message is sent.
    set({
      currentPath: current,
      currentCwd: effectiveCwd || "",
      pendingPath: current,
      draftTaskPath: cwd ? null : current,
    });
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
    if (st?.commands) agent.setCommands(st.commands);
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
      // Detach from the deleted session BEFORE creating the replacement:
      // createNew()'s no-op guard ("reuse the focused empty task") keys on
      // currentPath + an empty buffer, and we just cleared the buffer above —
      // so without this detach the guard would fire on the DELETED session
      // and return without ever refreshing the list, leaving the dead entry
      // visible in the sidebar until a manual reload.
      set({ currentPath: null, currentCwd: "", pendingPath: null });
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

  setDraftTaskPath: (path) => set({ draftTaskPath: path }),

  graduateDraft: (path) => {
    const st = get();
    if (!st.draftTaskPath || st.draftTaskPath !== path) return;
    const buffered = st.messagesByPath.get(path) ?? [];
    const firstUser = buffered.find((m) => m.role === "user");
    const text = firstUser ? String(firstUser.content ?? "").trim() : "";
    const entry: SessionInfo = {
      path,
      id: String(path).split(/[\\/]/).pop() ?? path,
      cwd: st.currentCwd,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount: buffered.length,
      firstMessage: text.slice(0, 200),
      allMessagesText: buffered
        .map((m) => String(m.content ?? ""))
        .join("\n")
        .slice(0, 4000),
    };
    set({
      draftTaskPath: null,
      // Sending binds the task to its cwd — drop the「待定」flag so the
      // composer's workspace pill stops showing 未绑定.
      pendingPath: st.pendingPath === path ? null : st.pendingPath,
      sessions: [entry, ...st.sessions.filter((s) => s.path !== path)],
    });
  },


  clearRejected: () => {
    set({ rejectedMessage: null });
  },

  setBuffer: (path, messages) => {
    if (!path) return;
    set((state) => {
      // Mutate in-place then create a new reference for Zustand.
      state.messagesByPath.set(path, messages);
      if (state.messagesByPath.size > MAX_BUFFERED_SESSIONS) {
        const cur = get().currentPath;
        for (const k of state.messagesByPath.keys()) {
          if (k !== cur) { state.messagesByPath.delete(k); break; }
        }
      }
      return { messagesByPath: new Map(state.messagesByPath) };
    });
  },

  mutateBuffer: (path, fn) => {
    if (!path) return;
    const state = get();
    const prev = state.messagesByPath.get(path) ?? [];
    const next = fn(prev);
    // Short-circuit: if the reducer returned the same reference, skip the
    // Map copy entirely (happens on empty streaming deltas).
    if (next === prev) {
      return;
    }
    // Mutate the existing Map in-place and trigger Zustand update via
    // a new reference. This avoids copying all entries on every token.
    state.messagesByPath.set(path, next);
    // Evict oldest non-current entry when the cap is exceeded
    if (state.messagesByPath.size > MAX_BUFFERED_SESSIONS) {
      const cur = state.currentPath;
      for (const k of state.messagesByPath.keys()) {
        if (k !== cur) { state.messagesByPath.delete(k); break; }
      }
    }
    set({ messagesByPath: new Map(state.messagesByPath) });
    // Mirror into the visible chat panel if this is the focused session.
    if (path === state.currentPath) {
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
