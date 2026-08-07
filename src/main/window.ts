import { app, BrowserWindow, shell } from "electron";
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
      spellcheck: false,
    },
  });

  // Disable the native Chromium spell-checker so inputs don't show red squiggles.
  win.webContents.session.setSpellCheckerEnabled(false);

  // ── 外部链接一律交给系统默认浏览器 ──
  // target="_blank" / window.open（如详情页 npm/GitHub/主页链接、README 里的
  // 链接）不再打开应用内新窗口，而是走系统浏览器；并拒绝创建任何新窗口。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // 拦截应用内导航：同源（dev HMR 重载）放行，其余外部地址交系统浏览器。
  win.webContents.on("will-navigate", (event, url) => {
    try {
      const current = new URL(win.webContents.getURL());
      const target = new URL(url);
      if (target.origin === current.origin) return; // dev server / reload
    } catch {
      // fall through to block below
    }
    event.preventDefault();
    if (/^https?:/.test(url)) {
      shell.openExternal(url);
    }
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
