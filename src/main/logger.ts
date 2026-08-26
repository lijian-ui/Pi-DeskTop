import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

let logDir: string | null = null;
let dirReady = false;

function ensureDir(): string | null {
  if (dirReady) return logDir;
  try {
    const dir = join(getAgentDir(), "logs");
    mkdirSync(dir, { recursive: true });
    logDir = dir;
  } catch {
    logDir = null;
  }
  dirReady = true;
  return logDir;
}

/** Daily log file path: ~/.pi/agent/logs/YYYY-MM-DD.log */
function dayFile(): string | null {
  const dir = ensureDir();
  if (!dir) return null;
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return join(dir, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`);
}

function ts(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function render(parts: unknown[]): string {
  return parts
    .map((x) => {
      if (x instanceof Error) return x.stack || `${x.name}: ${x.message}`;
      if (typeof x === "string") return x;
      try {
        return format(x);
      } catch {
        return String(x);
      }
    })
    .join(" ");
}

function write(level: string, parts: unknown[]): void {
  try {
    const file = dayFile();
    if (!file) return;
    appendFileSync(file, `[${ts()}] ${level} ${render(parts)}\n`);
  } catch {
    /* logging must never break the app */
  }
}

/**
 * Mirror every console.* call to the daily log file (in addition to stdout).
 * This is what makes the packaged build's logs inspectable — without DevTools
 * the console is invisible, but the file persists. Installed once at startup.
 */
export function installConsoleToFile(): void {
  try {
    const map: [keyof Console, string][] = [
      ["log", "INFO"],
      ["info", "INFO"],
      ["debug", "DEBUG"],
      ["warn", "WARN"],
      ["error", "ERROR"],
    ];
    for (const [method, level] of map) {
      const original = (console[method] as (...a: unknown[]) => void).bind(console);
      (console as any)[method] = (...args: unknown[]) => {
        original(...args);
        write(level, args);
      };
    }
    write("INFO", ["[logger] console→file mirror installed; daily log at", dayFile()]);
  } catch {
    /* ignore */
  }
}
