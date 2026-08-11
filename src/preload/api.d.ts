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

  // ── Scheduled tasks ──
  getScheduledTasks(): Promise<ScheduledTasksData>;
  saveScheduledTask(task: ScheduledTask): Promise<void>;
  deleteScheduledTask(taskId: string): Promise<void>;
  runScheduledTaskNow(taskId: string): Promise<void>;
  onScheduledTaskStarted(
    callback: (info: { taskId: string; sessionPath: string }) => void
  ): () => void;
  onScheduledTaskCompleted(
    callback: (info: { taskId: string; sessionPath: string }) => void
  ): () => void;
  setModel(provider: string, modelId: string, cwd?: string): Promise<void>;
  cycleModel(): Promise<void>;
  getAvailableModels(): Promise<any[]>;
  switchSession(cwd: string, sessionPath: string, force?: boolean): Promise<void>;
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
  getContextUsage(cwd?: string): Promise<
    | {
        tokens: number | null;
        contextWindow: number;
        percent: number | null;
      }
    | undefined
  >;
  /** Cumulative prompt-cache waste for the focused session. */
  getCacheStats(cwd?: string): Promise<
    | {
        missedTokens: number;
        missedCost: number;
        missCount: number;
        cacheRead: number;
        cacheWrite: number;
        cacheMiss: number;
        ttlMs: number;
      }
    | undefined
  >;

  // ── IM gateway (DingTalk etc.) ──
  imGetConfig(): Promise<ImConfig>;
  imSaveConfig(cfg: ImConfig): Promise<{ ok: boolean; error?: string }>;
  imGetStatus(): Promise<Record<string, string>>;
  /** True when the session file belongs to an IM conversation. */
  imIsSession(sessionPath: string): Promise<boolean>;
  /** Migrate a single IM conversation to a new cwd (desktop workspace picker). */
  imMigrateSession(
    sessionPath: string,
    newCwd: string,
  ): Promise<{ ok: boolean; newPath?: string; error?: string }>;
  imMigrateChannelSessions(
    instanceId: string,
  ): Promise<{
    migrated: string[];
    skipped: string[];
    failed: { sessionKey: string; error: string }[];
  }>;
  onImStatus(callback: (s: Record<string, string>) => void): () => void;

  getState(cwd?: string): Promise<AgentState | null>;
  onEvent(callback: (event: any) => void): () => void;
  onRunningState(callback: (state: { running: string[]; cwds: string[] }) => void): () => void;
  onRejected(callback: (info: { reason: string; cwd: string; sessionPath?: string }) => void): () => void;
  onShowAbout(callback: () => void): () => void;
  /** Open an external http(s) URL in the OS default browser (main process). */
  openExternal(url: string): Promise<void>;
  /** App version read from package.json via app.getVersion(). */
  getAppVersion(): Promise<string>;
  /** Fired once the main process finishes SDK initialization. Safe to call at
   *  any time — if the event already fired, the callback runs immediately. */
  onReady(callback: () => void): () => void;

  // Active tools (assistant settings)
  getActiveTools(): Promise<string[]>;
  saveActiveTools(tools: string[]): Promise<void>;

  // Context-file import toggles (规则与记忆 → 导入设置)
  getContextFilesConfig(): Promise<ContextFilesConfig>;
  setContextFilesConfig(cfg: ContextFilesConfig): Promise<void>;

  // Rules (规则): single rules.md file
  getRulesContent(): Promise<string>;
  saveRulesContent(content: string): Promise<void>;
  deleteRulesFile(): Promise<void>;

  // Pi Packages (扩展商店)
  searchPackages(
    keyword?: string,
    from?: number,
    size?: number,
    category?: string,
  ): Promise<{
    ok: boolean;
    packages?: PiPackageInfo[];
    total?: number;
    error?: string;
  }>;
  getPackageDetail(name: string): Promise<{
    ok: boolean;
    detail?: PiPackageDetail;
    error?: string;
  }>;
  getInstalledPackages(): Promise<{
    ok: boolean;
    packages?: InstalledPackage[];
    error?: string;
  }>;
  installPackage(source: string): Promise<{ ok: boolean; message: string }>;
  removePackage(source: string): Promise<{ ok: boolean; message: string }>;
  checkPackageUpdates(): Promise<{
    ok: boolean;
    updates?: PackageUpdateInfo[];
    error?: string;
  }>;
  updatePackage(source: string): Promise<{ ok: boolean; message: string }>;

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
  setSkillEnabled(filePath: string, enabled: boolean): Promise<void>;
  deleteSkill(filePath: string): Promise<void>;

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

