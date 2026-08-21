import { useEffect, useRef } from "react";
import { useAgentStore, type Message } from "../store/agent-store";
import { useSessionStore } from "../store/session-store";
import { useWorkspaceStore } from "../store/workspace-store";
import { extractText, extractImages } from "../utils/content-utils";

let msgCounter = 0;

/**
 * Debounced session-list refresh: every message_end previously triggered a
 * full load() (listSessions → main process re-reads EVERY session file header
 * for the sidebar). Rapid tool loops produce many message_end events in a row,
 * so batch them — the list only needs one refresh once the burst settles.
 */
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSessionListReload(): void {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    useSessionStore.getState().load();
  }, 1500);
}

/** Events that carry chat content — these are buffered per-session (including
 * for background sessions) so each conversation accumulates its full live
 * history independently. */
const CONTENT_EVENTS = new Set([
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_end",
]);

/**
 * Pure reducer: apply a content event to a session's buffered Message[] and
 * return the new array. Mirrors the previous in-session logic (dedup of empty
 * streaming ghosts / optimistic user messages, text/thinking deltas, tool
 * execution start/end) but operates on an arbitrary buffer instead of the
 * single global agent-store list.
 */
function reduceMessageEvent(msgs: Message[], ev: any): Message[] {
  switch (ev.type) {
    case "message_start": {
      // SDK emits { type:"message_start", message:{ role:"user", content:[...] } }
      // The role lives on ev.message.role, NOT on ev.role (which is always
      // undefined). Before the fix, every message_start was wrongly treated as
      // "assistant", so user messages were never rendered during streaming.
      const role = ev.message?.role ?? ev.role ?? (ev.userMessageEvent ? "user" : "assistant");
      // Dedup: the Pi SDK may fire multiple message_start events for the same
      // assistant turn (thinking init + content). If the last message is an
      // empty streaming assistant, reuse it instead of creating a duplicate.
      if (role === "assistant") {
        const last = msgs[msgs.length - 1];
        if (last?.role === "assistant" && !last.content.trim() && !last.thinking) {
          return msgs;
        }
      }
      // Also dedupe user messages: the composer adds the user msg optimistically
      // before calling prompt(), so ignore a later duplicate message_start.
      if (role === "user") {
        const last = msgs[msgs.length - 1];
        if (last?.role === "user") return msgs;
      }
      // Extract content: for user messages the full content is in the event;
      // for assistant messages it streams in via text_delta so start empty.
      let content = "";
      let images: Message["images"];
      if (role === "user" && ev.message?.content) {
        content = extractText(ev.message.content);
        const imgs = extractImages(ev.message.content, ev.messageId ?? `m${msgCounter}`);
        if (imgs.length) images = imgs;
      }
      const newMsg = {
        id: ev.messageId ?? `msg-${++msgCounter}`,
        role,
        content,
        images,
        isStreaming: role === "assistant",
        timestamp: Date.now(),
      };
      return [...msgs, newMsg];
    }

    case "message_update": {
      const delta = ev.assistantMessageEvent?.delta ?? ev.delta;
      const subType = ev.assistantMessageEvent?.type ?? ev.type;
      // Short-circuit empty deltas by returning the SAME array reference.
      // mutateBuffer → setMessages keeps the identical reference, so the
      // store notifies nothing and React bails out — zero re-render cost for
      // events that carry no visible content.
      if (typeof delta !== "string" || delta.length === 0) {
        return msgs;
      }
      if (subType === "text_delta") {
        const last = msgs[msgs.length - 1];
        return msgs.map((m, i) =>
          i === msgs.length - 1 && m.role === "assistant"
            ? { ...m, content: m.content + delta }
            : m
        );
      } else if (subType === "thinking_delta") {
        return msgs.map((m, i) =>
          i === msgs.length - 1 && m.role === "assistant"
            ? { ...m, thinking: (m.thinking ?? "") + delta }
            : m
        );
      }
      return msgs;
    }

    case "message_end": {
      const msg = ev.message;
      const last = msgs[msgs.length - 1];
      return msgs.map((m, i) =>
        i === msgs.length - 1 && m.role === "assistant" && m.isStreaming
          ? {
              ...m,
              isStreaming: false,
              stoppedByUser: msg?.stopReason === "aborted" ? true : m.stoppedByUser,
            }
          : m
      );
    }

    case "tool_execution_start": {
      const tool = {
        id: ev.toolCallId ?? `tool-${++msgCounter}`,
        toolName: ev.toolName ?? "unknown",
        input: ev.args,
        isRunning: true,
        isError: false,
      };
      return msgs.map((m, i) =>
        i === msgs.length - 1 && m.role === "assistant"
          ? { ...m, toolExecutions: [...(m.toolExecutions ?? []), tool] }
          : m
      );
    }

    case "tool_execution_end":
      return msgs.map((m, i) =>
        i === msgs.length - 1 && m.role === "assistant"
          ? {
              ...m,
              toolExecutions: (m.toolExecutions ?? []).map((t: any) =>
                t.id === ev.toolCallId
                  ? {
                      ...t,
                      output:
                        typeof ev.result === "string"
                          ? ev.result
                          : JSON.stringify(ev.result, null, 2),
                      isError: ev.isError ?? false,
                      isRunning: false,
                    }
                  : t
              ),
            }
          : m
      );

    default:
      return msgs;
  }
}

