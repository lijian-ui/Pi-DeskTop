import { app, BrowserWindow } from "electron";
import path from "path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { PiDeskSessionManager } from "./pi/session-manager";
import { isQuitting } from "./tray";

// 主进程以 ESM 形式打包（package.json 含 "type": "module"），
// __dirname/__filename 在 ESM 中不存在，这里用 import.meta.url 重建。
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let piManager: PiDeskSessionManager | null = null;

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Pi Desktop",
    icon: path.join(app.getAppPath(), "resources", "pi-logo.ico"),
    backgroundColor: "#1A1B1D",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once("ready-to-show", () => {
    win.show();
  });

  // Clicking the window's X hides it to the system tray instead of quitting.
  // Only a real quit (tray menu 退出 → requestQuit) lets the window close.
  win.on("close", (e) => {
    if (!isQuitting()) {
      e.preventDefault();
      win.hide();
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, "../index.html"));
  }

  return win;
}

export function setPiManager(manager: PiDeskSessionManager | null): void {
  piManager = manager;
}

export function getPiManager(): PiDeskSessionManager | null {
  return piManager;
}

export async function disposePi(): Promise<void> {
  piManager?.dispose();
  piManager = null;
}
