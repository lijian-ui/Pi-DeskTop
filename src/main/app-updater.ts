import { app, BrowserWindow, ipcMain, autoUpdater } from "electron";
import log from "electron-log/main";

// electron-updater 的 autoUpdater 需要 log 实例（否则打日志到 console 并警告）
// 这里用 electron-log 且限制 electron-updater 的日志级别，避免刷屏。
log.initialize();
log.transports.file.level = "info";

const UPDATE_CHECK_INTERVAL = 4 * 60 * 60 * 1000; // 4h
const UPDATE_CHECK_DELAY = 10 * 1000; // 启动后 10s 再查，避免和初始化抢资源

export interface UpdateState {
  status:
    | "idle"
    | "checking"
    | "available"
    | "not-available"
    | "downloading"
    | "downloaded"
    | "error";
  version?: string;
  progress?: number;
  message?: string;
}

let currentState: UpdateState = { status: "idle" };
let mainWindow: BrowserWindow | null = null;
let updateCheckTimer: NodeJS.Timeout | null = null;

/** Whether the current executable supports auto-update. In dev (electron .)
 * autoUpdater does not have a real update feed; only check in packaged builds. */
function canAutoUpdate(): boolean {
  return app.isPackaged;
}

function emitState(state: UpdateState): void {
  currentState = state;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("pi:updateState", state);
  }
}

function setAutoUpdaterEventHandlers(): void {
  autoUpdater.autoDownload = true; // 有新版自动下载，下载完提示重启安装

  autoUpdater.on("checking-for-update", () => {
    emitState({ status: "checking" });
  });

  autoUpdater.on("update-available", (info) => {
    emitState({ status: "available", version: info?.version });
  });

  autoUpdater.on("update-not-available", () => {
    emitState({ status: "not-available" });
  });

  autoUpdater.on("download-progress", (progressObj) => {
    emitState({
      status: "downloading",
      version: currentState.version,
      progress: progressObj.percent,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    emitState({ status: "downloaded", version: info?.version });
  });

  autoUpdater.on("error", (err) => {
    emitState({
      status: "error",
      message:
        typeof err === "string"
          ? err
          : (err?.message ?? "更新检查失败"),
    });
  });
}

/** Check for updates (manual trigger or on start). */
export async function checkForUpdates(): Promise<UpdateState> {
  if (!canAutoUpdate()) {
    emitState({ status: "error", message: "开发模式不支持自动更新" });
    return currentState;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (err: any) {
    emitState({
      status: "error",
      message: err?.message ?? "更新检查失败",
    });
  }
  return currentState;
}

/** Quit and install the downloaded update. */
export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}

export function setupAutoUpdater(win: BrowserWindow): void {
  mainWindow = win;

  setAutoUpdaterEventHandlers();

  // IPC: renderer -> main
  ipcMain.handle("pi:checkForUpdates", async () => {
    return await checkForUpdates();
  });
  ipcMain.handle("pi:quitAndInstall", () => {
    quitAndInstall();
  });

  // 启动后延迟检查一次，之后定时检查
  updateCheckTimer = setTimeout(() => {
    checkForUpdates().catch(() => {});
  }, UPDATE_CHECK_DELAY);
  const interval = setInterval(() => {
    checkForUpdates().catch(() => {});
  }, UPDATE_CHECK_INTERVAL);
  interval.unref();
}

/** Clean up timers (called on app quit). */
export function disposeAutoUpdater(): void {
  if (updateCheckTimer) clearTimeout(updateCheckTimer);
}
