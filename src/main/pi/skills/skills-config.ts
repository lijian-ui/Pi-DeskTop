/**
 * 技能扩展总开关（~/.pi/agent/skills-config.json）。
 *
 * 风格照 compress-config：工厂加载时同步读一次；关 → 直接 return，不注册
 * `skill_manage` 工具，也不挂技能发现/迁移钩子。与「长期记忆」开关互相独立。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_ROOT } from "../memory/paths";

export interface SkillsConfig {
  /** 缺省开：老用户升级后行为不变。 */
  enabled: boolean;
}

const CONFIG_FILE = "skills-config.json";

function configPath(): string {
  return join(AGENT_ROOT, CONFIG_FILE);
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readSkillsConfigSync(): SkillsConfig {
  try {
    const raw = JSON.parse(stripBom(readFileSync(configPath(), "utf-8"))) as Record<string, unknown>;
    return { enabled: raw.enabled !== false };
  } catch {
    return { enabled: true };
  }
}

export async function writeSkillsConfig(patch: Partial<SkillsConfig>): Promise<void> {
  const next: SkillsConfig = { ...readSkillsConfigSync(), ...patch };
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2), "utf-8");
}
