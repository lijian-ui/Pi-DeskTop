import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  deletePersonaEntry,
  listPersonaEntries,
  sanitizeEntryName,
  writePersonaEntry,
  type PersonaEntry,
} from "./persona-entries";

/**
 * Preamble module (main process).
 *
 * The preamble is the identity sentence pi hardcodes at the VERY START of the
 * assembled system prompt ("You are an expert coding assistant operating
 * inside pi, …", bare text right before the `<tools>` section). The SDK offers
 * no toggle for replacing just it — `customPrompt` would also drop the
 * tools/rules sections — so the replacement is done by `preamble-extension.ts`
 * (before_agent_start hook): it re-reads `~/.pi/agent/preamble.md` on every
 * turn and deterministically replaces the anchored default sentence. Editing
 * the file applies on the NEXT message, no restart needed.
 *
 * An empty string / missing file = "not replaced" (keep pi's default preamble).
 */

/** The exact default preamble sentence pi hardcodes (system-prompt.js). */
export const DEFAULT_PREAMBLE =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

/**
 * Anchored matcher for the default preamble. Precise on purpose: if a SDK
 * upgrade rewords the sentence the match simply fails and the hook leaves the
 * prompt untouched (zero side effects, same failure mode as the docs strip).
 */
export const DEFAULT_PREAMBLE_RE = new RegExp(
  `^${DEFAULT_PREAMBLE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
);

/** Absolute path to the preamble markdown file (next to soul.md). */
export function preamblePath(): string {
  return join(getAgentDir(), "preamble.md");
}

/**
 * Read the preamble text. Returns "" when missing/unreadable (= not replaced).
 */
export async function readPreamble(): Promise<string> {
  try {
    return await readFile(preamblePath(), "utf-8");
  } catch {
    return "";
  }
}

/**
 * Synchronous read for the before_agent_start hook (runs every turn in the
 * main process, next to session-manager). Returns "" when missing.
 */
export function readPreambleSync(): string {
  try {
    return readFileSync(preamblePath(), "utf-8").trim();
  } catch {
    return "";
  }
}

/** Persist the preamble. "" = restore pi's default (hook becomes a no-op). */
export async function writePreamble(text: string): Promise<void> {
  const path = preamblePath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(path, text, "utf-8");
}

/** Preamble library directory: `~/.pi/agent/preambles/`. */
export function preamblesDir(): string {
  return join(getAgentDir(), "preambles");
}

/** List preamble entries (`<name>.md`, with content). */
export async function listPreambleEntries(): Promise<PersonaEntry[]> {
  return listPersonaEntries(preamblesDir());
}

/** Save a preamble entry (name sanitized; throws on invalid names). */
export async function savePreambleEntry(name: string, text: string): Promise<void> {
  const safe = sanitizeEntryName(name);
  if (!safe) throw new Error("Invalid entry name");
  await writePersonaEntry(preamblesDir(), safe, text);
}

/** Delete a preamble entry (no-op when missing). */
export async function deletePreambleEntry(name: string): Promise<void> {
  const safe = sanitizeEntryName(name);
  if (!safe) throw new Error("Invalid entry name");
  await deletePersonaEntry(preamblesDir(), safe);
}
