import { ipcMain, dialog, BrowserWindow } from "electron";
import { basename, extname, join } from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import type { PiDeskSessionManager } from "./pi/session-manager";
import type { TerminalManager } from "./pi/terminal-manager";

/** Parent window for native dialogs. Prefers the live window — the window
 *  captured at registration time may have been destroyed and rebuilt (app
 *  "activate" edge path), and dialog.* silently fails on a destroyed parent. */
function dialogParent(mainWindow: BrowserWindow): BrowserWindow | undefined {
  if (!mainWindow.isDestroyed()) return mainWindow;
  return BrowserWindow.getAllWindows()[0];
}

export function registerIpcHandlers(
  mainWindow: BrowserWindow,
  piManager: PiDeskSessionManager | null,
  terminalManager: TerminalManager
): void {
  ipcMain.handle("pi:prompt", async (_, { text, images, cwd, sessionPath }) => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    await piManager.prompt(text, images, cwd, sessionPath);
  });

  ipcMain.handle("pi:steer", async (_, { text, cwd, sessionPath }) => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    await piManager.steer(text, cwd, sessionPath);
  });

  ipcMain.handle("pi:followUp", async (_, { text, cwd, sessionPath }) => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    await piManager.followUp(text, cwd, sessionPath);
  });

  ipcMain.handle("pi:abort", async (_, { cwd }) => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    await piManager.abort(cwd);
  });

  // ── Bash guard (permission prototype) ──
  ipcMain.handle("pi:bashApprovalResponse", async (_, { requestId, decision }) => {
    piManager?.handleBashApprovalResponse({ requestId, decision });
  });

  ipcMain.handle("pi:setBashGuardMode", async (_, { mode }) => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    piManager.setBashGuardMode(mode);
  });

  ipcMain.handle("pi:getBashGuardConfig", async () => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    return piManager.getBashGuardConfig();
  });

  ipcMain.handle("pi:saveBashGuardConfig", async (_, config) => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    await piManager.saveBashGuardConfig(config);
  });

  ipcMain.handle("pi:getCompactionConfig", async () => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    return piManager.getCompactionConfig();
  });

  ipcMain.handle("pi:saveCompactionConfig", async (_, config) => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    await piManager.saveCompactionConfig(config);
  });

  // ── Soul / persona (assistant settings) ──
  ipcMain.handle("pi:getSoul", async () => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    return piManager.getSoul();
  });

  ipcMain.handle("pi:saveSoul", async (_, text) => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    await piManager.saveSoul(text);
  });

  // ── Active tools (assistant settings) ──
  ipcMain.handle("pi:getActiveTools", async () => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    return piManager.getActiveTools();
  });

  ipcMain.handle("pi:saveActiveTools", async (_, tools: string[]) => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    await piManager.saveActiveTools(tools);
  });

  ipcMain.handle("pi:setModel", async (_, { provider, modelId }) => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    await piManager.setModel(provider, modelId);
  });

  ipcMain.handle("pi:cycleModel", async () => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    await piManager.cycleModel();
  });

  ipcMain.handle("pi:getAvailableModels", async () => {
    if (!piManager) return [];
    return await piManager.getAvailableModels();
  });

  ipcMain.handle("pi:newSession", async (_, { cwd }) => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    return await piManager.newSession(cwd);
  });

  ipcMain.handle("pi:switchSession", async (_, { cwd, sessionPath }) => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    await piManager.switchSession(cwd, sessionPath);
  });

  ipcMain.handle("pi:compact", async (_, { customInstructions }) => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    return await piManager.compact(customInstructions);
  });

  ipcMain.handle("pi:getContextUsage", async () => {
    if (!piManager) return undefined;
    return piManager.getContextUsage();
  });

  ipcMain.handle("pi:getState", async (_, { cwd }) => {
    if (!piManager) return null;
    return piManager.getState(cwd);
  });

  ipcMain.handle("pi:setApiKey", async (_, { providerId, apiKey }) => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    const mr = piManager.getModelRuntime();
    if (!mr) throw new Error("ModelRuntime not available");
    await mr.setRuntimeApiKey(providerId, apiKey);
  });

  ipcMain.handle("pi:removeApiKey", async (_, { providerId }) => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    const mr = piManager.getModelRuntime();
    if (!mr) throw new Error("ModelRuntime not available");
    await mr.removeRuntimeApiKey(providerId);
  });

  ipcMain.handle("pi:saveApiKey", async (_, { providerId, apiKey }) => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    await piManager.saveApiKey(providerId, apiKey);
  });

  ipcMain.handle("pi:deleteApiKey", async (_, { providerId }) => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    await piManager.deleteApiKey(providerId);
  });

  ipcMain.handle("pi:registerProvider", async (_, { providerId, config }) => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    const mr = piManager.getModelRuntime();
    if (!mr) throw new Error("ModelRuntime not available");
    mr.registerProvider(providerId, config);
  });

  ipcMain.handle("pi:unregisterProvider", async (_, { providerId }) => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    const mr = piManager.getModelRuntime();
    if (!mr) throw new Error("ModelRuntime not available");
    mr.unregisterProvider(providerId);
  });

  ipcMain.handle("pi:getRegisteredProviderIds", async () => {
    if (!piManager) return [];
    const mr = piManager.getModelRuntime();
    if (!mr) return [];
    return mr.getRegisteredProviderIds();
  });

  ipcMain.handle("pi:getProviderAuthStatus", async (_, { providerId }) => {
    if (!piManager) return null;
    const mr = piManager.getModelRuntime();
    if (!mr) return null;
    return mr.getProviderAuthStatus(providerId);
  });

  ipcMain.handle("pi:getAllProviders", async () => {
    if (!piManager) return [];
    return piManager.getAllProvidersInfo();
  });

  ipcMain.handle("pi:listProvidersCatalog", async () => {
    if (!piManager) return { apiKeyProviders: [], customProviders: [] };
    return piManager.getProvidersCatalog();
  });

  ipcMain.handle("pi:getCustomModelsJson", async () => {
    if (!piManager) return {};
    return piManager.getCustomModelsJson();
  });

  ipcMain.handle("pi:saveCustomModelsJson", async (_, { data }) => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    await piManager.saveCustomModelsJson(data ?? {});
  });

  ipcMain.handle("pi:saveCustomProvider", async (_, { providerId, config }) => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    await piManager.saveCustomProvider(providerId, config);
  });

  ipcMain.handle("pi:deleteCustomProvider", async (_, { providerId }) => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    await piManager.deleteCustomProvider(providerId);
  });

  ipcMain.handle("pi:deleteCustomModel", async (_, { providerId, modelId }) => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    await piManager.deleteCustomModel(providerId, modelId);
  });

  // ── Session management ──
  ipcMain.handle("pi:listSessions", async () => {
    if (!piManager) return [];
    return piManager.listSessions();
  });

  ipcMain.handle("pi:getCurrentSession", async (_, args) => {
    if (!piManager) return null;
    return piManager.getCurrentSessionPath(args?.cwd) ?? null;
  });

  ipcMain.handle("pi:exportSession", async (_, { sessionPath }) => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    const defaultName = `${basename(String(sessionPath)).replace(/\.jsonl$/i, "")}.html`;
    const { canceled, filePath } = await dialog.showSaveDialog(dialogParent(mainWindow)!, {
      title: "Export session as HTML",
      defaultPath: defaultName,
      filters: [{ name: "HTML", extensions: ["html"] }],
    });
    if (canceled || !filePath) return null;
    return await piManager.exportSessionHtml(String(sessionPath), filePath);
  });

  ipcMain.handle("pi:renameSession", async (_, { sessionPath, name }) => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    await piManager.renameSession(String(sessionPath), String(name));
  });

  ipcMain.handle("pi:deleteSession", async (_, { sessionPath }) => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    await piManager.deleteSession(String(sessionPath));
  });

  // ── Skill management ──
  ipcMain.handle("pi:listSkills", async () => {
    if (!piManager) return [];
    return piManager.listSkills();
  });

  ipcMain.handle("pi:importSkill", async () => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    const { canceled, filePaths } = await dialog.showOpenDialog(dialogParent(mainWindow)!, {
      title: "Import skill (.zip)",
      properties: ["openFile"],
      filters: [{ name: "Skill Zip", extensions: ["zip"] }],
    });
    if (canceled || filePaths.length === 0) return null;
    return await piManager.importSkillZip(filePaths[0]);
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
    if (!piManager) return process.cwd();
    return piManager.getCwd();
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
        : piManager
          ? piManager.getCwd()
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
      const root = piManager ? piManager.getCwd() : process.cwd();
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
    if (!piManager) throw new Error("Pi SDK not initialized");
    if (typeof cwd !== "string" || !cwd) {
      throw new Error("Invalid workspace path");
    }
    await piManager.setCwd(cwd);
    return piManager.getCwd();
  });

  // Bind a still-empty session to a real workspace directory (per-session
  // relocate; does NOT set the global cwd). Returns the new on-disk path.
  ipcMain.handle("pi:bindSessionToWorkspace", async (_, { sessionPath, workspaceCwd }) => {
    if (!piManager) throw new Error("Pi SDK not initialized");
    return await piManager.bindSessionToWorkspace(sessionPath, workspaceCwd);
  });

  ipcMain.handle("pi:getChatOnlyCwd", async () => {
    if (!piManager) return "";
    return piManager.getChatOnlyCwd();
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
    if (!piManager) return [];
    return piManager.getRecentCwds();
  });

  // ── Embedded terminal (node-pty) ──
  // The terminal runs in the main process (native module); the renderer's
  // xterm instance talks to it over these channels. Works even if Pi SDK
  // failed to initialize.
  ipcMain.handle(
    "pi:terminal:create",
    async (_, opts: { shell: "gitbash" | "powershell" | "cmd"; cwd: string; cols?: number; rows?: number }) => {
      return terminalManager.create(opts);
    }
  );

  // Which shells are actually installed on this machine (Git Bash may be
  // absent). The renderer uses this to hide unavailable shell options.
  ipcMain.handle("pi:terminal:availableShells", async (): Promise<("gitbash" | "powershell" | "cmd")[]> => {
    return terminalManager.getAvailableShells();
  });

  // The shell of the currently live (persistent) terminal, or null. Lets the
  // renderer re-attach to the same running session instead of spawning a new
  // one when the terminal panel is reopened.
  ipcMain.handle("pi:terminal:getActive", (): "gitbash" | "powershell" | "cmd" | null => {
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
