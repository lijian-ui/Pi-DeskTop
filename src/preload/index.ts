import { contextBridge, ipcRenderer } from "electron";
import type { ContextFilesConfig } from "./api";

// Pi-ready signaling: the main process sends "pi:ready" once the (slow,
// synchronous) SDK initialization completes. Buffer it so a late subscriber
// (e.g. a React effect that runs after the event already fired) still gets
// notified instead of waiting forever.
let piReadyFired = false;
const piReadyCallbacks: Array<() => void> = [];
ipcRenderer.on("pi:ready", () => {
  piReadyFired = true;
  const cbs = piReadyCallbacks.splice(0, piReadyCallbacks.length);
  for (const cb of cbs) cb();
});

const piAPI = {
  prompt: (text: string, images?: any[], cwd?: string, sessionPath?: string) =>
    ipcRenderer.invoke("pi:prompt", { text, images, cwd, sessionPath }),
  steer: (text: string, cwd?: string, sessionPath?: string) =>
    ipcRenderer.invoke("pi:steer", { text, cwd, sessionPath }),
  followUp: (text: string, cwd?: string, sessionPath?: string) =>
    ipcRenderer.invoke("pi:followUp", { text, cwd, sessionPath }),
  abort: (cwd?: string) =>
    ipcRenderer.invoke("pi:abort", { cwd }),

  // Bash guard (permission prototype)
  onBashApprovalRequest: (callback: (data: { requestId: number; command: string; cwd?: string; sessionPath?: string | null }) => void) => {
    const listener = (_: any, data: any) => callback(data);
    ipcRenderer.on("pi:bashApprovalRequest", listener);
    return () => ipcRenderer.removeListener("pi:bashApprovalRequest", listener);
  },
  respondBashApproval: (payload: { requestId: number; decision: "allow" | "deny" | "allow-session" }) =>
    ipcRenderer.invoke("pi:bashApprovalResponse", payload),
  setBashGuardMode: (mode: "yolo" | "ask") =>
    ipcRenderer.invoke("pi:setBashGuardMode", { mode }),
  getBashGuardConfig: () =>
    ipcRenderer.invoke("pi:getBashGuardConfig"),
  saveBashGuardConfig: (config: { blacklist: string[]; whitelist: string[] }) =>
    ipcRenderer.invoke("pi:saveBashGuardConfig", config),
  getCompactionConfig: () => ipcRenderer.invoke("pi:getCompactionConfig"),
  saveCompactionConfig: (config: {
    keepRecentTokens: number;
    reserveTokens: number;
    enabled: boolean;
  }) => ipcRenderer.invoke("pi:saveCompactionConfig", config),
  getSoul: () => ipcRenderer.invoke("pi:getSoul"),
  saveSoul: (text: string) => ipcRenderer.invoke("pi:saveSoul", text),

  setModel: (provider: string, modelId: string, cwd?: string) =>
    ipcRenderer.invoke("pi:setModel", { provider, modelId, cwd }),
  cycleModel: () => ipcRenderer.invoke("pi:cycleModel"),
  getAvailableModels: () => ipcRenderer.invoke("pi:getAvailableModels"),

  newSession: (cwd?: string) =>
    ipcRenderer.invoke("pi:newSession", { cwd }),
  switchSession: (cwd: string, sessionPath: string, force?: boolean) =>
    ipcRenderer.invoke("pi:switchSession", { cwd, sessionPath, force }),
  compact: (customInstructions?: string) =>
    ipcRenderer.invoke("pi:compact", { customInstructions }),

  getContextUsage: (cwd?: string) => ipcRenderer.invoke("pi:getContextUsage", { cwd }),
  getCacheStats: (cwd?: string) => ipcRenderer.invoke("pi:getCacheStats", { cwd }),

  // IM gateway (DingTalk etc.)
  imGetConfig: () => ipcRenderer.invoke("pi:imGetConfig"),
  imSaveConfig: (cfg: any) => ipcRenderer.invoke("pi:imSaveConfig", cfg),
  imGetStatus: () => ipcRenderer.invoke("pi:imGetStatus"),
  imIsSession: (sessionPath: string) =>
    ipcRenderer.invoke("pi:imIsSession", sessionPath),
  imMigrateSession: (sessionPath: string, newCwd: string) =>
    ipcRenderer.invoke("pi:imMigrateSession", { sessionPath, newCwd }),
  imMigrateChannelSessions: (instanceId: string) =>
    ipcRenderer.invoke("pi:imMigrateChannelSessions", instanceId),
  onImStatus: (callback: (s: Record<string, string>) => void) => {
    const listener = (_: unknown, s: Record<string, string>) => callback(s);
    ipcRenderer.on("pi:imStatus", listener);
    return () => ipcRenderer.removeListener("pi:imStatus", listener);
  },

  getState: (cwd?: string) => ipcRenderer.invoke("pi:getState", { cwd }),

  setApiKey: (providerId: string, apiKey: string) =>
    ipcRenderer.invoke("pi:setApiKey", { providerId, apiKey }),
  removeApiKey: (providerId: string) =>
    ipcRenderer.invoke("pi:removeApiKey", { providerId }),
  saveApiKey: (providerId: string, apiKey: string) =>
    ipcRenderer.invoke("pi:saveApiKey", { providerId, apiKey }),
  deleteApiKey: (providerId: string) =>
    ipcRenderer.invoke("pi:deleteApiKey", { providerId }),

  registerProvider: (providerId: string, config: any) =>
    ipcRenderer.invoke("pi:registerProvider", { providerId, config }),
  unregisterProvider: (providerId: string) =>
    ipcRenderer.invoke("pi:unregisterProvider", { providerId }),
  getRegisteredProviderIds: () =>
    ipcRenderer.invoke("pi:getRegisteredProviderIds"),

  getAllProviders: () => ipcRenderer.invoke("pi:getAllProviders"),
  getProviderAuthStatus: (providerId: string) =>
    ipcRenderer.invoke("pi:getProviderAuthStatus", { providerId }),

  listProvidersCatalog: () => ipcRenderer.invoke("pi:listProvidersCatalog"),
  getCustomModelsJson: () => ipcRenderer.invoke("pi:getCustomModelsJson"),
  saveCustomModelsJson: (data: Record<string, any>) =>
    ipcRenderer.invoke("pi:saveCustomModelsJson", { data }),

  saveCustomProvider: (providerId: string, config: any) =>
    ipcRenderer.invoke("pi:saveCustomProvider", { providerId, config }),
  deleteCustomProvider: (providerId: string) =>
    ipcRenderer.invoke("pi:deleteCustomProvider", { providerId }),
  deleteCustomModel: (providerId: string, modelId: string) =>
    ipcRenderer.invoke("pi:deleteCustomModel", { providerId, modelId }),

  listSessions: () => ipcRenderer.invoke("pi:listSessions"),
  getCurrentSession: (cwd?: string) => ipcRenderer.invoke("pi:getCurrentSession", { cwd }),
  exportSession: (sessionPath: string) =>
    ipcRenderer.invoke("pi:exportSession", { sessionPath }),
  renameSession: (sessionPath: string, name: string) =>
    ipcRenderer.invoke("pi:renameSession", { sessionPath, name }),
  deleteSession: (sessionPath: string) =>
    ipcRenderer.invoke("pi:deleteSession", { sessionPath }),

  // ── Scheduled tasks ──
  getScheduledTasks: () => ipcRenderer.invoke("pi:getScheduledTasks"),
  saveScheduledTask: (task: any) =>
    ipcRenderer.invoke("pi:saveScheduledTask", { task }),
  deleteScheduledTask: (taskId: string) =>
    ipcRenderer.invoke("pi:deleteScheduledTask", { taskId }),
  runScheduledTaskNow: (taskId: string) =>
    ipcRenderer.invoke("pi:runScheduledTaskNow", { taskId }),

  listSkills: () => ipcRenderer.invoke("pi:listSkills"),
  importSkill: () =>
    ipcRenderer.invoke("pi:importSkill"),
  readSkillFile: (filePath: string) =>
    ipcRenderer.invoke("pi:readSkillFile", { filePath }),
  setSkillEnabled: (filePath: string, enabled: boolean) =>
    ipcRenderer.invoke("pi:setSkillEnabled", { filePath, enabled }),
  deleteSkill: (filePath: string) =>
    ipcRenderer.invoke("pi:deleteSkill", { filePath }),

  getCwd: () => ipcRenderer.invoke("pi:getCwd"),
  setCwd: (cwd: string) =>
    ipcRenderer.invoke("pi:setCwd", { cwd }),
  pickWorkspace: () => ipcRenderer.invoke("pi:pickWorkspace"),
  getRecentWorkspaces: () => ipcRenderer.invoke("pi:getRecentWorkspaces"),
  getChatOnlyCwd: () => ipcRenderer.invoke("pi:getChatOnlyCwd"),
  bindSessionToWorkspace: (sessionPath: string, workspaceCwd: string) =>
    ipcRenderer.invoke("pi:bindSessionToWorkspace", { sessionPath, workspaceCwd }),

  // File / folder picker (for @ references)
  listDirectory: (dir?: string) =>
    ipcRenderer.invoke("pi:listDirectory", { dir }),
  // File preview (sidebar file manager)
  readFileForPreview: (filePath: string) =>
    ipcRenderer.invoke("pi:readFileForPreview", { filePath }),
  searchWorkspace: (query: string, maxResults?: number) =>
    ipcRenderer.invoke("pi:searchWorkspace", { query, maxResults }),

  onWorkspaceChanged: (callback: (data: { cwd: string; recents: string[] }) => void) => {
    const listener = (_: any, data: any) => callback(data);
    ipcRenderer.on("workspace:changed", listener);
    return () => ipcRenderer.removeListener("workspace:changed", listener);
  },

  onEvent: (callback: (event: any) => void) => {
    const listener = (_: any, event: any) => callback(event);
    ipcRenderer.on("pi:event", listener);
    return () => ipcRenderer.removeListener("pi:event", listener);
  },

  onRunningState: (callback: (state: { running: string[]; cwds: string[] }) => void) => {
    const listener = (_: any, state: any) => callback(state);
    ipcRenderer.on("pi:runningState", listener);
    return () => ipcRenderer.removeListener("pi:runningState", listener);
  },

  onRejected: (callback: (info: { reason: string; cwd: string; sessionPath?: string }) => void) => {
    const listener = (_: any, info: any) => callback(info);
    ipcRenderer.on("pi:rejected", listener);
    return () => ipcRenderer.removeListener("pi:rejected", listener);
  },

  onShowAbout: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("pi:showAbout", listener);
    return () => ipcRenderer.removeListener("pi:showAbout", listener);
  },

  // Open an external URL (GitHub repo, docs, …) in the OS default browser.
  openExternal: (url: string) => ipcRenderer.invoke("pi:openExternal", { url }),

  // App version (read from package.json via app.getVersion), used by the About dialog
  getAppVersion: () => ipcRenderer.invoke("pi:getAppVersion"),

  // Fired once the main process finishes SDK initialization. Safe to call at
  // any time — if the event already fired, the callback runs immediately.
  onReady: (callback: () => void) => {
    if (piReadyFired) {
      callback();
      return () => {};
    }
    piReadyCallbacks.push(callback);
    return () => {
      const i = piReadyCallbacks.indexOf(callback);
      if (i >= 0) piReadyCallbacks.splice(i, 1);
    };
  },

  // Active tools (assistant settings)
  getActiveTools: () => ipcRenderer.invoke("pi:getActiveTools"),
  saveActiveTools: (tools: string[]) =>
    ipcRenderer.invoke("pi:saveActiveTools", tools),

  // Context-file import toggles (规则与记忆 → 导入设置)
  getContextFilesConfig: () => ipcRenderer.invoke("pi:getContextFilesConfig"),
  setContextFilesConfig: (cfg: ContextFilesConfig) =>
    ipcRenderer.invoke("pi:setContextFilesConfig", cfg),

  // Rules (规则): single rules.md file
  getRulesContent: () => ipcRenderer.invoke("pi:getRulesContent"),
  saveRulesContent: (content: string) =>
    ipcRenderer.invoke("pi:saveRulesContent", content),
  deleteRulesFile: () => ipcRenderer.invoke("pi:deleteRulesFile"),

  // Pi Packages (扩展商店)
  searchPackages: (keyword?: string, from?: number, size?: number, category?: string) =>
    ipcRenderer.invoke("pi:searchPackages", { keyword, from, size, category }),
  getPackageDetail: (name: string) =>
    ipcRenderer.invoke("pi:getPackageDetail", { name }),
  getInstalledPackages: () => ipcRenderer.invoke("pi:getInstalledPackages"),
  installPackage: (source: string) =>
    ipcRenderer.invoke("pi:installPackage", { source }),
  removePackage: (source: string) =>
    ipcRenderer.invoke("pi:removePackage", { source }),
  checkPackageUpdates: () => ipcRenderer.invoke("pi:checkPackageUpdates"),
  updatePackage: (source: string) =>
    ipcRenderer.invoke("pi:updatePackage", { source }),

  // Auto-update (electron-updater, generic provider -> Gitee Releases)
  checkForUpdates: () => ipcRenderer.invoke("pi:checkForUpdates"),
  quitAndInstall: () => ipcRenderer.invoke("pi:quitAndInstall"),
  onUpdateState: (callback: (state: {
    status: string;
    version?: string;
    progress?: number;
    message?: string;
  }) => void) => {
    const listener = (_: any, state: any) => callback(state);
    ipcRenderer.on("pi:updateState", listener);
    return () => ipcRenderer.removeListener("pi:updateState", listener);
  },

  // Embedded terminal (node-pty in the main process)
  terminal: {
    create: (opts: {
      shell: "gitbash" | "powershell" | "cmd" | "zsh" | "bash";
      cwd: string;
      cols?: number;
      rows?: number;
    }) => ipcRenderer.invoke("pi:terminal:create", opts),
    input: (id: string, data: string) =>
      ipcRenderer.send("pi:terminal:input", { id, data }),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send("pi:terminal:resize", { id, cols, rows }),
    kill: (id: string) => ipcRenderer.invoke("pi:terminal:kill", { id }),
    getAvailableShells: () =>
      ipcRenderer.invoke("pi:terminal:availableShells") as Promise<
        ("gitbash" | "powershell" | "cmd" | "zsh" | "bash")[]
      >,
    getActive: () =>
      ipcRenderer.invoke("pi:terminal:getActive") as Promise<
        "gitbash" | "powershell" | "cmd" | "zsh" | "bash" | null
      >,
  },
  onTerminalOutput: (callback: (id: string, data: string) => void) => {
    const listener = (_: any, payload: any) => callback(payload.id, payload.data);
    ipcRenderer.on("pi:terminal:output", listener);
    return () => ipcRenderer.removeListener("pi:terminal:output", listener);
  },
  onTerminalExit: (callback: (id: string, exitCode: number) => void) => {
    const listener = (_: any, payload: any) => callback(payload.id, payload.exitCode);
    ipcRenderer.on("pi:terminal:exit", listener);
    return () => ipcRenderer.removeListener("pi:terminal:exit", listener);
  },
  onScheduledTaskStarted: (callback: (info: { taskId: string; sessionPath: string }) => void) => {
    const listener = (_: any, payload: any) => callback(payload);
    ipcRenderer.on("scheduledTask:started", listener);
    return () => ipcRenderer.removeListener("scheduledTask:started", listener);
  },
  onScheduledTaskCompleted: (callback: (info: { taskId: string; sessionPath: string }) => void) => {
    const listener = (_: any, payload: any) => callback(payload);
    ipcRenderer.on("scheduledTask:completed", listener);
    return () => ipcRenderer.removeListener("scheduledTask:completed", listener);
  },
};

contextBridge.exposeInMainWorld("piDesk", piAPI);
