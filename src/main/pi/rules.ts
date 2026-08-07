import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Rules module (main process).
 *
 * A SINGLE markdown file holds ALL user rules (`~/.pi/agent/rules/rules.md`).
 * It is injected at the ABSOLUTE BOTTOM of the system prompt as a
 * `<rules>…</rules>` block via the rulesExtension (before_agent_start), so
 * every conversation — including scheduled tasks — follows the rules.
 *
 * Hot-reload: the extension re-reads the file on EVERY turn, so edits apply
 * on the next message without a restart or services rebuild.
 */

/** Absolute path to the rules markdown file. */
export function rulesFilePath(): string {
  return join(getAgentDir(), "rules", "rules.md");
}

/** Read the rules text. Returns "" when the file does not exist. */
export async function readRules(): Promise<string> {
  try {
    return await readFile(rulesFilePath(), "utf-8");
  } catch {
    return "";
  }
}

/** Synchronous read, for use inside the before_agent_start extension hook. */
export function readRulesSync(): string {
  try {
    return readFileSync(rulesFilePath(), "utf-8");
  } catch {
    return "";
  }
}

/** Persist the rules text (creates the rules dir on demand). */
export async function writeRules(text: string): Promise<void> {
  const path = rulesFilePath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(path, String(text ?? ""), "utf-8");
}

/** Delete the rules file (a no-op when it does not exist). */
export async function deleteRulesFile(): Promise<void> {
  const path = rulesFilePath();
  if (existsSync(path)) {
    await unlink(path);
  }
}
