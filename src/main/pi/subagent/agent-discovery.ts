import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * A subagent role definition, parsed from a Markdown file
 * (`~/.pi/agent/agents/**.md` for user scope, `<cwd>/.pi/agents/**.md` for project scope).
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
  scope: "user" | "project";
  sourcePath: string;
}

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
        if (!name) return; // unnamed agents are skipped
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
        // project overrides user on name collision
        if (scope === "project" || !out.has(name)) out.set(name, def);
      }
    }
  };
  walk(dir);
}

/** List all discovered subagent roles for a workspace (project overrides user). */
export function listAgents(cwd: string): SubagentDef[] {
  const out = new Map<string, SubagentDef>();
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
