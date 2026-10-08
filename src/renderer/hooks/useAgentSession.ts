import { useEffect, useRef } from "react";
import { useAgentStore, type Message, type Artifact } from "../store/agent-store";
import type { CodeAttachment } from "../store/ui-store";
import { useSessionStore } from "../store/session-store";
import { useWorkspaceStore } from "../store/workspace-store";
import { useTodoStore } from "../store/todo-store";
import { extractText, extractImages } from "../utils/content-utils";
import { resolveAgainstCwd } from "../utils/path-utils";
// Extraction logic is shared with the history-reload path (session-store →
// artifact-utils.hydrateArtifacts) so live events and reloaded sessions can
// never drift apart.
import { extractFilePath, SHELL_TOOLS, extractShellFileTargets } from "../utils/artifact-utils";

let msgCounter = 0;

/** Map a file path to a (best-effort) language id for a fenced code block. */
function langOf(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() || "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

// ── Shell-command candidates (live) ───────────────────────────────────
// While a turn streams we only remember which files each running shell call
// MIGHT write (tool_execution_start); on tool_execution_end they are
// stat()-verified and only the real files become artifacts.
/** toolCallId → candidate output paths written by that shell command. */
const shellTargetsByCall = new Map<string, string[]>();

/** Rebuild the fenced-block text sent to the LLM from a code attachment. */
function attachmentToText(a: CodeAttachment): string {
  if (a.kind === "terminal") {
    return `Terminal output:\n\`\`\`text\n${a.content}\n\`\`\``;
  }
  const lr = a.startLine === a.endLine ? `${a.startLine}` : `${a.startLine}-${a.endLine}`;
  return `${a.filePath}:${lr}\n\`\`\`${langOf(a.filePath)}\n${a.content}\n\`\`\``;
}

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
      // Only user / assistant / custom messages are renderable (see the Message
      // type). The SDK also emits `system` messages — it unshifts a system-prompt
      // section diff AHEAD of the user message on the first prompt (and whenever
      // the loadout changes) — plus `toolResult` messages. Buffering a `system`
      // one is what made the just-sent message render twice: it lands BETWEEN the
      // composer's optimistic user bubble and the SDK's real user message_start,
      // so the "last message is the user" dedup below no longer matches and the
      // user message is appended a second time (the empty system entry itself is
      // then dropped by isGhost, leaving two visible user bubbles). Drop any role
      // we can't render.
      if (role !== "user" && role !== "assistant" && role !== "custom") return msgs;
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
      // "custom"（扩展注入的可见消息，如死循环终止说明）一次性带全正文。
      let content = "";
      let images: Message["images"];
      if ((role === "user" || role === "custom") && ev.message?.content) {
        content = extractText(ev.message.content);
        if (role === "user") {
          const imgs = extractImages(ev.message.content, ev.messageId ?? `m${msgCounter}`);
          if (imgs.length) images = imgs;
        }
      }
      const newMsg = {
        id: ev.messageId ?? `msg-${++msgCounter}`,
        role,
        customType: role === "custom" ? ev.message?.customType : undefined,
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
        // Resolve the target file path now (args are only present at start)
        // so tool_execution_end — which carries no args — can attach it.
        filePath: extractFilePath(ev.toolName, ev.args) ?? undefined,
        isRunning: true,
        isError: false,
      };
      return msgs.map((m, i) =>
        i === msgs.length - 1 && m.role === "assistant"
          ? { ...m, toolExecutions: [...(m.toolExecutions ?? []), tool] }
          : m
      );
    }

    case "tool_execution_end": {
      // `ev` carries no args, but the matching tool stored its resolved path
      // at tool_execution_start — read it back from the tool object.
      return msgs.map((m, i) => {
        if (i !== msgs.length - 1 || m.role !== "assistant") return m;
        let addedPath: string | null = null;
        const toolExecutions = (m.toolExecutions ?? []).map((t: any) => {
          if (t.id !== ev.toolCallId) return t;
          addedPath = t.filePath ?? null;
          // SDK 工具返回 AgentToolResult：{ content: ContentBlock[], details, usage }
          // 从 content blocks 里抽取所有 type="text" 的 text 拼成 output，
          // 这样 ToolCard.read 分支才能拿到真正的文件内容（不是 JSON 包装）。
          let output: string;
          if (typeof ev.result === "string") {
            output = ev.result;
          } else if (
            ev.result &&
            typeof ev.result === "object" &&
            Array.isArray((ev.result as any).content)
          ) {
            output = (ev.result as any).content
              .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
              .map((b: any) => b.text)
              .join("\n");
            if (!output) output = JSON.stringify(ev.result, null, 2);
          } else {
            output = JSON.stringify(ev.result, null, 2);
          }
          return {
            ...t,
            output,
            isError: ev.isError ?? false,
            isRunning: false,
          };
        });
        const updated: Message = { ...m, toolExecutions };
        // Append artifact when a file-writing tool finishes without error.
        if (addedPath && !(ev.isError ?? false)) {
          const existing = new Set((m.artifacts ?? []).map((a) => a.filePath));
          if (!existing.has(addedPath)) {
            updated.artifacts = [...(m.artifacts ?? []), { filePath: addedPath, size: null }];
          }
        }
        return updated;
      });
    }

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
    const session = useSessionStore.getState();
    const path = session.currentPath;
    const cwd =
      session.sessions.find((x) => x.path === path)?.cwd ||
      session.currentCwd ||
      useWorkspaceStore.getState().cwd;
    // Optimistically insert the user bubble with structured attachments. Use
    // mutateBuffer (not addMessage) so the message enters messagesByPath —
    // otherwise the next SDK event overwrites agent-store.messages and loses
    // the attachments.
    const userMsg = {
      id: `user-${Date.now()}`,
      role: "user" as const,
      content: next.content,
      attachments: next.attachments,
      images: next.images,
      timestamp: Date.now(),
    };
    if (path) {
      session.mutateBuffer(path, (msgs) => [...msgs, userMsg]);
      // Same as the composer's send path: a draft task becomes visible the
      // moment its first message goes out.
      session.graduateDraft(path);
    } else {
      s.addMessage(userMsg);
    }
    // Forward the images that were staged when the message was queued —
    // otherwise a picture attached during streaming would be silently dropped.
    const images = next.images?.length
      ? next.images.map((a) => ({
          type: "image" as const,
          data: a.data,
          mimeType: a.mimeType,
        }))
      : undefined;
    // Rebuild the full payload (user text + expanded code references) sent to
    // the LLM. The user bubble only shows `next.content` + collapsible cards,
    // but the model still needs the literal source.
    const refsText = next.attachments?.map(attachmentToText).join("\n\n") ?? "";
    const fullBody = [next.content, refsText].filter(Boolean).join("\n\n");
    window.piDesk
      .prompt(fullBody, images, cwd, path ?? undefined)
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
        const focusedCwd = liveStore.currentCwd;
        // Only auto-follow a background streaming session when it lives in the
        // SAME cwd as the session the user is currently viewing — i.e. it is a
        // fork/continuation of the focused task. A genuinely separate task runs
        // in its own cwd (its own runtime/unit) and must NOT hijack focus:
        // otherwise clicking another task while one streams would keep yanking
        // the panel back to the running task and could lead to stopping the
        // wrong session. Background output is still accumulated (mutateBuffer
        // above) so switching to it later shows the full history.
        if (
          targetPath &&
          targetPath !== liveStore.currentPath &&
          payload?.cwd &&
          payload.cwd === focusedCwd &&
          (liveStore.messagesByPath.get(targetPath) ?? []).some(
            (m) => m.role === "assistant" && m.isStreaming,
          )
        ) {
          liveStore.setCurrentPath(targetPath);
          liveStore.syncFocus(targetPath);
        }
        if (ev.type === "message_end") {
          // Refresh the session list (debounced — a tool loop can end dozens
          // of messages in a burst) so counts / new sessions stay current.
          scheduleSessionListReload();
        }
        if (ev.type === "tool_execution_end" && ev.toolName === "todo" && !ev.isError) {
          // The model updated its checklist — pull the fresh snapshot (the
          // result's details were persisted with the session file, so a quick
          // IPC replay is authoritative) and auto-show the right-side panel
          // when this session is focused. No-op when nothing changed.
          void useTodoStore.getState().fetchTodo(targetPath);
        }
        // Shell commands: remember the files a command *might* write at start,
        // then confirm they really exist at end before attaching them. The
        // stat() round-trip is what makes the regex above safe to be loose —
        // anything that doesn't resolve to a real file is silently dropped.
        if (
          ev.type === "tool_execution_start" &&
          SHELL_TOOLS.has(String(ev.toolName ?? "").toLowerCase())
        ) {
          const cmd = ev.args?.command ?? ev.args?.cmd ?? ev.args?.script ?? "";
          const targets = extractShellFileTargets(cmd);
          if (targets.length) shellTargetsByCall.set(String(ev.toolCallId ?? ""), targets);
        }
        if (ev.type === "tool_execution_end" && !(ev.isError ?? false)) {
          const callId = String(ev.toolCallId ?? "");
          const targets = shellTargetsByCall.get(callId);
          if (targets) {
            shellTargetsByCall.delete(callId);
            const base = payload?.cwd || "";
            void Promise.all(
              targets.map((rel) => {
                const abs = resolveAgainstCwd(rel, base);
                return window.piDesk
                  .statFile(abs)
                  .then((s): Artifact | null =>
                    s?.size != null ? { filePath: abs, size: s.size } : null,
                  )
                  .catch(() => null);
              }),
            ).then((results) => {
              const found = results.filter((a): a is Artifact => a != null);
              if (!found.length) return;
              useSessionStore.getState().mutateBuffer(targetPath, (msgs) => {
                const i = msgs.length - 1;
                const last = msgs[i];
                if (!last || last.role !== "assistant") return msgs;
                const seen = new Set((last.artifacts ?? []).map((a) => a.filePath));
                const add = found.filter((a) => !seen.has(a.filePath));
                if (!add.length) return msgs;
                const next = [...msgs];
                next[i] = { ...last, artifacts: [...(last.artifacts ?? []), ...add] };
                return next;
              });
            });
          }
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
      const store = useSessionStore.getState();
      const running = state?.running ?? [];
      store.setRunningPaths(running);
      // A task-mode draft (「新建任务」clicked, first message not yet sent)
      // is hidden from the sidebar until its session file hits disk. The main
      // process writes that file during switchSession() INSIDE prompt(), which
      // runs BEFORE this running-state broadcast — so by now listSessions()
      // can discover it. If the FOCUSED session just started running but isn't
      // in the sidebar list yet (it was a draft graduated in-memory, or the
      // optimistic entry was dropped), refresh now so the task appears the
      // instant the user sends the first message — instead of waiting for the
      // whole turn to finish (message_end → load()).
      const cur = store.currentPath;
      if (cur && running.includes(cur) && !store.sessions.some((s) => s.path === cur)) {
        void store.refreshSessions();
      }
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
