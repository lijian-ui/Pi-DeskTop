/**
 * ask_user_question config — read/write of `askuser-config.json` (agent dir).
 *
 * Mirrors todo-config.ts: stored next to `todo-config.json` /
 * `websearch-config.json`. One knob today: `enabled` (default ON). The tool is
 * registered for normal/workspace sessions and skipped for scheduled-task
 * sessions, which never mount the extension. Users hand-edit the file; the
 * extension re-reads it synchronously on every execute so a change applies
 * without a reload.
 */
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface AskUserConfig {
  enabled: boolean;
}

const ASK_USER_CONFIG_FILE = "askuser-config.json";

function defaultConfig(): AskUserConfig {
  return { enabled: true };
}

function normalize(raw: unknown): AskUserConfig {
  if (!raw || typeof raw !== "object") return defaultConfig();
  const r = raw as Record<string, unknown>;
  return { enabled: r.enabled !== false }; // absent → default true
}

export async function readAskUserConfig(): Promise<AskUserConfig> {
  try {
    return normalize(JSON.parse(await readFile(configPath(), "utf-8")));
  } catch {
    return defaultConfig();
  }
}

/** Synchronous read for the extension factory / execute path. */
export function readAskUserConfigSync(): AskUserConfig {
  try {
    return normalize(JSON.parse(readFileSync(configPath(), "utf-8")));
  } catch {
    return defaultConfig();
  }
}

export async function writeAskUserConfig(config: AskUserConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), "utf-8");
}

function configPath(): string {
  return join(getAgentDir(), ASK_USER_CONFIG_FILE);
}
