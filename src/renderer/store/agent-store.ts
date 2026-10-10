import { create } from "zustand";
import type { CodeAttachment, ImageAttachment } from "./ui-store";

export interface ToolExecution {
  id: string;
  toolName: string;
  input: any;
  output?: string;
  isError: boolean;
  isRunning: boolean;
  /** Resolved file path when this tool writes/edits a file (set at start). */
  filePath?: string;
}

/** A file produced by the LLM during this turn (written via Write/Edit/etc.). */
export interface Artifact {
  /** Absolute or workspace-relative file path. */
  filePath: string;
  /** File size in bytes; resolved lazily via stat after mount. */
  size: number | null;
}

export interface Message {
  id: string;
  /** "custom" = 扩展注入的可见消息（如死循环终止说明），不参与 LLM 上下文。 */
  role: "user" | "assistant" | "custom";
  /** 仅 role === "custom" 时存在：扩展声明的类型（如 "loop-guard"）。 */
  customType?: string;
  content: string;
  /** Code references attached from the file-preview panel (rendered as cards). */
  attachments?: CodeAttachment[];
  /** Images sent along with this message (rendered as thumbnails). */
  images?: ImageAttachment[];
  thinking?: string;
  toolExecutions?: ToolExecution[];
  /** Files produced by the LLM this turn (written / edited / created). */
  artifacts?: Artifact[];
  isStreaming?: boolean;
  /** Set when the user manually aborted this assistant message's generation. */
  stoppedByUser?: boolean;
  /**
   * 本轮请求失败时 SDK 给出的原因（`stopReason === "error"` 时由渲染层落库）。
   * SDK 在服务端失败时只标记 stopReason、不抛异常，没有这个字段界面就会
   * 完全静默（「请求中…」消失后既不回复也不报错）。
   */
  errorMessage?: string;
  /**
   * 本轮失败后 SDK 正在自动重试（`auto_retry_start` 已到达、`auto_retry_end` 尚未）。
   * 期间隐藏错误卡片与这条空消息——重试只是中间态，最终成败由 `auto_retry_end`
   * 决定；重试成功则本条永远保持隐藏，失败则清除标记让错误卡片重新出现。
   */
  retryPending?: boolean;
  timestamp: number;
}

export interface QueuedMessage {
  id: string;
  content: string;
  /** Code references staged with the queued message; forwarded when the queue
   *  drains so the user bubble can render them as collapsible cards. */
  attachments?: CodeAttachment[];
  /** Images staged with the queued message; forwarded when the queue drains. */
  images?: ImageAttachment[];
}

export interface ModelInfo {
  id: string;
  provider: string;
  name?: string;
  [key: string]: unknown;
}

interface AgentState {
  messages: Message[];
  isStreaming: boolean;
  isCompacting: boolean;
  compactDoneAt: number | null;
  compactSummary: string | null;
  compactTokensBefore: number | null;
  compactTokensAfter: number | null;
  isRetrying: boolean;
  /**
   * 已发出消息、尚未收到本会话任何事件（首次响应看门狗计时中）。
   * 用于在 `agent_start` 之前就显示「请求中…」，让用户明确知道消息**已发出**；
   * 超时无任何事件则由看门狗转为错误提示。
   */
  replyPending: boolean;
  /**
   * 正在自动重试的详情（`auto_retry_start` → `auto_retry_end` 之间）。
   * 之前只有布尔 `isRetrying` 且无人读取，界面上完全看不出"正在重试"，
   * 只能靠一张红卡片知道出事。这里带上尝试次数与原因供状态条展示。
   */
  retryInfo: { attempt: number; maxAttempts: number; delayMs: number; message: string } | null;
  model: ModelInfo | null;
  thinkingLevel: string;
  /** 当前会话已注册的斜杠命令（内置 /compact + 扩展包注册的 /命令）。 */
  commands: Array<{ name: string; description: string }>;
  /** Messages queued while a reply is still streaming; auto-sent in order once idle. */
  messageQueue: QueuedMessage[];
  contextUsage: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | null;
  error: string | null;

  addMessage: (msg: Message) => void;
  updateLastAssistant: (delta: string) => void;
  updateLastAssistantThinking: (delta: string) => void;
  finishLastAssistant: (stoppedByUser?: boolean) => void;
  addToolExecution: (tool: ToolExecution) => void;
  updateToolExecution: (id: string, update: Partial<ToolExecution>) => void;
  setStreaming: (v: boolean) => void;
  setCompacting: (v: boolean) => void;
  setCompactDone: (
    result: { summary: string; tokensBefore: number; estimatedTokensAfter?: number } | null
  ) => void;
  clearCompactDone: () => void;
  setRetrying: (v: boolean) => void;
  setRetryInfo: (info: { attempt: number; maxAttempts: number; delayMs: number; message: string } | null) => void;
  setReplyPending: (v: boolean) => void;
  setModel: (model: ModelInfo | null) => void;
  setThinkingLevel: (level: string) => void;
  setCommands: (commands: Array<{ name: string; description: string }>) => void;
  setContextUsage: (usage: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | null) => void;
  clearMessages: () => void;
  /** Replace the entire message list (used when switching focus to a session
   * whose history is already buffered in session-store.messagesByPath). */
  setMessages: (messages: Message[]) => void;
  setError: (error: string | null) => void;