// Schedule shapes and the next-run computation live in src/shared/schedule so
// the renderer and the main process can never disagree on when a task fires.
export type {
  ScheduleType,
  CatchUpPolicy,
  TaskSchedule,
  TaskRuntimeState,
  TaskStateMap,
} from "../shared/schedule";

import type { TaskSchedule, TaskStateMap } from "../shared/schedule";

export interface ScheduledTask {
  id: string;
  name: string;
  enabled: boolean;
  cwd: string;
  prompt: string;
  rules: string;
  schedule: TaskSchedule;
  createdAt: string;
  /** Path to the task's single accumulating session; null until it has run. */
  sessionPath?: string | null;
  /** Model the task runs with; null ⇒ follow the global default model. */
  model?: { provider: string; modelId: string } | null;
  /** Bash permission mode: "yolo" (auto-allow) or "ask" (block non-whitelist). */
  permissionMode?: "yolo" | "ask";
}

export type RunStatus = "success" | "error" | "running";

/** 规则与记忆 → 导入设置：AGENTS.md / CLAUDE.md 上下文导入开关。 */
export interface ContextFilesConfig {
  agents: boolean;
  claude: boolean;
}

/** IM 网关：渠道类型。 */
export type ImChannelType = "dingtalk" | "weixin" | "qq";

/** IM 网关：一个已配置的渠道实例（一个机器人）。 */
export interface ImChannelInstance {
  id: string;
  name: string;
  type: ImChannelType;
  enabled: boolean;
  /** 渠道相关凭据（钉钉：clientId/clientSecret）。 */
  config: Record<string, string>;
  /** 可选默认工作区：该渠道的 IM 会话以该目录为 cwd。缺省 → chat/im/<channel>。 */
  cwd?: string;
}

/** IM 网关配置（多渠道实例数组）。 */
export interface ImConfig {
  channels: ImChannelInstance[];
}

/** 扩展商店：市场包（来自 npm registry 搜索）。 */
export interface PiPackageInfo {
  name: string;
  description: string;
  version: string;
  author: string;
  monthlyDownloads: number;
  updatedAt: string;
  repository: string;
  npmUrl: string;
  source: string;
  keywords: string[];
}

/** 扩展商店：已安装包。 */
export interface InstalledPackage {
  source: string;
  name: string;
  scope: "global" | "project";
}

/** 扩展商店：包详情（packument + 下载量 API，对标 pi.dev 详情页）。 */
export interface PiPackageDetail extends PiPackageInfo {
  license: string;
  publishedAt: string;
  unpackedSize: number;
  dependencyCount: number;
  peerDependencyCount: number;
  downloadsWeek: number;
  homepage: string;
  readme: string;
}

/** 扩展商店：可更新的包（SDK 对比已装版本 vs 最新）。 */
export interface PackageUpdateInfo {
  source: string;
  name: string;
  type: "npm" | "git";
  scope: "user" | "project";
}

export interface ScheduledTaskRun {
  /** Unique per run — one session accumulates many runs sharing sessionPath. */
  id: string;
  taskId: string;
  sessionPath: string;
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
}

export interface ScheduledTasksData {
  tasks: ScheduledTask[];
  runs: ScheduledTaskRun[];
  /** Scheduler bookkeeping keyed by task id (lastRunAt / nextRunAt / …). */
  states: TaskStateMap;
}

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
  /** 当前会话已注册的斜杠命令（内置 + 扩展），invocationName 即 /名称 */
  commands: Array<{ name: string; description: string }>;
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

export type TerminalShell = "gitbash" | "powershell" | "cmd" | "zsh" | "bash";

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