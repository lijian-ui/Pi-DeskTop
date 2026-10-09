export interface PiDeskAPI {
  prompt(text: string, images?: any[], cwd?: string, sessionPath?: string): Promise<void>;
  steer(text: string, cwd?: string, sessionPath?: string): Promise<void>;
  followUp(text: string, cwd?: string, sessionPath?: string): Promise<void>;
  abort(cwd?: string, sessionPath?: string): Promise<void>;

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
    decision: "allow" | "deny" | "allow-session" | "allow-whitelist";
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
  // TTS
  getTtsConfig(): Promise<TtsConfig>;
  saveTtsConfig(cfg: TtsConfig): Promise<void>;
  ttsSynthesize(text: string): Promise<{ audioBase64: string; format: string }>;
  ttsSynthesizeStream(text: string, requestId: string): Promise<void>;
  onTtsChunk(callback: (data: { requestId: string; pcmBase64: string }) => void): () => void;
  onTtsDone(callback: (data: { requestId: string }) => void): () => void;
  setModel(provider: string, modelId: string, cwd?: string): Promise<void>;
  cycleModel(): Promise<void>;
  getThinkingLevels(cwd?: string): Promise<{
    current: string;
    available: string[];
    supports: boolean;
  }>;
  /** Resolves to the EFFECTIVE level (the SDK clamps unsupported requests). */
  setThinkingLevel(level: string, cwd?: string): Promise<string>;
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
  /** Latest todo-checklist snapshot for a session file, or null when the
   *  session has no checklist yet (replayed from the last tool result). */
  getTodoSnapshot(sessionPath: string): Promise<TodoSnapshot | null>;

  // ask_user_question — model-driven questionnaire answered in the renderer
  onAskUserPrompt(callback: (data: AskUserPromptPayload) => void): () => void;
  onAskUserClosed(callback: (data: AskUserClosedPayload) => void): () => void;
  /** Submit the user's answers (or cancel); false when the questionnaire was
   *  already settled (timed out / aborted / answered elsewhere). */
  answerAskUserQuestion(payload: AskUserAnswerPayload): Promise<boolean>;
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
  /** Start a WeChat QR login; resolves with the QR material + login id. */
  imWeixinStartLogin(): Promise<WeixinLoginStatus>;
  /** Poll the login snapshot (login runs in the main process). */
  imWeixinLoginStatus(loginId: string): Promise<WeixinLoginStatus | null>;
  /** Submit the pairing code shown on the phone when need_verifycode. */
  imWeixinSubmitVerifyCode(
    loginId: string,
    code: string,
  ): Promise<{ ok: boolean }>;
  imWeixinCancelLogin(loginId: string): Promise<{ ok: boolean }>;
  /** Start a QQ Bot QR binding; resolves with the QR material + login id. */
  imQqStartLogin(): Promise<QqLoginStatus>;
  /** Poll the QQ binding snapshot. */
  imQqLoginStatus(loginId: string): Promise<QqLoginStatus | null>;
  imQqCancelLogin(loginId: string): Promise<{ ok: boolean }>;
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
  /** Full transcript for a session (pre-compaction history included), for the
   *  chat panel history reload. Unlike getState().messages, this is NOT the
   *  compaction-aware LLM context and therefore retains the earliest messages. */
  getFullMessages(cwd?: string): Promise<any[]>;
  onEvent(callback: (event: any) => void): () => void;
  onRunningState(callback: (state: { running: string[]; cwds: string[] }) => void): () => void;
  onRejected(callback: (info: { reason: string; cwd: string; sessionPath?: string }) => void): () => void;
  /** Output of an extension slash command (ctx.ui.notify). Rendered as a
   *  dismissible notice card — extension commands have no other way to report. */
  onExtensionNotice(
    callback: (info: { message: string; type: "info" | "warning" | "error" }) => void,
  ): () => void;
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

  // Extension-tool features (设置 → 可用工具 → 扩展工具)
  getExtensionTools(): Promise<ExtensionToolFeature[]>;
  saveExtensionTools(updates: ExtensionToolFeatureUpdate[]): Promise<void>;

  // Chat-composer tool mode (极简/标准/办公) — session-scoped per cwd
  getSessionToolMode(cwd: string): Promise<ToolMode>;
  setSessionToolMode(cwd: string, mode: ToolMode): Promise<void>;

  // MCP servers (设置 → MCP)
  getMcpConfig(): Promise<McpConfigView>;
  saveMcpFeature(patch: McpFeaturePatch): Promise<void>;
  upsertMcpServer(payload: McpServerUpsert): Promise<void>;
  updateMcpServer(name: string, patch: McpServerPatch): Promise<void>;
  deleteMcpServer(name: string): Promise<void>;
  onMcpApprovalRequest(
    callback: (data: {
      requestId: number;
      server: string;
      cwd?: string;
      sessionPath?: string | null;
    }) => void
  ): () => void;
  respondMcpApproval(payload: {
    requestId: number;
    decision: "allow" | "deny" | "allow-session";
  }): Promise<void>;

  // Context-file import toggles (规则与记忆 → 导入设置)
  getContextFilesConfig(): Promise<ContextFilesConfig>;
  setContextFilesConfig(cfg: ContextFilesConfig): Promise<void>;

  // Rules (规则): single rules.md file
  getRulesContent(): Promise<string>;
  saveRulesContent(content: string): Promise<void>;
  deleteRulesFile(): Promise<void>;

  // ── Hermes 记忆浏览面板（可编辑）──
  listMemories(): Promise<MemoryView[]>;
  searchMemories(query: string): Promise<MemoryView[]>;
  updateMemory(
    id: number,
    content?: string,
    category?: string | null
  ): Promise<{ success: boolean; error?: string }>;
  deleteMemory(id: number): Promise<boolean>;
  setMemoryPinned(id: number, pinned: boolean): Promise<{ ok: boolean }>;
  resolveMemoryConflict(id: number): Promise<{ ok: boolean }>;
  getMemoryEpisodic(id: number, aroundCount?: number): Promise<EpisodicResult>;

  // ── 记忆库快照（7 天轮转 + 手动）──
  memorySnapshotNow(): Promise<SnapshotInfo>;
  memoryListSnapshots(): Promise<SnapshotInfo[]>;

  // ── 记忆功能配置（热重载生效）──
  getMemoryConfig(): Promise<MemoryConfigView>;
  saveMemoryConfig(patch: MemoryConfigPatch): Promise<{
    view: MemoryConfigView;
    hotReloaded: boolean;
  }>;

  // ── Web 搜索（web_search / web_fetch 工具）──
  getWebSearchConfig(): Promise<WebSearchConfig>;
  saveWebSearchConfig(cfg: WebSearchConfig): Promise<void>;
  testWebSearch(): Promise<WebSearchProviderTest[]>;

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
  /** Fetch the model ids a custom OpenAI-compatible endpoint exposes. */
  fetchRemoteModels(baseUrl: string, apiKey?: string): Promise<string[]>;

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
  // Lightweight stat for artifact cards
  statFile(filePath: string): Promise<{ size: number } | null>;
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

// Todo checklist shapes (shared with the main-process reducer).
export type { TodoSnapshot, TodoStatus, TodoTask } from "../shared/todo-types";

// ask_user_question questionnaire shapes (shared with the main-process tool).
export type {
  AskUserAnswer,
  AskUserAnswerPayload,
  AskUserClosedPayload,
  AskUserOption,
  AskUserPromptPayload,
  AskUserQuestion,
  AskUserResult,
} from "../shared/ask-user-types";

// Extension-tool feature shapes (设置 → 可用工具 → 扩展工具) + tool modes.
export type {
  ExtensionToolFeature,
  ExtensionToolFeatureUpdate,
  ToolMode,
} from "../shared/tool-catalog-types";

// MCP server shapes (设置 → MCP).
export type {
  McpConfigView,
  McpExposure,
  McpFeaturePatch,
  McpServerDef,
  McpServerPatch,
  McpServerUpsert,
  McpServerView,
} from "../shared/mcp-types";

import type { TodoSnapshot } from "../shared/todo-types";
import type { TaskSchedule, TaskStateMap } from "../shared/schedule";
import type {
  AskUserAnswerPayload,
  AskUserClosedPayload,
  AskUserPromptPayload,
} from "../shared/ask-user-types";
import type {
  ExtensionToolFeature,
  ExtensionToolFeatureUpdate,
  ToolMode,
} from "../shared/tool-catalog-types";
import type {
  McpConfigView,
  McpFeaturePatch,
  McpServerPatch,
  McpServerUpsert,
} from "../shared/mcp-types";

export interface ScheduledTask {
  id: string;
  name: string;
  enabled: boolean;
  cwd: string;
  prompt: string;
  rules: string;
  schedule: TaskSchedule;
  createdAt: string;
  /** Legacy accumulating session (older builds); new runs record their own path. */
  sessionPath?: string | null;
  /** Model the task runs with; null ⇒ follow the global default model. */
  model?: { provider: string; modelId: string } | null;
  /** Bash permission mode: "yolo" (auto-allow) or "ask" (block non-whitelist). */
  permissionMode?: "yolo" | "ask";
  /** Optional IM channel instance id to push the run result to after completion. */
  imPushInstanceId?: string;
}

export type RunStatus = "success" | "error" | "running";

/** 规则与记忆 → 导入设置：AGENTS.md / CLAUDE.md 上下文导入开关。 */
export interface ContextFilesConfig {
  agents: boolean;
  claude: boolean;
}

/** Web 搜索配置（与 src/main/websearch/config.ts 的 WebSearchConfig 对齐）。 */
export interface WebSearchProviderConfig {
  apiKey: string;
  enabled: boolean;
}
export interface WebSearchConfig {
  enabled: boolean;
  provider: "anysearch" | "tinyfish" | "tavily" | "bocha";
  searchProviders: Record<
    "anysearch" | "tinyfish" | "tavily" | "bocha",
    WebSearchProviderConfig
  >;
  fetchProvider: "anysearch" | "tinyfish" | "local" | "electron";
  resultCount: number;
  timeoutMs: number;
  fetchTimeoutMs: number;
  maxFetchChars: number;
  ssrfProtection: boolean;
  /** 用内置无头 Chromium 渲染 JS 重度页面（今日头条/公众号壳等）。 */
  electronRender: boolean;
  internalHostAllowlist: string[];
}
/** 连通性测试结果（设置页「测试」按钮）。 */
export interface WebSearchProviderTest {
  id: "anysearch" | "tinyfish" | "tavily" | "bocha";
  ok: boolean;
  backend?: string;
  error?: string;
}

/** IM 网关：渠道类型。 */
export type ImChannelType = "dingtalk" | "weixin" | "qq" | "feishu";

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
  /** When true, AI replies are also sent as voice messages (QQ + TTS). */
  ttsReply?: boolean;
  /** When true + ttsReply, only send voice (skip text reply). */
  ttsVoiceOnly?: boolean;
}

