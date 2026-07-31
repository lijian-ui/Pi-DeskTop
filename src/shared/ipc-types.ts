export interface PiDeskAPI {
  prompt(text: string, images?: any[]): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  cycleModel(): Promise<void>;
  getAvailableModels(): Promise<any[]>;
  newSession(cwd?: string): Promise<string | null>;
  switchSession(sessionPath: string): Promise<void>;
  compact(customInstructions?: string): Promise<void>;
  getState(): Promise<AgentState | null>;
  onEvent(callback: (event: any) => void): () => void;
  minimize(): Promise<void>;
  maximize(): Promise<void>;
  close(): Promise<void>;
}

export interface AgentState {
  model: any | null;
  thinkingLevel: string;
  isStreaming: boolean;
  sessionId: string;
  messages: any[];
}

export const IPC_CHANNELS = {
  PROMPT: "pi:prompt",
  STEER: "pi:steer",
  FOLLOW_UP: "pi:followUp",
  ABORT: "pi:abort",
  SET_MODEL: "pi:setModel",
  CYCLE_MODEL: "pi:cycleModel",
  GET_AVAILABLE_MODELS: "pi:getAvailableModels",
  NEW_SESSION: "pi:newSession",
  SWITCH_SESSION: "pi:switchSession",
  COMPACT: "pi:compact",
  GET_STATE: "pi:getState",
  EVENT: "pi:event",
} as const;