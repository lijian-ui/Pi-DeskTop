/**
 * 子代理委托总开关（~/.pi/agent/subagent-config.json）。
 *
 * 风格照 compress-config：工厂加载时同步读一次；关 → 直接 return，不注册
 * `subagent` 工具，也不追加「优先委托」的系统提示段落。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_ROOT } from "../memory/paths";

export interface SubagentConfig {
  /** 缺省开：老用户升级后行为不变。 */
  enabled: boolean;
}

const CONFIG_FILE = "subagent-config.json";

function configPath(): string {
  return join(AGENT_ROOT, CONFIG_FILE);
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readSubagentConfigSync(): SubagentConfig {
  try {
    const raw = JSON.parse(stripBom(readFileSync(configPath(), "utf-8"))) as Record<string, unknown>;
    return { enabled: raw.enabled !== false };
  } catch {
    return { enabled: true };
  }
}

export async function writeSubagentConfig(patch: Partial<SubagentConfig>): Promise<void> {
  const next: SubagentConfig = { ...readSubagentConfigSync(), ...patch };
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2), "utf-8");
}
