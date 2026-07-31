import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Soul / persona module (main process).
 *
 * The "soul" is free-form markdown the user writes to give the assistant a
 * persistent personality / behavioral style. It is injected into the system
 * prompt via Pi's `appendSystemPrompt` channel (see session-manager.ts), so it
 * layers on top of Pi's default tool/coding instructions without replacing them.
 *
 * Stored as a plain file at `~/.pi/agent/soul.md` (the same global dir Pi scans
 * for AGENTS.md and other context files), which lets the existing context-file
 * watcher pick up external edits automatically.
 */

/** Absolute path to the soul markdown file. */
export function soulPath(): string {
  return join(getAgentDir(), "soul.md");
}

/**
 * Read the soul text. Returns an empty string when the file does not exist
 * (a missing soul is a valid "no persona" state, not an error).
 */
export async function readSoul(): Promise<string> {
  try {
    return await readFile(soulPath(), "utf-8");
  } catch {
    return "";
  }
}

/**
 * Synchronous soul read, for use inside the SDK's `appendSystemPromptOverride`
 * hook. That hook runs on every ResourceLoader (re)load — including
 * `session.reload()` — so reading the file *inside* it (instead of passing a
 * text snapshot at services-creation time) is what makes soul edits hot-apply
 * to the currently running session without a restart. Returns "" when the
 * file is missing or unreadable.
 */
export function readSoulSync(): string {
  try {
    return readFileSync(soulPath(), "utf-8").trim();
  } catch {
    return "";
  }
}

/**
 * Persist the soul text. Creates the agent directory if needed. An empty
 * string is written as-is (clearing the persona), so callers can pass "" to
 * remove it without deleting the file.
 */
export async function writeSoul(text: string): Promise<void> {
  const path = soulPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(path, text, "utf-8");
}
