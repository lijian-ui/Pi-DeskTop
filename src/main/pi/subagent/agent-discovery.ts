import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * A subagent role definition, parsed from a Markdown file
 * (`~/.pi/agent/agents/**.md` for user scope, `<cwd>/.pi/agents/**.md` for project scope).
 * Plus a built-in default roster (researcher/reviewer/worker) that is always
 * available and overridable by a same-named user/project file.
 *
 * Frontmatter schema (subset of pi-subagents, kept compatible):
 *   name              unique role id
 *   description       shown in agent discovery lists
 *   aliases          comma / block-list of alternate names
 *   tools             allowlist (comma or block list); omitted => all built-ins
 *   excludeTools      denylist applied on top of tools
 *   model             optional model id override (v1: parsed, applied best-effort)
 *   thinking          optional thinking level (off|minimal|low|medium|high|xhigh|max)
 *   async             default foreground/background hint (reserved)
 * Body (after frontmatter) = the role's instruction; injected as the first user message.
 */

export interface SubagentDef {
  name: string;
  description: string;
  aliases: string[];
  tools: string[] | null; // null => inherit all built-in tools
  excludeTools: string[];
  model?: string;
  thinking?: string;
  async: boolean;
  body: string;
  scope: "builtin" | "user" | "project";
  sourcePath: string;
}

/** 作用域优先级：同名角色高者覆盖低者（builtin < user < project）。 */
const SCOPE_PRIORITY: Record<SubagentDef["scope"], number> = { builtin: 0, user: 1, project: 2 };

/**
 * 内置默认角色（开箱即用，最低优先级）：用户在 ~/.pi/agent/agents/ 或
 * <cwd>/.pi/agents/ 放同名 .md 即可覆盖任意一个。
 * 人设参照 billion-context 的固定花名册（reviewer/researcher/worker 三件套），
 * 只读角色限定 read/bash/grep/find/ls，worker 用全量内置工具集（tools:null）。
 */
const BUILTIN_AGENTS: SubagentDef[] = [
  {
    name: "researcher",
    description: "代码调研/侦察：探索代码库、回答问题，输出精确 file:line、签名与关键片段（只读）",
    aliases: ["scout", "investigate"],
    tools: ["read", "bash", "grep", "find", "ls"],
    excludeTools: [],
    async: false,
    scope: "builtin",
    sourcePath: "<builtin>",
    body:
      "你是代码调研员（只读）。彻底调研代码库以回答问题：结论必须附带精确的 file:line、函数/类型签名与关键代码片段。\n" +
      "严禁修改、创建或删除任何文件——只读取和报告。报告结构：概述 → 关键证据（带引用）→ 结论。",
  },
  {
    name: "reviewer",
    description: "代码审查：找 bug、安全风险、正确性问题并给出可执行的改进建议（只读）",
    aliases: ["code-review"],
    tools: ["read", "bash", "grep", "find", "ls"],
    excludeTools: [],
    async: false,
    scope: "builtin",
    sourcePath: "<builtin>",
    body:
      "你是资深代码审查员（只读）。审查给定代码：bug、安全/风险隐患、正确性问题、具体可落地的改进建议。\n" +
      "每条发现必须给出精确 file:line；按严重程度排序；给出结论（可合并/需修改/有阻断问题）。\n" +
      "严禁修改任何文件——只读取和报告。",
  },
  {
    name: "worker",
    description: "精确实现：按明确要求做最小化代码改动并简要汇报（全量工具）",
    aliases: ["implementer"],
    tools: null,
    excludeTools: [],
    async: false,
    scope: "builtin",
    sourcePath: "<builtin>",
    body:
      "你是精确实现者。只做任务明确要求的改动：最小化、聚焦、遵循项目现有惯例（有 AGENTS.md 先读）。\n" +
      "完成后简要总结改了什么、为什么。不要扩大范围，不要顺手重构。",
  },
];

function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: raw.trim() };

  const data: Record<string, unknown> = {};
  const lines = m[1].split(/\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!kv) {
      i++;
      continue;
    }
    const key = kv[1];
    const val = kv[2].trim();

    // Block list: following lines start with "- "
    if (val === "" || val === "|") {
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+(.*)$/.test(lines[j])) {
        items.push(lines[j].match(/^\s*-\s+(.*)$/)![1].trim());
        j++;
      }
      data[key] = items;
      i = j;
      continue;
    }

    if (val.includes(",")) {
      data[key] = val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (val === "true") {
      data[key] = true;
    } else if (val === "false") {
      data[key] = false;
    } else {
      data[key] = val;
    }
    i++;
  }
  return { data, body: m[2].trim() };
}

function asStringArray(v: unknown): string[] | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return null;
}

function loadDir(dir: string, scope: "user" | "project", out: Map<string, SubagentDef>): void {
  if (!fs.existsSync(dir)) return;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(p);
      } else if (e.name.endsWith(".md")) {
        const raw = fs.readFileSync(p, "utf-8");
        const { data, body } = parseFrontmatter(raw);
        const name = String(data.name ?? "").trim();
        // 必须是 continue：return 会中断整个目录的遍历，一个缺 name 的文件
        // 会让它后面的所有 agent 定义都发现不了。
        if (!name) continue;
        const def: SubagentDef = {
          name,
          description: String(data.description ?? name),
          aliases: asStringArray(data.aliases) ?? [],
          tools: asStringArray(data.tools),
          excludeTools: asStringArray(data.excludeTools) ?? [],
          model: data.model ? String(data.model) : undefined,
          thinking: data.thinking ? String(data.thinking) : undefined,
          async: data.async === true || data.async === "true",
          body,
          scope,
          sourcePath: p,
        };
        // 同名冲突按作用域优先级覆盖（builtin < user < project）；
        // 同作用域内先到先得（同目录重名取先扫描到的那个）。
        const prev = out.get(name);
        if (!prev || SCOPE_PRIORITY[scope] > SCOPE_PRIORITY[prev.scope]) out.set(name, def);
      }
    }
  };
  walk(dir);
}

/** List all discovered subagent roles for a workspace（builtin < user < project，后者覆盖前者）。 */
export function listAgents(cwd: string): SubagentDef[] {
  const out = new Map<string, SubagentDef>();
  for (const def of BUILTIN_AGENTS) out.set(def.name, def);
  loadDir(path.join(getAgentDir(), "agents"), "user", out);
  if (cwd) loadDir(path.join(cwd, ".pi", "agents"), "project", out);
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve a role by name or alias (case-insensitive). */
export function getAgent(cwd: string, name: string): SubagentDef | undefined {
  const lower = name.trim().toLowerCase();
  if (!lower) return undefined;
  const all = listAgents(cwd);
  return all.find(
    (a) => a.name.toLowerCase() === lower || a.aliases.some((al) => al.toLowerCase() === lower)
  );
}
