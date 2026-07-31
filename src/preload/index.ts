import { contextBridge, ipcRenderer } from "electron";

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

  setModel: (provider: string, modelId: string) =>
    ipcRenderer.invoke("pi:setModel", { provider, modelId }),
  cycleModel: () => ipcRenderer.invoke("pi:cycleModel"),
  getAvailableModels: () => ipcRenderer.invoke("pi:getAvailableModels"),

  newSession: (cwd?: string) =>
    ipcRenderer.invoke("pi:newSession", { cwd }),
  switchSession: (cwd: string, sessionPath: string) =>
    ipcRenderer.invoke("pi:switchSession", { cwd, sessionPath }),
  compact: (customInstructions?: string) =>
    ipcRenderer.invoke("pi:compact", { customInstructions }),

  getContextUsage: () => ipcRenderer.invoke("pi:getContextUsage"),

  getState: (cwd?: string) => ipcRenderer.invoke("pi:getState", { cwd }),

  getProviders: () => ipcRenderer.invoke("pi:getProviders"),
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

  listSkills: () => ipcRenderer.invoke("pi:listSkills"),
  importSkill: () =>
    ipcRenderer.invoke("pi:importSkill"),
  readSkillFile: (filePath: string) =>
    ipcRenderer.invoke("pi:readSkillFile", { filePath }),

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
      shell: "gitbash" | "powershell" | "cmd";
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
        ("gitbash" | "powershell" | "cmd")[]
      >,
    getActive: () =>
      ipcRenderer.invoke("pi:terminal:getActive") as Promise<
        "gitbash" | "powershell" | "cmd" | null
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
};

contextBridge.exposeInMainWorld("piDesk", piAPI);
