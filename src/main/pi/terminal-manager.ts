import { spawn, type IPty } from "node-pty";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";

export type TerminalShell = "gitbash" | "powershell" | "cmd";

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
}

const GIT_BASH_CANDIDATES = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
];

/** True if `name` resolves on PATH (e.g. `where git-bash.exe`). */
function commandExists(name: string): boolean {
  try {
    execSync(`where ${name}`, { windowsHide: true, timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Git Bash is present if its launcher or bash binary is reachable. */
function hasGitBash(): boolean {
  if (commandExists("git-bash.exe")) return true;
  // `bash.exe` may come from Git or another source; require a Git marker too.
  if (commandExists("bash.exe") && (commandExists("git.exe") || GIT_BASH_CANDIDATES.some((p) => existsSync(p)))) {
    return true;
  }
  return GIT_BASH_CANDIDATES.some((p) => existsSync(p));
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

  setWebContents(wc: WebContents | null): void {
    this.webContents = wc;
  }

  /**
   * Returns the shells actually available on this machine, so the renderer
   * can hide options the user never installed (Git Bash) instead of letting
   * node-pty fail at spawn time.
   */
  getAvailableShells(): TerminalShell[] {
    const shells: TerminalShell[] = [];
    if (hasGitBash()) shells.push("gitbash");
    if (commandExists("powershell.exe") || commandExists("pwsh.exe")) shells.push("powershell");
    if (commandExists("cmd.exe")) shells.push("cmd");
    return shells;
  }

  private resolveShell(shell: TerminalShell): { command: string; args: string[] } {
    switch (shell) {
      case "powershell":
        return { command: "powershell.exe", args: ["-NoLogo"] };
      case "cmd":
        return { command: "cmd.exe", args: [] };
      case "gitbash":
      default: {
        for (const c of GIT_BASH_CANDIDATES) {
          if (existsSync(c)) return { command: c, args: ["--login", "-i"] };
        }
        return { command: "bash", args: ["--login", "-i"] };
      }
    }
  }

  create(opts: CreateTerminalOptions): { id: string; pid: number } {
    const { command, args } = this.resolveShell(opts.shell);

    // Reuse the live terminal if it already runs the requested shell. This is
    // what keeps a long-running process (e.g. `npm install`) alive across
    // terminal-panel open/close cycles — reopening re-attaches to it instead
    // of spawning a fresh shell and orphaning the running process.
    if (this.current && this.current.shell === opts.shell) {
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
      cwd: opts.cwd,
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

    const handle: TerminalHandle = { id, pty: term, shell: opts.shell };
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
