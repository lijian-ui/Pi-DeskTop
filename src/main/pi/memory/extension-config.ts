/**
 * 记忆扩展总开关（~/.pi/agent/memory-extension-config.json）。
 *
 * 与 hermes-memory-config.json 区分：后者管记忆内部行为（沉淀阈值、排序、
 * 锚点、守卫），本文件只管「这个扩展要不要挂载」。风格照 compress-config：
 * 工厂加载时同步读一次；关 → 直接 return，不注册工具、不挂任何事件。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_ROOT } from "./paths";

export interface MemoryExtensionConfig {
  /** 缺省开：老用户升级后行为不变。 */
  enabled: boolean;
}

const CONFIG_FILE = "memory-extension-config.json";

function configPath(): string {
  return join(AGENT_ROOT, CONFIG_FILE);
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readMemoryExtensionConfigSync(): MemoryExtensionConfig {
  try {
    const raw = JSON.parse(stripBom(readFileSync(configPath(), "utf-8"))) as Record<string, unknown>;
    return { enabled: raw.enabled !== false };
  } catch {
    return { enabled: true };
  }
}

export async function writeMemoryExtensionConfig(patch: Partial<MemoryExtensionConfig>): Promise<void> {
  const next: MemoryExtensionConfig = { ...readMemoryExtensionConfigSync(), ...patch };
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2), "utf-8");
}
