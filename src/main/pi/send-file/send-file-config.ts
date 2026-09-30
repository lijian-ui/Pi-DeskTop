/**
 * send_file tool config — read/write of `sendfile-config.json` (agent dir).
 *
 * Mirrors ask-user-config.ts. stored next to `askuser-config.json`.
 * One knob today: `enabled` (default ON). Users hand-edit the file; the
 * extension re-reads it synchronously on every execute so a change applies
 * without a reload.
 */
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface SendFileConfig {
  enabled: boolean;
}

const SEND_FILE_CONFIG_FILE = "sendfile-config.json";

function defaultConfig(): SendFileConfig {
  return { enabled: true };
}

function normalize(raw: unknown): SendFileConfig {
  if (!raw || typeof raw !== "object") return defaultConfig();
  const r = raw as Record<string, unknown>;
  return { enabled: r.enabled !== false }; // absent → default true
}

export async function readSendFileConfig(): Promise<SendFileConfig> {
  try {
    return normalize(JSON.parse(await readFile(configPath(), "utf-8")));
  } catch {
    return defaultConfig();
  }
}

/** Synchronous read for the extension factory / execute path. */
export function readSendFileConfigSync(): SendFileConfig {
  try {
    return normalize(JSON.parse(readFileSync(configPath(), "utf-8")));
  } catch {
    return defaultConfig();
  }
}

export async function writeSendFileConfig(config: SendFileConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), "utf-8");
}

function configPath(): string {
  return join(getAgentDir(), SEND_FILE_CONFIG_FILE);
}