  // ── Message queue (streaming-time send) ──
  enqueueMessage: (content: string, images?: ImageAttachment[], attachments?: CodeAttachment[]) => void;
  updateQueuedMessage: (id: string, content: string) => void;
  removeQueuedMessage: (id: string) => void;
  clearQueue: () => void;
}

/**
 * Find the index of the last assistant message. Returns -1 if none found.
 * Used to avoid O(n) reverse scan on every streaming token update.
 */
function findLastAssistantIndex(msgs: Message[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant") return i;
  }
  return -1;
}

export const useAgentStore = create<AgentState>((set) => ({
  messages: [],
  isStreaming: false,
  isCompacting: false,
  compactDoneAt: null,
  compactSummary: null,
  compactTokensBefore: null,
  compactTokensAfter: null,
  isRetrying: false,
  replyPending: false,
  retryInfo: null,
  model: null,
  thinkingLevel: "off",
  commands: [],
  messageQueue: [],
  contextUsage: null,
  error: null,

  addMessage: (msg) =>
    set((state) => ({ messages: [...state.messages, msg] })),

  updateLastAssistant: (delta) =>
    set((state) => {
      const idx = findLastAssistantIndex(state.messages);
      if (idx === -1) return state;
      const msgs = [...state.messages];
      msgs[idx] = { ...msgs[idx], content: msgs[idx].content + delta };
      return { messages: msgs };
    }),

  updateLastAssistantThinking: (delta) =>
    set((state) => {
      const idx = findLastAssistantIndex(state.messages);
      if (idx === -1) return state;
      const msgs = [...state.messages];
      msgs[idx] = {
        ...msgs[idx],
        thinking: (msgs[idx].thinking ?? "") + delta,
      };
      return { messages: msgs };
    }),

  finishLastAssistant: (stoppedByUser = false) =>
    set((state) => {
      const idx = findLastAssistantIndex(state.messages);
      if (idx === -1) return state;
      if (!state.messages[idx].isStreaming) return state;
      const msgs = [...state.messages];
      msgs[idx] = {
        ...msgs[idx],
        isStreaming: false,
        stoppedByUser: stoppedByUser ? true : msgs[idx].stoppedByUser,
      };
      return { messages: msgs };
    }),

  addToolExecution: (tool) =>
    set((state) => {
      const idx = findLastAssistantIndex(state.messages);
      if (idx === -1) return state;
      const msgs = [...state.messages];
      const toolExecutions = [...(msgs[idx].toolExecutions ?? []), tool];
      msgs[idx] = { ...msgs[idx], toolExecutions };
      return { messages: msgs };
    }),

  updateToolExecution: (id, update) =>
    set((state) => {
      const idx = findLastAssistantIndex(state.messages);
      if (idx === -1) return state;
      const toolExecutions = state.messages[idx].toolExecutions?.map((t) =>
        t.id === id ? { ...t, ...update } : t
      );
      if (toolExecutions === state.messages[idx].toolExecutions) return state;
      const msgs = [...state.messages];
      msgs[idx] = { ...msgs[idx], toolExecutions };
      return { messages: msgs };
    }),

  setStreaming: (v) => set({ isStreaming: v }),
  setCompacting: (v) => set({ isCompacting: v }),
  setCompactDone: (result) =>
    set({
      compactDoneAt: result ? Date.now() : null,
      compactSummary: result?.summary ?? null,
      compactTokensBefore: result?.tokensBefore ?? null,
      compactTokensAfter: result?.estimatedTokensAfter ?? null,
    }),
  clearCompactDone: () =>
    set({
      compactDoneAt: null,
      compactSummary: null,
      compactTokensBefore: null,
      compactTokensAfter: null,
    }),
  setRetrying: (v) => set({ isRetrying: v }),
  setRetryInfo: (info) => set({ retryInfo: info }),
  setReplyPending: (v) => set({ replyPending: v }),
  setModel: (model) => set({ model }),
  setThinkingLevel: (level) => set({ thinkingLevel: level }),
  setCommands: (commands) => set({ commands }),
  setContextUsage: (usage) => set({ contextUsage: usage }),
  clearMessages: () => set({ messages: [] }),
  setMessages: (messages) => set({ messages }),
  setError: (error) => set({ error }),

  // ── Message queue ──
  enqueueMessage: (content, images, attachments) =>
    set((state) => ({
      messageQueue: [
        ...state.messageQueue,
        {
          id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          content,
          attachments: attachments?.length ? attachments : undefined,
          images: images?.length ? images : undefined,
        },
      ],
    })),
  updateQueuedMessage: (id, content) =>
    set((state) => ({
      messageQueue: state.messageQueue.map((m) =>
        m.id === id ? { ...m, content } : m
      ),
    })),
  removeQueuedMessage: (id) =>
    set((state) => ({
      messageQueue: state.messageQueue.filter((m) => m.id !== id),
    })),
  clearQueue: () => set({ messageQueue: [] }),
}));
