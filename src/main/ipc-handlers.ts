import { app, ipcMain, dialog, BrowserWindow, shell } from "electron";
import { basename, extname, join } from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import type { PiDeskSessionManager } from "./pi/session-manager";
import type { TerminalManager } from "./pi/terminal-manager";

// Lazily-resolved Pi manager. registerIpcHandlers() is invoked BEFORE the SDK
// finishes initializing (so handlers exist from the first millisecond and the
// renderer never sees "No handler registered"), and the real manager is injected
// here once initialization completes. Using a module variable (instead of the
// old closure-captured `pmgr` parameter) avoids the stale-null pitfall:
// handlers registered with `null` would otherwise keep seeing `null` forever.
let pmgr: PiDeskSessionManager | null = null;

export function setPiManagerForHandlers(p: PiDeskSessionManager | null): void {
  pmgr = p;
}

/** Parent window for native dialogs. Prefers the live window — the window
 *  captured at registration time may have been destroyed and rebuilt (app
 *  "activate" edge path), and dialog.* silently fails on a destroyed parent. */
function dialogParent(mainWindow: BrowserWindow): BrowserWindow | undefined {
  if (!mainWindow.isDestroyed()) return mainWindow;
  return BrowserWindow.getAllWindows()[0];
}

export function registerIpcHandlers(
  mainWindow: BrowserWindow,
  terminalManager: TerminalManager
): void {
  pmgr = null;
  ipcMain.handle("pi:getAppVersion", () => app.getVersion());

  // Open an external URL in the OS default browser (e.g. GitHub repo, docs).
  // Renderer cannot do this safely on its own in Electron, so it asks the
  // main process which uses shell.openExternal.
  ipcMain.handle("pi:openExternal", async (_, { url }: { url: string }) => {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      throw new Error("Only http(s) URLs can be opened externally");
    }
    await shell.openExternal(url);
  });
  ipcMain.handle("pi:prompt", async (_, { text, images, cwd, sessionPath }) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    await pmgr.prompt(text, images, cwd, sessionPath);
  });

  ipcMain.handle("pi:steer", async (_, { text, cwd, sessionPath }) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    await pmgr.steer(text, cwd, sessionPath);
  });

  ipcMain.handle("pi:followUp", async (_, { text, cwd, sessionPath }) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    await pmgr.followUp(text, cwd, sessionPath);
  });

  ipcMain.handle("pi:abort", async (_, { cwd }) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    await pmgr.abort(cwd);
  });

  // ── Bash guard (permission prototype) ──
  ipcMain.handle("pi:bashApprovalResponse", async (_, { requestId, decision }) => {
    pmgr?.handleBashApprovalResponse({ requestId, decision });
  });

  ipcMain.handle("pi:setBashGuardMode", async (_, { mode }) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    pmgr.setBashGuardMode(mode);
  });

  ipcMain.handle("pi:getBashGuardConfig", async () => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    return pmgr.getBashGuardConfig();
  });

  ipcMain.handle("pi:saveBashGuardConfig", async (_, config) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    await pmgr.saveBashGuardConfig(config);
  });

  ipcMain.handle("pi:getCompactionConfig", async () => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    return pmgr.getCompactionConfig();
  });

  ipcMain.handle("pi:saveCompactionConfig", async (_, config) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    await pmgr.saveCompactionConfig(config);
  });

  // ── Soul / persona (assistant settings) ──
  ipcMain.handle("pi:getSoul", async () => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    return pmgr.getSoul();
  });

  ipcMain.handle("pi:saveSoul", async (_, text) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    await pmgr.saveSoul(text);
  });

  // ── Active tools (assistant settings) ──
  ipcMain.handle("pi:getActiveTools", async () => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    return pmgr.getActiveTools();
  });

  ipcMain.handle("pi:saveActiveTools", async (_, tools: string[]) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    await pmgr.saveActiveTools(tools);
  });

  ipcMain.handle("pi:setModel", async (_, { provider, modelId }) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    await pmgr.setModel(provider, modelId);
  });

  ipcMain.handle("pi:cycleModel", async () => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    await pmgr.cycleModel();
  });

  ipcMain.handle("pi:getAvailableModels", async () => {
    if (!pmgr) return [];
    return await pmgr.getAvailableModels();
  });

  ipcMain.handle("pi:newSession", async (_, { cwd }) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    return await pmgr.newSession(cwd);
  });

  ipcMain.handle("pi:switchSession", async (_, { cwd, sessionPath }) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    await pmgr.switchSession(cwd, sessionPath);
  });

  ipcMain.handle("pi:compact", async (_, { customInstructions }) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    return await pmgr.compact(customInstructions);
  });

  ipcMain.handle("pi:getContextUsage", async () => {
    if (!pmgr) return undefined;
    return pmgr.getContextUsage();
  });

  ipcMain.handle("pi:getState", async (_, { cwd }) => {
    if (!pmgr) return null;
    return pmgr.getState(cwd);
  });

  ipcMain.handle("pi:setApiKey", async (_, { providerId, apiKey }) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    const mr = pmgr.getModelRuntime();
    if (!mr) throw new Error("ModelRuntime not available");
    await mr.setRuntimeApiKey(providerId, apiKey);
  });

  ipcMain.handle("pi:removeApiKey", async (_, { providerId }) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    const mr = pmgr.getModelRuntime();
    if (!mr) throw new Error("ModelRuntime not available");
    await mr.removeRuntimeApiKey(providerId);
  });

  ipcMain.handle("pi:saveApiKey", async (_, { providerId, apiKey }) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    await pmgr.saveApiKey(providerId, apiKey);
  });

  ipcMain.handle("pi:deleteApiKey", async (_, { providerId }) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    await pmgr.deleteApiKey(providerId);
  });

  ipcMain.handle("pi:registerProvider", async (_, { providerId, config }) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    const mr = pmgr.getModelRuntime();
    if (!mr) throw new Error("ModelRuntime not available");
    mr.registerProvider(providerId, config);
  });

  ipcMain.handle("pi:unregisterProvider", async (_, { providerId }) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    const mr = pmgr.getModelRuntime();
    if (!mr) throw new Error("ModelRuntime not available");
    mr.unregisterProvider(providerId);
  });

  ipcMain.handle("pi:getRegisteredProviderIds", async () => {
    if (!pmgr) return [];
    const mr = pmgr.getModelRuntime();
    if (!mr) return [];
    return mr.getRegisteredProviderIds();
  });

  ipcMain.handle("pi:getProviderAuthStatus", async (_, { providerId }) => {
    if (!pmgr) return null;
    const mr = pmgr.getModelRuntime();
    if (!mr) return null;
    return mr.getProviderAuthStatus(providerId);
  });

  ipcMain.handle("pi:getAllProviders", async () => {
    if (!pmgr) return [];
    return pmgr.getAllProvidersInfo();
  });

  ipcMain.handle("pi:listProvidersCatalog", async () => {
    if (!pmgr) return { apiKeyProviders: [], customProviders: [] };
    return pmgr.getProvidersCatalog();
  });

  ipcMain.handle("pi:getCustomModelsJson", async () => {
    if (!pmgr) return {};
    return pmgr.getCustomModelsJson();
  });

  ipcMain.handle("pi:saveCustomModelsJson", async (_, { data }) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    await pmgr.saveCustomModelsJson(data ?? {});
  });

  ipcMain.handle("pi:saveCustomProvider", async (_, { providerId, config }) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    await pmgr.saveCustomProvider(providerId, config);
  });

  ipcMain.handle("pi:deleteCustomProvider", async (_, { providerId }) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    await pmgr.deleteCustomProvider(providerId);
  });

  ipcMain.handle("pi:deleteCustomModel", async (_, { providerId, modelId }) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    await pmgr.deleteCustomModel(providerId, modelId);
  });

  // ── Session management ──
  ipcMain.handle("pi:listSessions", async () => {
    if (!pmgr) return [];
    return pmgr.listSessions();
  });

  ipcMain.handle("pi:getCurrentSession", async (_, args) => {
    if (!pmgr) return null;
    return pmgr.getCurrentSessionPath(args?.cwd) ?? null;
  });

  ipcMain.handle("pi:exportSession", async (_, { sessionPath }) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    const defaultName = `${basename(String(sessionPath)).replace(/\.jsonl$/i, "")}.html`;
    const { canceled, filePath } = await dialog.showSaveDialog(dialogParent(mainWindow)!, {
      title: "Export session as HTML",
      defaultPath: defaultName,
      filters: [{ name: "HTML", extensions: ["html"] }],
    });
    if (canceled || !filePath) return null;
    return await pmgr.exportSessionHtml(String(sessionPath), filePath);
  });

  ipcMain.handle("pi:renameSession", async (_, { sessionPath, name }) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    await pmgr.renameSession(String(sessionPath), String(name));
  });

  ipcMain.handle("pi:deleteSession", async (_, { sessionPath }) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    await pmgr.deleteSession(String(sessionPath));
  });

  // ── Skill management ──
  ipcMain.handle("pi:listSkills", async () => {
    if (!pmgr) return [];
    return pmgr.listSkills();
  });

  ipcMain.handle("pi:importSkill", async () => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    const { canceled, filePaths } = await dialog.showOpenDialog(dialogParent(mainWindow)!, {
      title: "Import skill (.zip)",
      properties: ["openFile"],
      filters: [{ name: "Skill Zip", extensions: ["zip"] }],
    });
    if (canceled || filePaths.length === 0) return null;
    return await pmgr.importSkillZip(filePaths[0]);
  });

  ipcMain.handle("pi:readSkillFile", async (_, { filePath }) => {
    if (!filePath || typeof filePath !== "string") {
      throw new Error("Invalid skill file path");
    }
    // The path always originates from our own listSkills() output (SKILL.md
    // located inside a scanned skills dir), so reading it is safe.
    const content = await readFile(String(filePath), "utf-8");
    return content;
  });

  // ── Workspace (cwd) management ──
  ipcMain.handle("pi:getCwd", async () => {
    if (!pmgr) return process.cwd();
    return pmgr.getCwd();
  });

  // ── File / folder picker (for @ references) ──
  // Returns ONE level of a directory (lazy expansion: the tree only loads a
  // subdirectory's children when the user expands it, so we never walk a huge
  // tree up front). Directories are sorted first, then files. Capped at
  // MAX_ENTRIES so a giant flat dir (e.g. node_modules) can't choke the UI.
  ipcMain.handle("pi:listDirectory", async (_, { dir }: { dir?: string }) => {
    const base =
      dir && dir.trim()
        ? dir
        : pmgr
          ? pmgr.getCwd()
          : process.cwd();
    let dirents;
    try {
      dirents = await readdir(base, { withFileTypes: true });
    } catch (err) {
      return { entries: [], truncated: false, error: String(err) };
    }
    let entries = dirents.map((d) => ({
      name: d.name,
      path: join(base, d.name),
      isDirectory: d.isDirectory(),
      isSymlink: d.isSymbolicLink(),
    }));
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    const MAX_ENTRIES = 1000;
    const truncated = entries.length > MAX_ENTRIES;
    if (truncated) entries = entries.slice(0, MAX_ENTRIES);
    return { entries, truncated, error: null };
  });

  // ── File preview (sidebar file manager → chat-area preview panel) ──
  // Reads a single file with guards: size cap (1MB text), binary sniffing and
  // image detection. Images come back base64-encoded for an <img> data URL;
  // other binaries are refused (kind: "binary").
  ipcMain.handle("pi:readFileForPreview", async (_, { filePath }: { filePath: string }) => {
    if (!filePath || typeof filePath !== "string") {
      return { kind: "error", error: "Invalid file path" };
    }
    const MAX_TEXT_SIZE = 1024 * 1024; // 1MB
    const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
    const IMAGE_EXTS: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
      ".ico": "image/x-icon",
      ".svg": "image/svg+xml",
    };
    try {
      const st = await stat(filePath);
      if (!st.isFile()) return { kind: "error", error: "Not a file" };
      const ext = extname(filePath).toLowerCase();
      const mime = IMAGE_EXTS[ext];
      if (mime) {
        if (st.size > MAX_IMAGE_SIZE) {
          return { kind: "too-large", size: st.size, limit: MAX_IMAGE_SIZE };
        }
        const buf = await readFile(filePath);
        return { kind: "image", mime, base64: buf.toString("base64"), size: st.size };
      }
      if (st.size > MAX_TEXT_SIZE) {
        return { kind: "too-large", size: st.size, limit: MAX_TEXT_SIZE };
      }
      const buf = await readFile(filePath);
      // Binary sniff: a NUL byte in the first 8KB almost certainly means the
      // file is not text (same heuristic git uses).
      const sniffLen = Math.min(buf.length, 8192);
      for (let i = 0; i < sniffLen; i++) {
        if (buf[i] === 0) return { kind: "binary", size: st.size };
      }
      return { kind: "text", content: buf.toString("utf-8"), size: st.size };
    } catch (err) {
      return { kind: "error", error: String(err) };
    }
  });

  // Bounded recursive search rooted at cwd. Depth + result caps keep it from
  // walking the whole filesystem or hanging on heavy dirs (which we skip).
  // Also guarded by a time budget and the sender's lifetime, so a huge
  // workspace can't pin the main process event loop forever, and replies
  // aren't computed for a renderer that already navigated away.
  ipcMain.handle(
    "pi:searchWorkspace",
    async (event, { query, maxResults }: { query: string; maxResults?: number }) => {
      const root = pmgr ? pmgr.getCwd() : process.cwd();
      const q = (query || "").toLowerCase().trim();
      const MAX = Math.min(Math.max(maxResults || 200, 1), 500);
      const MAX_DEPTH = 8;
      const TIME_BUDGET_MS = 3000;
      const start = Date.now();
      const SKIP = new Set([
        "node_modules", ".git", "dist", "build", "out",
        "target", ".next", ".nuxt", "vendor", ".cache", ".turbo",
      ]);
      const results: { name: string; path: string; isDirectory: boolean }[] = [];
      if (!q) return { results };
      const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
      const REaddir_BATCH = 16;
      while (stack.length && results.length < MAX) {
        // Give up early if the requesting renderer is gone or the budget is up.
        if (event.sender.isDestroyed() || Date.now() - start > TIME_BUDGET_MS) break;
        // Process a batch of directories concurrently instead of one-at-a-time
        // to keep the main process event loop fed with I/O.
        const batch = stack.splice(-REaddir_BATCH);
        const entries = await Promise.all(
          batch.map(async ({ dir, depth }) => {
            try {
              return { dir, depth, dirents: await readdir(dir, { withFileTypes: true }) };
            } catch {
              return null;
            }
          }),
        );
        for (const entry of entries) {
          if (!entry || results.length >= MAX) continue;
          const { dir, depth, dirents } = entry;
          for (const d of dirents) {
            if (results.length >= MAX) break;
            const full = join(dir, d.name);
            if (d.name.toLowerCase().includes(q)) {
              results.push({ name: d.name, path: full, isDirectory: d.isDirectory() });
            }
            if (
              d.isDirectory() &&
              !d.isSymbolicLink() &&
              depth < MAX_DEPTH &&
              !SKIP.has(d.name)
            ) {
              stack.push({ dir: full, depth: depth + 1 });
            }
          }
        }
      }
      // Shallow first, then deterministic alpha, so the most relevant matches
      // surface at the top.
      results.sort((a, b) => {
        const da = a.path.split(/[\\/]/).length;
        const db = b.path.split(/[\\/]/).length;
        if (da !== db) return da - db;
        return a.path.toLowerCase().localeCompare(b.path.toLowerCase());
      });
      return { results };
    }
  );

  ipcMain.handle("pi:setCwd", async (_, { cwd }) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    if (typeof cwd !== "string" || !cwd) {
      throw new Error("Invalid workspace path");
    }
    await pmgr.setCwd(cwd);
    return pmgr.getCwd();
  });

  // Bind a still-empty session to a real workspace directory (per-session
  // relocate; does NOT set the global cwd). Returns the new on-disk path.
  ipcMain.handle("pi:bindSessionToWorkspace", async (_, { sessionPath, workspaceCwd }) => {
    if (!pmgr) throw new Error("Pi SDK not initialized");
    return await pmgr.bindSessionToWorkspace(sessionPath, workspaceCwd);
  });

  ipcMain.handle("pi:getChatOnlyCwd", async () => {
    if (!pmgr) return "";
    return pmgr.getChatOnlyCwd();
  });

  ipcMain.handle("pi:pickWorkspace", async () => {
    const parent = dialogParent(mainWindow);
    if (!parent) return null;
    const { canceled, filePaths } = await dialog.showOpenDialog(parent, {
      title: "Select workspace",
      properties: ["openDirectory"],
    });
    if (canceled || filePaths.length === 0) return null;
    return filePaths[0];
  });

  ipcMain.handle("pi:getRecentWorkspaces", async () => {
    if (!pmgr) return [];
    return pmgr.getRecentCwds();
  });

  // ── Embedded terminal (node-pty) ──
  // The terminal runs in the main process (native module); the renderer's
  // xterm instance talks to it over these channels. Works even if Pi SDK
  // failed to initialize.
  ipcMain.handle(
    "pi:terminal:create",
    async (_, opts: { shell: "gitbash" | "powershell" | "cmd" | "zsh" | "bash"; cwd: string; cols?: number; rows?: number }) => {
      return terminalManager.create(opts);
    }
  );

  // Which shells are actually installed on this machine (Git Bash may be
  // absent). The renderer uses this to hide unavailable shell options.
  ipcMain.handle("pi:terminal:availableShells", async (): Promise<("gitbash" | "powershell" | "cmd" | "zsh" | "bash")[]> => {
    return terminalManager.getAvailableShells();
  });

  // The shell of the currently live (persistent) terminal, or null. Lets the
  // renderer re-attach to the same running session instead of spawning a new
  // one when the terminal panel is reopened.
  ipcMain.handle("pi:terminal:getActive", (): "gitbash" | "powershell" | "cmd" | "zsh" | "bash" | null => {
    return terminalManager.getActive();
  });

  ipcMain.on("pi:terminal:input", (_, { id, data }: { id: string; data: string }) => {
    terminalManager.write(id, data);
  });

  ipcMain.on(
    "pi:terminal:resize",
    (_, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
      terminalManager.resize(id, cols, rows);
    }
  );

  ipcMain.handle("pi:terminal:kill", async (_, { id }: { id: string }) => {
    terminalManager.kill(id);
  });
}
