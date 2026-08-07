import { create } from "zustand";
import type { CodeAttachment, ImageAttachment } from "./ui-store";

export interface ToolExecution {
  id: string;
  toolName: string;
  input: any;
  output?: string;
  isError: boolean;
  isRunning: boolean;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Code references attached from the file-preview panel (rendered as cards). */
  attachments?: CodeAttachment[];
  /** Images sent along with this message (rendered as thumbnails). */
  images?: ImageAttachment[];
  thinking?: string;
  toolExecutions?: ToolExecution[];
  isStreaming?: boolean;
  /** Set when the user manually aborted this assistant message's generation. */
  stoppedByUser?: boolean;
  timestamp: number;
}

export interface QueuedMessage {
  id: string;
  content: string;
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
  enqueueMessage: (content: string, images?: ImageAttachment[]) => void;
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
  setModel: (model) => set({ model }),
  setThinkingLevel: (level) => set({ thinkingLevel: level }),
  setCommands: (commands) => set({ commands }),
  setContextUsage: (usage) => set({ contextUsage: usage }),
  clearMessages: () => set({ messages: [] }),
  setMessages: (messages) => set({ messages }),
  setError: (error) => set({ error }),

  // ── Message queue ──
  enqueueMessage: (content, images) =>
    set((state) => ({
      messageQueue: [
        ...state.messageQueue,
        {
          id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          content,
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
