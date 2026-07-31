export interface PiDeskAPI {
  prompt(text: string, images?: any[], cwd?: string, sessionPath?: string): Promise<void>;
  steer(text: string, cwd?: string, sessionPath?: string): Promise<void>;
  followUp(text: string, cwd?: string, sessionPath?: string): Promise<void>;
  abort(cwd?: string): Promise<void>;

  // Bash guard (permission prototype)
  onBashApprovalRequest(
    callback: (data: {
      requestId: number;
      command: string;
      cwd?: string;
      sessionPath?: string | null;
    }) => void
  ): () => void;
  respondBashApproval(payload: {
    requestId: number;
    decision: "allow" | "deny" | "allow-session";
  }): Promise<void>;
  setBashGuardMode(mode: "yolo" | "ask"): Promise<void>;
  getBashGuardConfig(): Promise<{ blacklist: string[]; whitelist: string[] }>;
  saveBashGuardConfig(config: { blacklist: string[]; whitelist: string[] }): Promise<void>;
  getCompactionConfig(): Promise<{ keepRecentTokens: number; reserveTokens: number; enabled: boolean }>;
  saveCompactionConfig(config: { keepRecentTokens: number; reserveTokens: number; enabled: boolean }): Promise<void>;
  getSoul(): Promise<string>;
  saveSoul(text: string): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  cycleModel(): Promise<void>;
  getAvailableModels(): Promise<any[]>;
  switchSession(cwd: string, sessionPath: string): Promise<void>;
  compact(
    customInstructions?: string
  ): Promise<
    | { ok: true }
    | {
        ok: false;
        reason: "too_small" | "already_compacted" | "unknown";
        message?: string;
      }
  >;
  getContextUsage(): Promise<
    | {
        tokens: number | null;
        contextWindow: number;
        percent: number | null;
      }
    | undefined
  >;
  getState(cwd?: string): Promise<AgentState | null>;
  onEvent(callback: (event: any) => void): () => void;
  onRunningState(callback: (state: { running: string[]; cwds: string[] }) => void): () => void;
  onRejected(callback: (info: { reason: string; cwd: string; sessionPath?: string }) => void): () => void;
  onShowAbout(callback: () => void): () => void;

  // Active tools (assistant settings)
  getActiveTools(): Promise<string[]>;
  saveActiveTools(tools: string[]): Promise<void>;

  // Auto-update (electron-updater, generic provider -> Gitee Releases)
  checkForUpdates(): Promise<{
    status: string;
    version?: string;
    progress?: number;
    message?: string;
  }>;
  quitAndInstall(): Promise<void>;
  onUpdateState(
    callback: (state: {
      status: string;
      version?: string;
      progress?: number;
      message?: string;
    }) => void
  ): () => void;

  // Provider management
  setApiKey(providerId: string, apiKey: string): Promise<void>;
  removeApiKey(providerId: string): Promise<void>;
  saveApiKey(providerId: string, apiKey: string): Promise<void>;
  deleteApiKey(providerId: string): Promise<void>;
  registerProvider(providerId: string, config: any): Promise<void>;
  unregisterProvider(providerId: string): Promise<void>;
  getRegisteredProviderIds(): Promise<string[]>;
  saveCustomProvider(providerId: string, config: any): Promise<void>;
  deleteCustomProvider(providerId: string): Promise<void>;
  deleteCustomModel(providerId: string, modelId: string): Promise<void>;
  getAllProviders(): Promise<ProviderInfo[]>;
  getProviderAuthStatus(providerId: string): Promise<AuthStatus | null>;

  listProvidersCatalog(): Promise<ProviderCatalog>;
  getCustomModelsJson(): Promise<Record<string, any>>;
  saveCustomModelsJson(data: Record<string, any>): Promise<void>;

  // Session management
  listSessions(): Promise<SessionInfo[]>;
  newSession(cwd?: string): Promise<string | null>;
  getCurrentSession(cwd?: string): Promise<string | null>;
  exportSession(sessionPath: string): Promise<string | null>;
  renameSession(sessionPath: string, name: string): Promise<void>;
  deleteSession(sessionPath: string): Promise<void>;

  // Skill management
  listSkills(): Promise<SkillInfo[]>;
  importSkill(): Promise<{ name?: string; error?: string } | null>;
  readSkillFile(filePath: string): Promise<string>;

  // Workspace (cwd) management
  getCwd(): Promise<string>;
  setCwd(cwd: string): Promise<string>;
  pickWorkspace(): Promise<string | null>;
  getRecentWorkspaces(): Promise<string[]>;
  getChatOnlyCwd(): Promise<string>;
  bindSessionToWorkspace(
    sessionPath: string,
    workspaceCwd: string
  ): Promise<{ newPath: string; cwd: string }>;
  onWorkspaceChanged(callback: (data: { cwd: string; recents: string[] }) => void): () => void;

  // Embedded terminal (node-pty in the main process)
  terminal: {
    create(opts: {
      shell: TerminalShell;
      cwd: string;
      cols?: number;
      rows?: number;
    }): Promise<{ id: string; pid: number }>;
    input(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    kill(id: string): Promise<void>;
    getAvailableShells(): Promise<TerminalShell[]>;
    getActive(): Promise<TerminalShell | null>;
  };
  onTerminalOutput(callback: (id: string, data: string) => void): () => void;
  onTerminalExit(callback: (id: string, exitCode: number) => void): () => void;

  // File / folder picker (for @ references)
  listDirectory(dir?: string): Promise<{
    entries: DirEntry[];
    truncated: boolean;
    error: string | null;
  }>;
  searchWorkspace(
    query: string,
    maxResults?: number
  ): Promise<{ results: { name: string; path: string; isDirectory: boolean }[] }>;

  // File preview (sidebar file manager → chat-area preview panel)
  readFileForPreview(filePath: string): Promise<FilePreviewResult>;
}

export type FilePreviewResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "image"; mime: string; base64: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "too-large"; size: number; limit: number }
  | { kind: "error"; error: string };

export interface ProviderInfo {
  id: string;
  name: string;
  baseUrl?: string;
  configured: boolean;
  authSource: string | null;
}

export interface AuthStatus {
  configured: boolean;
  source?: string;
  label?: string;
}

export interface AgentState {
  model: any | null;
  thinkingLevel: string;
  isStreaming: boolean;
  sessionId: string;
  messages: any[];
}

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

export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: "user" | "project" | "path";
  disableModelInvocation: boolean;
}

export interface ProviderCatalogItem {
  id: string;
  name: string;
  baseUrl?: string;
  modelCount: number;
  configured: boolean;
  authSource: string | null;
  models: CustomProviderModel[];
}

export interface CustomProviderModel {
  id: string;
  name?: string;
  reasoning?: boolean;
}

export interface CustomProviderItem {
  id: string;
  name: string;
  baseUrl?: string;
  api?: string;
  models: CustomProviderModel[];
}

export interface ProviderCatalog {
  apiKeyProviders: ProviderCatalogItem[];
  customProviders: CustomProviderItem[];
}

export type TerminalShell = "gitbash" | "powershell" | "cmd";

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
}

declare global {
  interface Window {
    piDesk: PiDeskAPI;
  }
}