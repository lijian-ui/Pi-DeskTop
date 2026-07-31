import { app } from "electron";
import { createMainWindow, setPiManager, disposePi } from "./window";
import { registerIpcHandlers } from "./ipc-handlers";
import { PiDeskSessionManager } from "./pi/session-manager";
import { TerminalManager } from "./pi/terminal-manager";
import { setupApplicationMenu } from "./menu";
import { createTray } from "./tray";
import { setupAutoUpdater, disposeAutoUpdater } from "./app-updater";

app.whenReady().then(async () => {
  setupApplicationMenu();
  const mainWindow = createMainWindow();
  createTray(mainWindow);
  setupAutoUpdater(mainWindow);
  const terminalManager = new TerminalManager();
  terminalManager.setWebContents(mainWindow.webContents);

  try {
    const piManager = new PiDeskSessionManager();
    await piManager.initialize();
    setPiManager(piManager);
    piManager.setEventTarget(mainWindow.webContents);
    registerIpcHandlers(mainWindow, piManager, terminalManager);
  } catch (err) {
    console.error("Pi SDK initialization failed:", err);
    registerIpcHandlers(mainWindow, null, terminalManager);
  }
});

app.on("window-all-closed", () => {
  // 点 X 只是隐藏到托盘（close 被拦截），此事件只在真正退出流程
  // （托盘菜单「退出」→ requestQuit → app.quit）时触发。释放 SDK 资源即可，
  // 退出由 app.quit() 完成，这里不要再重复调用。
  disposeAutoUpdater();
  disposePi();
});

app.on("activate", () => {
  if (app.getAllWindows().length === 0) {
    const mainWindow = createMainWindow();
  }
});
