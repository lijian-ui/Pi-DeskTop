/**
 * Schedule tool config — read/write of `schedule-config.json` (agent dir).
 *
 * Mirrors todo-config.ts. Stored next to `todo-config.json` /
 * `sendfile-config.json`. Only one knob today: `enabled` (default ON — the tool
 * is registered for normal/workspace sessions and skipped for scheduled-task
 * sessions, which never mount the extension). Users hand-edit the file; the
 * extension re-reads it synchronously on every execute so a change applies
 * without a reload.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readJsonFile, readJsonFileSync } from "../../json-file";

export interface ScheduleConfig {
  enabled: boolean;
}

const SCHEDULE_CONFIG_FILE = "schedule-config.json";

function defaultConfig(): ScheduleConfig {
  return { enabled: true };
}

function normalize(raw: unknown): ScheduleConfig {
  if (!raw || typeof raw !== "object") return defaultConfig();
  const r = raw as Record<string, unknown>;
  return { enabled: r.enabled !== false }; // absent → default true
}

export async function readScheduleConfig(): Promise<ScheduleConfig> {
  try {
    return normalize(await readJsonFile(configPath()));
  } catch {
    return defaultConfig();
  }
}

/** Synchronous read for the extension factory / execute path. */
export function readScheduleConfigSync(): ScheduleConfig {
  try {
    return normalize(readJsonFileSync(configPath()));
  } catch {
    return defaultConfig();
  }
}

export async function writeScheduleConfig(config: ScheduleConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), "utf-8");
}

function configPath(): string {
  return join(getAgentDir(), SCHEDULE_CONFIG_FILE);
}