/**
 * Shared artifact-extraction helpers.
 *
 * Used by BOTH live paths and the history path:
 * - `useAgentSession` (live) drives them from realtime tool events.
 * - `session-store.reloadMessages` (history reload) REPLAYS artifacts from the
 *   persisted tool calls instead of storing a separate copy — artifacts are a
 *   derived view of a turn's tool executions, so they must be re-derivable
 *   from the same source (the .jsonl session file) that toolExecutions are.
 *
 * Two capture channels, mirroring the two live channels:
 * - structured file-writer tools (`write`/`edit`/…): path read from the input
 *   object; synchronous, never stat()-ed (same as live).
 * - shell tools (`bash`/…): path is guessed from the command string, so it is
 *   ALWAYS stat()-verified before becoming an artifact (same as live).
 */

import type { Artifact, Message } from "../store/agent-store";
import { resolveAgainstCwd } from "./path-utils";

// ── Structured file-writer tools ──────────────────────────────────────
// A tool is treated as a file-writer when its (normalized) name contains
// "write"/"edit"/… — catches Write / Edit / MultiEdit / NotebookEdit /
// write_file / edit_file / create_file / save_file regardless of casing or
// separators. The Pi SDK emits these in lowercase ("write", "edit").
function isFileWriteTool(toolName: string): boolean {
  const n = (toolName || "").toLowerCase().replace(/[^a-z]/g, "");
  return (
    n.includes("write") ||
    n.includes("edit") ||
    n.includes("create") ||
    n.includes("save") ||
    n.includes("patch") ||
    n.includes("overwrite") ||
    n.includes("newfile")
  );
}

/** Known input-key variants that carry the target file path. */
const FILE_PATH_KEYS = ["file_path", "filePath", "path", "filename", "file"];

/** Try to extract a file path from a tool execution's input args. Returns
 *  null when the tool is not a file-writer or no path key is present. */
export function extractFilePath(toolName: string, input: any): string | null {
  if (!input || typeof input !== "object") return null;
  if (!isFileWriteTool(toolName)) return null;
  for (const k of FILE_PATH_KEYS) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

// ── Shell-command artifacts ───────────────────────────────────────────
// Shell tools take a *command string*, not a structured file path, so files
// created by redirection / tee / cp / curl are invisible to extractFilePath().
export const SHELL_TOOLS = new Set([
  "bash", "sh", "zsh", "shell", "terminal", "execute_command", "run_command",
  "cmd", "powershell",
]);

/**
 * Best-effort extraction of the files a shell command WRITES.
 * Covers: `>` / `>>` / `N>` / `&>` redirection, `tee`, `cp`/`mv` destination,
 * `curl -o` / `wget -O`.
 * Cannot be inferred from a command line alone (documented limitation):
 * files written *inside* a script the command runs (`python gen.py`,
 * `node build.js`) and by project generators (`npm init`, `npx create-*`).
 * Regex false positives are harmless — every candidate is stat()-ed before
 * it becomes an artifact (pi:statFile only returns a size for real files).
 * `$` is excluded from tokens so shell variables are never captured.
 */
const SHELL_TOKEN = String.raw`[^\s;|&<>"'\$]+`;

export function extractShellFileTargets(command: string): string[] {
  if (typeof command !== "string" || !command.trim()) return [];
  const out = new Set<string>();
  const add = (v?: string) => {
    const t = (v ?? "").trim().replace(/^["']+|["']+$/g, "");
    if (t && !/[;&|<>$]/.test(t)) out.add(t);
  };
  // Redirection. `2>&1` (fd duplication) is skipped: `&` is not a token char.
  for (const m of command.matchAll(
    new RegExp(String.raw`(?:^|[;|&(]|\s)(?:[0-9]?&?>{1,2})\s*(${SHELL_TOKEN})`, "g"),
  )) add(m[1]);
  // tee [-a] file
  for (const m of command.matchAll(
    new RegExp(String.raw`\btee\b(?:\s+-[a-zA-Z]+)*\s+(${SHELL_TOKEN})`, "g"),
  )) add(m[1]);
  // cp / mv → last token of the command is the destination
  for (const m of command.matchAll(
    new RegExp(String.raw`\b(?:cp|mv)\b[^\n;|&]*?\s(${SHELL_TOKEN})\s*(?:$|[;|&])`, "gm"),
  )) add(m[1]);
  // curl -o file / wget -O file
  for (const m of command.matchAll(
    new RegExp(String.raw`\b(?:curl|wget)\b[^\n;|&]*?\s-[oO]\s*(${SHELL_TOKEN})`, "g"),
  )) add(m[1]);
  return [...out];
}

// ── History replay ────────────────────────────────────────────────────
/**
 * History may store a tool call's arguments as a plain object OR as a JSON
 * string (the SDK's persisted form differs from the live event's). Normalise
 * both so extraction code can treat input as an object everywhere.
 */
function normalizeToolInput(input: any): any {
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch {
      return null;
    }
  }
  return input;
}

/** The shell command string of a (possibly JSON-encoded) tool input. */
function shellCommandOf(input: any): string {
  if (!input || typeof input !== "object") return "";
  return input.command ?? input.cmd ?? input.script ?? "";
}

/**
 * Re-derive `artifacts` for every assistant message of a reloaded history.
 * Synchronously replays structured file-writer tools (same as live: no stat),
 * and asynchronously stat()-verifies shell candidates (same as live).
 * Idempotent; returns the SAME array reference when nothing changed so callers
 * can short-circuit on reference equality.
 */
export async function hydrateArtifacts(
  messages: Message[],
  baseCwd: string,
): Promise<Message[]> {
  if (!messages.length) return messages;
  const out: Message[] = [...messages];
  let changed = false;

  // (message index) → absolute shell candidates awaiting stat verification.
  const shellPending: { idx: number; abs: string }[] = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.toolExecutions?.length) continue;
    const arts: Artifact[] = m.artifacts ? [...m.artifacts] : [];
    const seen = new Set(arts.map((a) => a.filePath));

    for (const t of m.toolExecutions) {
      if (t.isError) continue; // failed writes never became artifacts live
      const input = normalizeToolInput(t.input);
      const fp = extractFilePath(t.toolName, input);
      if (fp && !seen.has(fp)) {
        seen.add(fp);
        arts.push({ filePath: fp, size: null });
      }
      if (SHELL_TOOLS.has(String(t.toolName ?? "").toLowerCase())) {
        for (const rel of extractShellFileTargets(shellCommandOf(input))) {
          shellPending.push({ idx: i, abs: resolveAgainstCwd(rel, baseCwd) });
        }
      }
    }

    if (arts.length !== (m.artifacts?.length ?? 0)) {
      changed = true;
      out[i] = { ...m, artifacts: arts };
    }
  }

  if (shellPending.length) {
    const results = await Promise.all(
      shellPending.map((p) =>
        window.piDesk
          .statFile(p.abs)
          .then((s): Artifact | null =>
            s?.size != null ? { filePath: p.abs, size: s.size } : null,
          )
          .catch(() => null),
      ),
    );
    // Fold verified files back onto their owning messages (dedupe).
    for (let k = 0; k < shellPending.length; k++) {
      const art = results[k];
      if (!art) continue;
      const { idx } = shellPending[k];
      const m = out[idx];
      if (!m) continue;
      const cur = out[idx].artifacts ?? [];
      if (cur.some((a) => a.filePath === art.filePath)) continue;
      out[idx] = { ...m, artifacts: [...cur, art] };
      changed = true;
    }
  }

  return changed ? out : messages;
}
