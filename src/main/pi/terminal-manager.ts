import { spawn, type IPty } from "node-pty";
import { existsSync } from "node:fs";
import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { WebContents } from "electron";

const IS_WIN = process.platform === "win32";

export type TerminalShell = "gitbash" | "powershell" | "cmd" | "zsh" | "bash";

export interface CreateTerminalOptions {
  shell: TerminalShell;
  cwd: string;
  cols?: number;
  rows?: number;
}

interface TerminalHandle {
  id: string;
  pty: IPty;
  shell: TerminalShell;
  /** Absolute cwd the PTY was spawned in (for reuse matching). */
  cwd: string;
}

// Windows-only Git Bash locations.
const GIT_BASH_CANDIDATES_WIN = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
];

// macOS / Linux stock shells (always present on a normal desktop install).
const UNIX_SHELL_PATHS: Record<"zsh" | "bash", string> = {
  zsh: "/bin/zsh",
  bash: "/bin/bash",
};

/** True if `name` resolves on PATH. Uses `where` on Windows, `command -v` on Unix. */
function commandExistsAsync(name: string): Promise<boolean> {
  const probe = IS_WIN ? `where ${name}` : `command -v ${name}`;
  return new Promise((resolve) => {
    exec(probe, { windowsHide: true, timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
}

/** Git Bash is only relevant on Windows (probed via launcher / bash / git). */
async function hasGitBash(): Promise<boolean> {
  if (!IS_WIN) return false;
  if (await commandExistsAsync("git-bash.exe")) return true;
  if (
    (await commandExistsAsync("bash.exe")) &&
    ((await commandExistsAsync("git.exe")) ||
      GIT_BASH_CANDIDATES_WIN.some((p) => existsSync(p)))
  ) {
    return true;
  }
  return GIT_BASH_CANDIDATES_WIN.some((p) => existsSync(p));
}

/**
 * Manages one or more node-pty pseudoterminals in the main process.
 * The renderer (xterm) sends keystrokes in and receives output via IPC.
 */
export class TerminalManager {
  private webContents: WebContents | null = null;
  private terminals = new Map<string, TerminalHandle>();
  // The single live terminal. It survives panel close/open so a running
  // process (e.g. `npm install`) keeps going; reopening just re-attaches.
  private current: TerminalHandle | null = null;
  /** Cached available shells (computed once on first query). */
  private availableShellsCache: TerminalShell[] | null = null;

  setWebContents(wc: WebContents | null): void {
    this.webContents = wc;
  }

  /**
   * Returns the shells actually available on this machine, so the renderer
   * can hide options the user never installed (Git Bash) instead of letting
   * node-pty fail at spawn time. Results are cached after the first async
   * detection to avoid repeated `where` calls.
   */
  async getAvailableShells(): Promise<TerminalShell[]> {
    if (this.availableShellsCache) return this.availableShellsCache;
    const shells: TerminalShell[] = [];
    if (await hasGitBash()) shells.push("gitbash");
    if (IS_WIN) {
      if (await commandExistsAsync("powershell.exe") || await commandExistsAsync("pwsh.exe")) shells.push("powershell");
      if (await commandExistsAsync("cmd.exe")) shells.push("cmd");
    } else {
      // macOS / Linux: the two stock shells are always present.
      if (existsSync(UNIX_SHELL_PATHS.zsh)) shells.push("zsh");
      if (existsSync(UNIX_SHELL_PATHS.bash)) shells.push("bash");
    }
    this.availableShellsCache = shells;
    return shells;
  }

  private resolveShell(shell: TerminalShell): { command: string; args: string[] } {
    switch (shell) {
      case "powershell":
        return { command: "powershell.exe", args: ["-NoLogo"] };
      case "cmd":
        return { command: "cmd.exe", args: [] };
      case "bash":
        return { command: IS_WIN ? "bash.exe" : UNIX_SHELL_PATHS.bash, args: ["--login", "-i"] };
      case "zsh":
        return { command: UNIX_SHELL_PATHS.zsh, args: [] };
      case "gitbash":
      default: {
        if (IS_WIN) {
          for (const c of GIT_BASH_CANDIDATES_WIN) {
            if (existsSync(c)) return { command: c, args: ["--login", "-i"] };
          }
          return { command: "bash", args: ["--login", "-i"] };
        }
        return { command: UNIX_SHELL_PATHS.bash, args: ["--login", "-i"] };
      }
    }
  }

  create(opts: CreateTerminalOptions): { id: string; pid: number } {
    const { command, args } = this.resolveShell(opts.shell);
    const cwd = resolve(opts.cwd || process.cwd());

    // Reuse the live terminal only if it runs the requested shell AND was
    // spawned in the same directory. Reusing across cwds would silently leave
    // the terminal attached to the old working directory (e.g. after the user
    // switched workspaces), which is confusing when the caller explicitly
    // asked for a new cwd. A long-running process is still preserved across
    // panel open/close cycles — reopening re-attaches to it.
    if (
      this.current &&
      this.current.shell === opts.shell &&
      resolve(this.current.cwd) === cwd
    ) {
      return { id: this.current.id, pid: this.current.pty.pid };
    }
    // A different (or no) terminal is active: tear the previous session down
    // before spawning the new one.
    if (this.current) {
      try {
        this.current.pty.kill();
      } catch {
        /* ignore */
      }
      this.terminals.delete(this.current.id);
      this.current = null;
    }

    const cols = opts.cols ?? 80;
    const rows = opts.rows ?? 30;
    const term: IPty = spawn(command, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      // Merge with the host env and advertise a 256-color terminal so tools
      // like `ls --color`, git diff, etc. render nicely.
      env: { ...process.env, TERM: "xterm-256color", FORCE_COLOR: "1" },
    });

    const id = randomUUID();
    term.onData((data) => {
      this.webContents?.send("pi:terminal:output", { id, data });
    });
    term.onExit(({ exitCode }) => {
      this.webContents?.send("pi:terminal:exit", { id, exitCode });
      this.terminals.delete(id);
      if (this.current?.id === id) this.current = null;
    });

    const handle: TerminalHandle = { id, pty: term, shell: opts.shell, cwd };
    this.terminals.set(id, handle);
    this.current = handle;
    return { id, pid: term.pid };
  }

  /** The shell of the currently live terminal, or null if none is running. */
  getActive(): TerminalShell | null {
    return this.current ? this.current.shell : null;
  }

  write(id: string, data: string): void {
    this.terminals.get(id)?.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.terminals.get(id)?.pty.resize(cols, rows);
    } catch {
      // Resizing before the pty is ready can throw; ignore.
    }
  }

  kill(id: string): void {
    const handle = this.terminals.get(id);
    if (!handle) return;
    try {
      handle.pty.kill();
    } catch {
      // Already dead.
    }
    this.terminals.delete(id);
    if (this.current?.id === id) this.current = null;
  }

  /** Kill every terminal (called on app quit). */
  dispose(): void {
    for (const handle of this.terminals.values()) {
      try {
        handle.pty.kill();
      } catch {
        // ignore
      }
    }
    this.terminals.clear();
  }
}