/** Send the next queued message (queued while a reply was streaming). Deferred
 * to a microtask so it runs after the current event dispatch settles.
 * The message is only removed from the queue AFTER prompt() succeeds; on
 * failure it is re-enqueued so the user's input is never silently lost. */
function drainQueue() {
  queueMicrotask(() => {
    const s = useAgentStore.getState();
    if (s.messageQueue.length === 0) return;
    const next = s.messageQueue[0];
    // Dequeue NOW: the message is in-flight — the queue panel must not keep
    // showing it while the LLM is already answering it (it previously only
    // vanished when the reply finished, so a 1-item queue lingered through
    // the whole reply). On failure we put it back at the head below.
    useAgentStore.getState().removeQueuedMessage(next.id);
    s.addMessage({
      id: `user-${Date.now()}`,
      role: "user",
      content: next.content,
      images: next.images,
      timestamp: Date.now(),
    });
    const session = useSessionStore.getState();
    const path = session.currentPath;
    const cwd =
      session.sessions.find((x) => x.path === path)?.cwd ||
      session.currentCwd ||
      useWorkspaceStore.getState().cwd;
    // Forward the images that were staged when the message was queued —
    // otherwise a picture attached during streaming would be silently dropped.
    const images = next.images?.length
      ? next.images.map((a) => ({
          type: "image" as const,
          data: a.data,
          mimeType: a.mimeType,
        }))
      : undefined;
    window.piDesk
      .prompt(next.content, images, cwd, path ?? undefined)
      .then(() => {
        // Already dequeued at send time — nothing to remove here.
      })
      .catch((err: any) => {
        // Failure — put the message BACK at the head of the queue (the
        // optimistic user bubble stays visible) so the user can retry or
        // edit it instead of losing their input silently.
        useAgentStore.setState((st) => ({
          messageQueue: [next, ...st.messageQueue],
        }));
        useAgentStore.getState().setError(err?.message ?? "Failed to send queued message");
      });
  });
}

