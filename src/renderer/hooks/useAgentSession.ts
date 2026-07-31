import { useEffect, useRef } from "react";
import { useAgentStore, type Message } from "../store/agent-store";
import { useSessionStore } from "../store/session-store";
import { useWorkspaceStore } from "../store/workspace-store";

let msgCounter = 0;

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
      if (role === "user" && ev.message?.content) {
        if (typeof ev.message.content === "string") {
          content = ev.message.content;
        } else if (Array.isArray(ev.message.content)) {
          content = ev.message.content
            .filter((b: any) => b?.type === "text" && b.text)
            .map((b: any) => b.text)
            .join("\n");
        }
      }
      return [
        ...msgs,
        {
          id: ev.messageId ?? `msg-${++msgCounter}`,
          role,
          content,
          isStreaming: role === "assistant",
          timestamp: Date.now(),
        },
      ];
    }

    case "message_update":
      if (ev.assistantMessageEvent?.type === "text_delta") {
        return msgs.map((m, i) =>
          i === msgs.length - 1 && m.role === "assistant"
            ? { ...m, content: m.content + ev.assistantMessageEvent.delta }
            : m
        );
      } else if (ev.assistantMessageEvent?.type === "thinking_delta") {
        return msgs.map((m, i) =>
          i === msgs.length - 1 && m.role === "assistant"
            ? { ...m, thinking: (m.thinking ?? "") + ev.assistantMessageEvent.delta }
            : m
        );
      }
      return msgs;

    case "message_end": {
      const msg = ev.message;
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
 * to a microtask so it runs after the current event dispatch settles. */
function drainQueue() {
  queueMicrotask(() => {
    const s = useAgentStore.getState();
    if (s.messageQueue.length === 0) return;
    const next = s.messageQueue[0];
    s.removeQueuedMessage(next.id);
    s.addMessage({
      id: `user-${Date.now()}`,
      role: "user",
      content: next.content,
      timestamp: Date.now(),
    });
    const session = useSessionStore.getState();
    const path = session.currentPath;
    const cwd =
      session.sessions.find((x) => x.path === path)?.cwd ||
      session.currentCwd ||
      useWorkspaceStore.getState().cwd;
    window.piDesk
      .prompt(next.content, undefined, cwd, path ?? undefined)
      .catch((err: any) => {
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
      const isFocus = !payload?.sessionPath || payload.sessionPath === focusedPath;

      if (CONTENT_EVENTS.has(ev.type)) {
        session.mutateBuffer(targetPath, (msgs) => reduceMessageEvent(msgs, ev));
        if (ev.type === "message_end") {
          // Refresh the session list so message counts / new sessions stay current.
          useSessionStore.getState().load();
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