/** IM 网关配置（多渠道实例数组）。 */
export interface ImConfig {
  channels: ImChannelInstance[];
}

/** 微信扫码登录状态快照（主进程后台轮询，渲染层轮询本接口）。 */
export interface WeixinLoginStatus {
  loginId: string;
  status:
    | "running"
    | "wait"
    | "scaned"
    | "confirmed"
    | "expired"
    | "need_verifycode"
    | "verify_code_blocked"
    | "error"
    | "canceled";
  /** 二维码图片地址（<img> 直接显示）。 */
  qrcodeUrl: string;
  /** 二维码原始内容（备用链接，图片打不开时可用）。 */
  qrcode: string;
  message: string;
  /** status === "need_verifycode" 时为 true，UI 应弹出配对码输入。 */
  verifyCodeNeeded?: boolean;
  /** status === "confirmed" 时携带绑定凭证。 */
  credentials?: {
    token: string;
    botId: string;
    baseUrl: string;
    userId?: string;
  };
}

/** QQ 机器人扫码绑定状态快照（connector 后台轮询，渲染层轮询本接口）。 */
export interface QqLoginStatus {
  loginId: string;
  status: "running" | "confirmed" | "error" | "canceled";
  /** 二维码图片地址（<img> 直接显示）。 */
  qrcodeUrl: string;
  /** 二维码原始内容（备用链接）。 */
  qrcode: string;
  message: string;
  /** status === "confirmed" 时携带机器人凭证。 */
  credentials?: {
    appId: string;
    appSecret: string;
  };
}