export function useAgentSession() {
  const subscribedRef = useRef(false);

  useEffect(() => {
    if (subscribedRef.current) return;
    subscribedRef.current = true;

    const unsubscribe = window.piDesk.onEvent((payload: any) => {
      // Events are tagged with { sessionPath, cwd, event }. Content events are
      // always appended to the TARGET session's buffer — including background
      // sessions, so their streaming output is accumulated live and focusing
      // them later shows the complete history without a reload. State events
      // (streaming flag, compaction, retries, queue drain) only affect the
      // FOCUSED session's panel, so background ones are ignored.
      const ev = payload && payload.event ? payload.event : payload;
      const session = useSessionStore.getState();
      const focusedPath = session.currentPath;
      const targetPath = payload?.sessionPath || focusedPath || "";
      const isFocus =
        !payload?.sessionPath || payload?.sessionPath === focusedPath;

      if (CONTENT_EVENTS.has(ev.type)) {
        session.mutateBuffer(targetPath, (msgs) => reduceMessageEvent(msgs, ev));
        // The SDK may fork a continuation session file (a brand-new path) in
        // the middle of a long task, or a background session may start
        // streaming. When content flows into a session that is NOT the one the
        // chat panel is currently showing, follow it — otherwise the panel
        // stays pinned to the old session and shows a stuck "requesting"
        // placeholder while the real output accumulates in a background
        // buffer (it is only mirrored to the panel when path === currentPath).
        // Guard with the target session actually having a streaming assistant
        // message, so merely hovering over a finished background session never
        // yanks focus away from what the user is reading.
        const liveStore = useSessionStore.getState();
        if (targetPath && targetPath !== liveStore.currentPath) {
          const targetStreaming = (liveStore.messagesByPath.get(targetPath) ?? []).some(
            (m) => m.role === "assistant" && m.isStreaming,
          );
          if (targetStreaming) {
            liveStore.setCurrentPath(targetPath);
            liveStore.syncFocus(targetPath);
          }
        }
        if (ev.type === "message_end") {
          // Refresh the session list (debounced — a tool loop can end dozens
          // of messages in a burst) so counts / new sessions stay current.
          scheduleSessionListReload();
        }
        return;
      }

      if (!isFocus) return;

      const store = useAgentStore.getState();
      switch (ev.type) {
        case "agent_start":
          store.setStreaming(true);
          break;

        case "agent_end":
          store.setStreaming(false);
          break;

        case "compaction_start":
          store.setCompacting(true);
          break;

        case "compaction_end":
          store.setCompacting(false);
          if (ev.result) {
            const { summary, tokensBefore, estimatedTokensAfter } = ev.result;
            store.setCompactDone({ summary, tokensBefore, estimatedTokensAfter });
            // After compaction, getContextUsage() returns null tokens until the
            // next LLM reply. Use the SDK's post-compaction estimate so the ring
            // reflects the reduced usage immediately.
            const ctx = useAgentStore.getState();
            window.piDesk
              .getContextUsage()
              .then((u) => {
                if (u && u.contextWindow > 0 && typeof estimatedTokensAfter === "number") {
                  ctx.setContextUsage({
                    tokens: estimatedTokensAfter,
                    contextWindow: u.contextWindow,
                    percent: (estimatedTokensAfter / u.contextWindow) * 100,
                  });
                }
              })
              .catch(() => {});
          } else {
            store.clearCompactDone();
          }
          break;

        case "auto_retry_start":
          store.setRetrying(true);
          break;

        case "auto_retry_end":
          store.setRetrying(false);
          break;

        case "queue_update":
          break;

        case "agent_settled":
          store.setStreaming(false);
          drainQueue();
          break;
      }
    });

    window.piDesk.getState().then((state) => {
      if (state?.model) useAgentStore.getState().setModel(state.model);
      if (state?.thinkingLevel) useAgentStore.getState().setThinkingLevel(state.thinkingLevel);
      if (state?.commands) useAgentStore.getState().setCommands(state.commands);
    });

    // Track which sessions are currently running (one per busy cwd) so the
    // sidebar can show a spinner and the composer can show its stop button.
    const unsubRunning = window.piDesk.onRunningState((state: any) => {
      useSessionStore.getState().setRunningPaths(state?.running ?? []);
    });

    // A prompt was rejected by the main process (e.g. the target cwd already
    // has a task running). Surface it on the focused chat's error banner.
    const unsubRejected = window.piDesk.onRejected((info: any) => {
      if (info?.reason === "cwd-busy") {
        useAgentStore.getState().setError("该工作目录已有任务在运行，请等待当前任务完成后再试。");
      }
    });

    return () => {
      unsubscribe();
      unsubRunning();
      unsubRejected();
      subscribedRef.current = false;
    };
  }, []);
}
