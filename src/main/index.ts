import { app, BrowserWindow } from "electron";
import { createMainWindow, setPiManager, disposePi, getPiManager } from "./window";
import { registerIpcHandlers } from "./ipc-handlers";
import { PiDeskSessionManager } from "./pi/session-manager";
import { TerminalManager } from "./pi/terminal-manager";
import { setupApplicationMenu } from "./menu";
import { createTray } from "./tray";
import { setupAutoUpdater, disposeAutoUpdater } from "./app-updater";

let terminalManager: TerminalManager | null = null;

/** Point the terminal + Pi event streams at a (re)created window's WebContents.
 *  TerminalManager is a process-wide singleton so it survives window rebuilds. */
function bindEventTargets(mainWindow: BrowserWindow): void {
  terminalManager ??= new TerminalManager();
  terminalManager.setWebContents(mainWindow.webContents);
  getPiManager()?.setEventTarget(mainWindow.webContents);
}

app.whenReady().then(async () => {
  setupApplicationMenu();
  const mainWindow = createMainWindow();
  createTray(mainWindow);
  setupAutoUpdater();
  bindEventTargets(mainWindow);

  try {
    const piManager = new PiDeskSessionManager();
    await piManager.initialize();
    setPiManager(piManager);
    piManager.setEventTarget(mainWindow.webContents);
    registerIpcHandlers(mainWindow, piManager, terminalManager!);
  } catch (err) {
    console.error("Pi SDK initialization failed:", err);
    registerIpcHandlers(mainWindow, null, terminalManager!);
  }
});

app.on("window-all-closed", () => {
  // 点 X 只是隐藏到托盘（close 被拦截），此事件只在真正退出流程
  // （托盘菜单「退出」→ requestQuit → app.quit）时触发。释放 SDK 资源即可，
  // 退出由 app.quit() 完成，这里不要再重复调用。
  disposeAutoUpdater();
  void disposePi();
  terminalManager?.dispose();
  terminalManager = null;
});

app.on("activate", () => {
  const wins = BrowserWindow.getAllWindows();
  if (wins.length === 0) {
    // Window fully closed (edge path — close is normally intercepted to
    // hide-to-tray). Rebuild it AND re-attach the event targets, otherwise
    // streaming events and terminal output would never reach the new page.
    const mainWindow = createMainWindow();
    bindEventTargets(mainWindow);
  } else {
    wins[0].show();
  }
});
