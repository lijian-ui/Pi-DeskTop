/**
 * Standalone skill extension — owns the `skill_manage` tool and skill
 * discovery/migration, split out of the memory extension so the two can be
 * toggled independently (设置 → 可用工具 → 扩展工具).
 *
 * Physical storage still lives under src/main/pi/memory/{store,tools} —
 * SkillStore and the tool registration are shared code, only ownership moved.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SkillStore } from "../memory/store/skill-store";
import { registerSkillTool } from "../memory/tools/skill-tool";
import { detectProjectSkills } from "../memory/project";
import { AGENT_ROOT } from "../memory/paths";
import { loadConfig } from "../memory/config";
import { readSkillsConfigSync } from "./skills-config";

export function resolveProjectSkillDiscovery(
  skillStore: SkillStore,
  projectsMemoryDir: string | undefined,
  cwd?: string,
): { skillPaths: string[] } {
  const detected = detectProjectSkills(projectsMemoryDir, cwd);
  skillStore.setProjectContext(detected.name, detected.skillsDir);

  // This extension writes its generated skills directly into Pi's own global
  // skills root (~/.pi/agent/skills/), so Pi discovers them on load without any
  // extra bridging. We still contribute the path here for explicit discovery.
  const skillPaths = [skillStore.getGlobalSkillsDir()];
  if (detected.skillsDir) skillPaths.push(detected.skillsDir);
  return { skillPaths };
}

export default function (pi: ExtensionAPI) {
  // 总开关：关 → 不注册工具、不挂技能发现/迁移钩子。
  if (!readSkillsConfigSync().enabled) return;

  const agentRoot = AGENT_ROOT;
  const legacyGlobalDir = path.join(agentRoot, "memory");
  // 技能的项目归属沿用记忆配置里的 projectsMemoryDir（同一套项目识别规则）。
  const projectsMemoryDir = loadConfig().projectsMemoryDir;

  const skillStore = new SkillStore({
    globalSkillsDir: path.join(agentRoot, "skills"), // 全局技能固定落 agent 根 skills（原跟随 memoryDir 默认会落到 pi-hermes-memory/skills）
    piGlobalSkillsDir: path.join(agentRoot, "skills"),
    projectSkillsDir: null,
    projectName: null,
    legacySkillsDir: path.join(legacyGlobalDir, "skills"),
    migrationSentinelPath: path.join(agentRoot, ".skills-migrated-to-extension-storage"),
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      resolveProjectSkillDiscovery(skillStore, projectsMemoryDir, ctx.cwd);
      await skillStore.migrateLegacySkills();
      await skillStore.ensureDiscoveredRoots();
    } catch {
      // Best-effort: skill discovery must not block session startup.
    }
  });

  pi.on("resources_discover", async (event, _ctx) => {
    return resolveProjectSkillDiscovery(skillStore, projectsMemoryDir, (event as { cwd?: string }).cwd);
  });

  registerSkillTool(pi, skillStore);
}
