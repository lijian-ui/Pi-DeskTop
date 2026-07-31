import { app, BrowserWindow, Menu, nativeImage, Tray } from "electron";
import path from "path";

let tray: Tray | null = null;
let quitting = false;

/** Whether the app is in a genuine quit flow (vs. close-to-tray). */
export function isQuitting(): boolean {
  return quitting;
}

/** Set the quit flag and exit the app. The window close handler checks
 * `isQuitting()` — once set, the close event is no longer intercepted and the
 * window actually closes, letting the app terminate. */
export function requestQuit(): void {
  quitting = true;
  app.quit();
}

function showWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Resolve the window the tray should operate on. Prefers the live window —
 *  the fallback passed at creation may have been destroyed if the window was
 *  ever rebuilt (app "activate" path). */
function currentWindow(fallback: BrowserWindow): BrowserWindow {
  return BrowserWindow.getAllWindows()[0] ?? fallback;
}

/**
 * Create the system tray icon. Clicking X on the window only hides it (see
 * window.ts), so the tray is the way back in — click to restore, right-click
 * menu for 显示主窗口 / 退出.
 *
 * The icon is the Pi logo (resources/pi-logo.ico).
 */
export function createTray(win: BrowserWindow): void {
  if (tray) return;

  const iconPath = path.join(app.getAppPath(), "resources", "pi-logo.ico");
  const image = nativeImage.createFromPath(iconPath);
  if (!image.isEmpty()) {
    // Windows tray is small; scale the 64px source down for crispness.
    tray = new Tray(image.resize({ width: 16, height: 16 }));
  } else {
    tray = new Tray(nativeImage.createEmpty());
  }

  tray.setToolTip("Pi Desktop");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示主窗口", click: () => showWindow(currentWindow(win)) },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          requestQuit();
        },
      },
    ]),
  );

  // Windows: single left-click toggles the main window.
  tray.on("click", () => {
    const w = currentWindow(win);
    if (w.isVisible() && !w.isMinimized()) {
      w.hide();
    } else {
      showWindow(w);
    }
  });
}
