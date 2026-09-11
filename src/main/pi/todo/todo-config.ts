/**
 * Todo config — read/write of `todo-config.json` (agent dir).
 *
 * Stored next to `websearch-config.json` / `im-config.json`. Only one knob
 * today: `enabled` (default ON — the tool is registered for normal/workspace
 * sessions and skipped for scheduled-task sessions, which never mount the
 * extension). Users hand-edit the file; the tool extension re-reads it
 * synchronously on every execute so a change applies without a reload.
 */
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface TodoConfig {
  enabled: boolean;
}

const TODO_CONFIG_FILE = "todo-config.json";

function defaultConfig(): TodoConfig {
  return { enabled: true };
}

function normalize(raw: unknown): TodoConfig {
  if (!raw || typeof raw !== "object") return defaultConfig();
  const r = raw as Record<string, unknown>;
  return { enabled: r.enabled !== false }; // absent → default true
}

export async function readTodoConfig(): Promise<TodoConfig> {
  try {
    return normalize(JSON.parse(await readFile(configPath(), "utf-8")));
  } catch {
    return defaultConfig();
  }
}

/** Synchronous read for the extension factory / execute path. */
export function readTodoConfigSync(): TodoConfig {
  try {
    return normalize(JSON.parse(readFileSync(configPath(), "utf-8")));
  } catch {
    return defaultConfig();
  }
}

export async function writeTodoConfig(config: TodoConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), "utf-8");
}

function configPath(): string {
  return join(getAgentDir(), TODO_CONFIG_FILE);
}
