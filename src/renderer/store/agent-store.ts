import { create } from "zustand";
import type { CodeAttachment } from "./ui-store";

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
  model: any | null;
  thinkingLevel: string;
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
  setModel: (model: any) => void;
  setThinkingLevel: (level: string) => void;
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
  enqueueMessage: (content: string) => void;
  updateQueuedMessage: (id: string, content: string) => void;
  removeQueuedMessage: (id: string) => void;
  clearQueue: () => void;
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
  messageQueue: [],
  contextUsage: null,
  error: null,

  addMessage: (msg) =>
    set((state) => ({ messages: [...state.messages, msg] })),

  updateLastAssistant: (delta) =>
    set((state) => {
      const msgs = [...state.messages];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "assistant") {
          msgs[i] = { ...msgs[i], content: msgs[i].content + delta };
          break;
        }
      }
      return { messages: msgs };
    }),

  updateLastAssistantThinking: (delta) =>
    set((state) => {
      const msgs = [...state.messages];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "assistant") {
          msgs[i] = {
            ...msgs[i],
            thinking: (msgs[i].thinking ?? "") + delta,
          };
          break;
        }
      }
      return { messages: msgs };
    }),

  finishLastAssistant: (stoppedByUser = false) =>
    set((state) => {
      const msgs = [...state.messages];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "assistant" && msgs[i].isStreaming) {
          msgs[i] = {
            ...msgs[i],
            isStreaming: false,
            stoppedByUser: stoppedByUser ? true : msgs[i].stoppedByUser,
          };
          break;
        }
      }
      return { messages: msgs };
    }),

  addToolExecution: (tool) =>
    set((state) => {
      const msgs = [...state.messages];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "assistant") {
          const toolExecutions = [...(msgs[i].toolExecutions ?? []), tool];
          msgs[i] = { ...msgs[i], toolExecutions };
          break;
        }
      }
      return { messages: msgs };
    }),

  updateToolExecution: (id, update) =>
    set((state) => {
      const msgs = [...state.messages];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "assistant") {
          const toolExecutions = msgs[i].toolExecutions?.map((t) =>
            t.id === id ? { ...t, ...update } : t
          );
          msgs[i] = { ...msgs[i], toolExecutions };
          break;
        }
      }
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
  setContextUsage: (usage) => set({ contextUsage: usage }),
  clearMessages: () => set({ messages: [] }),
  setMessages: (messages) => set({ messages }),
  setError: (error) => set({ error }),

  // ── Message queue ──
  enqueueMessage: (content) =>
    set((state) => ({
      messageQueue: [
        ...state.messageQueue,
        { id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, content },
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