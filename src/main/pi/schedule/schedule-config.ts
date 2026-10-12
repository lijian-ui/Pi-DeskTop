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
  /**
   * deferred 试点（与 browser 同机制）：注册但不声明给模型，经 tool_search
   * 按需装载 + 关键词自动装载兜底。缺字段 → 默认启用；显式写 false 一键回退
   * 常驻 direct。仅影响桌面普通/空间会话——IM 与定时任务会话由调用方决定。
   */
  deferred: boolean;
}

const SCHEDULE_CONFIG_FILE = "schedule-config.json";

function defaultConfig(): ScheduleConfig {
  return { enabled: true, deferred: true };
}

function normalize(raw: unknown): ScheduleConfig {
  if (!raw || typeof raw !== "object") return defaultConfig();
  const r = raw as Record<string, unknown>;
  return { enabled: r.enabled !== false, deferred: r.deferred !== false }; // absent → default true
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

export async function writeScheduleConfig(patch: Partial<ScheduleConfig>): Promise<void> {
  // 读-改-写整对象：设置页只翻 enabled 时不能把 deferred 试点字段抹掉。
  const next: ScheduleConfig = { ...readScheduleConfigSync(), ...patch };
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2), "utf-8");
}

function configPath(): string {
  return join(getAgentDir(), SCHEDULE_CONFIG_FILE);
}