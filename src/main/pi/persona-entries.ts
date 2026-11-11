import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Persona entry library — the shared "multiple entries + apply" storage layer
 * used by BOTH the soul library (`~/.pi/agent/souls/`) and the preamble
 * library (`~/.pi/agent/preambles/`).
 *
 * Data model (mirrors the Pi-Work server side):
 *  - Library: `<agentDir>/<kind>s/<name>.md` — file name = entry name, file
 *    body = entry content.
 *  - Active file: `<agentDir>/<kind>.md` (soul.md / preamble.md) — the ONLY
 *    file the injection hooks read, every turn.
 *  - "Apply" = copy an entry's content into the active file, so which entry is
 *    active needs NO state file of its own: the UI just compares the active
 *    content against entries to badge the applied one.
 */

/** One library entry: name = .md file name (without the extension), content = file body. */
export interface PersonaEntry {
  name: string;
  content: string;
}

/**
 * Sanitize a user-provided entry name: trim, collapse whitespace, cap length,
 * reject filesystem-hostile characters and dot-prefixed names. Returns null
 * when invalid (callers turn that into a user-facing error).
 */
export function sanitizeEntryName(raw: string): string | null {
  const name = String(raw ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 60);
  if (!name || name === "." || name === ".." || name.startsWith(".")) return null;
  if (/[\\/:*?<>|"]/.test(name)) return null;
  return name;
}

/** List entries (names without the .md suffix, sorted). Missing dir → []. */
export async function listPersonaEntries(dir: string): Promise<PersonaEntry[]> {
  if (!existsSync(dir)) return [];
  const names = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  const out: PersonaEntry[] = [];
  for (const f of names) {
    try {
      out.push({ name: f.slice(0, -".md".length), content: await readFile(join(dir, f), "utf-8") });
    } catch {
      // Entry deleted concurrently while listing: skip it.
    }
  }
  return out;
}

/** Write an entry (creates the library dir on demand). */
export async function writePersonaEntry(dir: string, name: string, text: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), String(text ?? ""), "utf-8");
}

/** Delete an entry (no-op when missing). */
export async function deletePersonaEntry(dir: string, name: string): Promise<void> {
  const file = join(dir, `${name}.md`);
  if (existsSync(file)) await unlink(file);
}
