import { app, BrowserWindow } from "electron";
import { createMainWindow, setPiManager, disposePi, getPiManager } from "./window";
import { registerIpcHandlers, setPiManagerForHandlers } from "./ipc-handlers";
import { PiDeskSessionManager } from "./pi/session-manager";
import { TerminalManager } from "./pi/terminal-manager";
import { ImGateway, startGatewayFromConfig } from "./im/im-gateway";
import { setupApplicationMenu } from "./menu";
import { createTray } from "./tray";
import { setupAutoUpdater, disposeAutoUpdater } from "./app-updater";

let terminalManager: TerminalManager | null = null;
let imGateway: ImGateway | null = null;

/** Create + init the IM gateway (DingTalk etc.) bound to the pi manager. */
async function startImGateway(
  piManager: PiDeskSessionManager,
  win: BrowserWindow,
): Promise<void> {
  imGateway = new ImGateway(piManager);
  imGateway.onStatusChange((status) => {
    const wc = win.webContents;
    if (!wc.isDestroyed()) wc.send("pi:imStatus", status);
  });
  await imGateway.init();
  await startGatewayFromConfig(imGateway);
}

/** Expose the gateway for IPC handlers (module-level singleton access). */
export function getImGateway(): ImGateway | null {
  return imGateway;
}

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

  // Register IPC handlers BEFORE the (slow, synchronous) SDK init so renderer
  // process calls during startup hit a real handler instead of "No handler
  // registered". pmgr stays null until initialization completes below.
  registerIpcHandlers(mainWindow, terminalManager!);

  try {
    const piManager = new PiDeskSessionManager();
    await piManager.initialize();
    setPiManager(piManager);
    setPiManagerForHandlers(piManager);
    piManager.setEventTarget(mainWindow.webContents);
    // Start the IM gateway (DingTalk etc.) from persisted config.
    startImGateway(piManager, mainWindow).catch((err) =>
      console.error("IM gateway init failed:", err),
    );
    mainWindow.webContents.send("pi:ready");
  } catch (err) {
    console.error("Pi SDK initialization failed:", err);
    setPiManagerForHandlers(null);
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