export interface ScheduledTaskRun {
  /** Unique per run; also the identity of the run in the sidebar. */
  id: string;
  taskId: string;
  /** Conversation file this execution wrote (one fresh file per run). */
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
  /** Friendly channel label for custom OpenAI-compatible providers (optional). */
  channel?: string;
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
  /** 主进程权威快照：当前仍在生成中的会话路径（跨全部 cwd）。
   *  用于补上 pi:runningState 广播遗漏导致的停止按钮状态漂移。 */
  running?: string[];
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
  /** Friendly channel label (optional). */
  channel?: string;
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

/** TTS configuration item (one provider config). */
export interface TtsConfigItem {
  id: string;
  name: string;
  model: "mimo-v2.5-tts";
  apiKey: string;
  voice: string;
  style: string;
}

/** Top-level TTS config. */
export interface TtsConfig {
  configs: TtsConfigItem[];
  activeConfigId: string | null;
  streamEnabled: boolean;
}

/** 一条 Hermes 记忆（记忆浏览面板用，纯可序列化 DTO）。 */
export interface MemoryView {
  id: number;
  project: string | null;
  target: "memory" | "user" | "failure";
  category: string | null;
  content: string;
  failureReason: string | null;
  toolState: string | null;
  correctedTo: string | null;
  created: string;
  lastReferenced: string;
  /** 预计算的分词（ranking 用）。 */
  searchTokens: string;
  /** 被检索/引用次数，驱动衰减强化。 */
  accessCount: number;
  /** 是否已钉选为持久锚点。 */
  pinned: boolean;
  /** 该记忆沉淀自哪个会话（episodic 链），未知为 null。 */
  sourceSessionId: string | null;
  /** 与之词法冲突的另一条记忆 id（被标记时）。 */
  conflictWith: number | null;
  /** "flagged" 表示检测到冲突，待人工裁决；否则 null。 */
  conflictStatus: string | null;
}

/** 一条记忆的 episodic 回溯结果（原会话 + 原始消息切片）。 */
export interface EpisodicResult {
  sessionId: string | null;
  sessionProject: string | null;
  sessionCwd: string | null;
  messages: Array<{ role: string; content: string; timestamp: string }>;
  transcriptUnavailable: boolean;
}

/** 一份记忆库快照的元信息（7 天轮转）。 */
export interface SnapshotInfo {
  name: string;
  path: string;
  /** mtime（ms），作为快照创建时间。 */
  createdAt: number;
  size: number;
}

/** 记忆功能配置视图（纯可序列化，供设置面板渲染）。 */
export interface MemoryConfigView {
  // 自动沉淀（session flush）
  flushOnShutdown: boolean;
  flushOnCompact: boolean;
  flushMinTurns: number;
  flushRecentMessages: number;
  // 后台复习（background review）
  reviewEnabled: boolean;
  reviewRecentMessages: number;
  nudgeInterval: number;
  nudgeToolCalls: number;
  // 纠正检测
  correctionDetection: boolean;
  // 失败教训（两种模式都注入 —— 见 prompt-context.ts）
  failureInjectionEnabled: boolean;
  failureInjectionMaxAgeDays: number;
  failureInjectionMaxEntries: number;
  // 排序 / 时间衰减
  rankingEnabled: boolean;
  halfLifeDays: number;
  reinforcementFactor: number;
  /** 新记忆写入时的初始强化分（0 = 旧行为，永远不会自动涨到锚点）。 */
  initialAccessCount: number;
  /** 新记忆的衰减宽限天数，期内按满权重参与排序。 */
  decayGraceDays: number;
  // 锚点
  anchorsEnabled: boolean;
  minAccessCount: number;
  maxAnchors: number;
  // 守卫
  guardEnabled: boolean;
  guardSeverity: "block" | "warn";
  /** 运行中的 extension 是否可热重载（否则需重启 agent）。 */
  hotReloadAvailable: boolean;
}

/** 记忆配置的可写补丁（仅暴露核心记忆旋钮）。 */
export interface MemoryConfigPatch {
  flushOnShutdown?: boolean;
  flushOnCompact?: boolean;
  flushMinTurns?: number;
  flushRecentMessages?: number;
  reviewEnabled?: boolean;
  reviewRecentMessages?: number;
  nudgeInterval?: number;
  nudgeToolCalls?: number;
  correctionDetection?: boolean;
  failureInjection?: {
    enabled?: boolean;
    maxAgeDays?: number;
    maxEntries?: number;
  };
  ranking?: {
    enabled?: boolean;
    halfLifeDays?: number;
    reinforcementFactor?: number;
    initialAccessCount?: number;
    decayGraceDays?: number;
  };
  anchors?: {
    enabled?: boolean;
    minAccessCount?: number;
    maxAnchors?: number;
  };
  guard?: {
    enabled?: boolean;
    severity?: "block" | "warn";
  };
}

declare global {
  interface Window {
    piDesk: PiDeskAPI;
  }
}