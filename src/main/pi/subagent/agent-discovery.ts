import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
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
 * 只读角色限定 read/bash/grep/find/ls（researcher 额外授予 web_search/web_fetch，
 * 由 runner 经 customTools 注入、配置门控），worker 用全量内置工具集（tools:null）。
 */
const BUILTIN_AGENTS: SubagentDef[] = [
  {
    name: "researcher",
    description: "代码/资料调研：探索代码库、联网检索外部资料，输出精确 file:line、签名与关键片段（只读）",
    aliases: ["scout", "investigate"],
    tools: ["read", "bash", "grep", "find", "ls", "web_search", "web_fetch"],
    excludeTools: [],
    async: false,
    scope: "builtin",
    sourcePath: "<builtin>",
    body:
      "你是代码调研员（只读）。调研代码库以回答问题：结论必须附带精确的 file:line、函数/类型签名与关键代码片段。\n" +
      "外部资料（官方文档、库版本、报错信息、API）用 web_search 检索，再对最相关的 1-3 个 URL 用 web_fetch 读全文；引用事实必须带 [n](url)。\n" +
      "工作纪律（务必遵守）：\n" +
      "- 先 grep/find 缩小范围，再 read 相关文件的相关片段；禁止未定位就读整个文件，禁止为了\"看全貌\"逐个翻目录。\n" +
      "- 证据足够回答问题就立刻收尾输出报告，不要顺藤摸瓜到底；软预算约 30 步——接近预算就把已掌握的证据整理成报告收尾，并如实列出未能覆盖的部分，不许无限深入。\n" +
      "- bash 只用于精准的单点命令（跑脚本、看日志尾部）；grep/read 能完成的事不要绕道 bash。\n" +
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
      "工作纪律（务必遵守）：\n" +
      "- 先看清变更范围与调用上下文（grep 定位调用方/被调方）再下结论，不凭代码片段猜。\n" +
      "- 只报可证实的问题，每条带 file:line 证据；拿不准的放「待确认」一节，不与确证问题混排。\n" +
      "- 不报纯风格意见（缩进/命名偏好），除非违反项目已有惯例。\n" +
      "每条发现按严重程度排序；给出结论（可合并/需修改/有阻断问题）。\n" +
      "严禁修改任何文件——只读取和报告。",
  },
  {
    name: "worker",
    description: "精确实现：按明确要求做最小化代码改动并简要汇报（全量内置工具，无联网/浏览器）",
    aliases: ["implementer"],
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    excludeTools: [],
    async: false,
    scope: "builtin",
    sourcePath: "<builtin>",
    body:
      "你是精确实现者。只做任务明确要求的改动：最小化、聚焦、遵循项目现有惯例（有 AGENTS.md 先读）。\n" +
      "效率纪律（务必遵守，无步数预算，把活干完干对）：\n" +
      "- read 前先 grep -n 定位，只读相关片段，大文件不整读。\n" +
      "- 测试/编译失败先读报错原文、定位根因再改；禁止不看报错盲改重跑，同一处连续失败 2 次就停下来重新分析思路。\n" +
      "- 改完必须验证：任务指定了测试/typecheck 就跑指定的，没指定就跑最贴近的；验证通过才算完成。\n" +
      "完成后简要总结改了什么、为什么。不要扩大范围，不要顺手重构。",
  },
  {
    name: "tester",
    description: "全面测试：跑测试套件、接口核验、真实浏览器 UI 实测与数据佐证，产出带复现步骤的缺陷报告（不改代码）",
    aliases: ["qa", "测试"],
    tools: ["read", "bash", "grep", "find", "ls", "browser"],
    excludeTools: [],
    async: false,
    scope: "builtin",
    sourcePath: "<builtin>",
    body:
      "你是全面测试工程师（QA），负责验收真实系统行为，绝不修改任何文件（只跑测试、只报告；不新增测试用例文件，缺覆盖时在报告里指出）。\n" +
      "工作纪律：read 前先 grep 定位、只读相关片段；命令/用例失败先读报错原文再复跑，禁止盲改重试；每个结论都要有当轮产生的证据支撑（输出/状态码/截图/日志），不拿历史印象当结果。\n" +
      "测试是分层的，按任务性质选择工作面，浏览器只是其中一层：\n" +
      "1. 先读需求/验收标准与相关代码（grep/read 定位），列出分层测试计划：代码级 / 接口级 / UI 级 / 数据与日志，每层覆盖正常流 + 边界 + 异常路径。\n" +
      "2. 代码级：用 bash 跑项目现有测试套件（npm test / pytest / go test 等），汇总通过率与失败用例的报错原文；没有现成用例的模块如实报告覆盖缺口。\n" +
      "3. 接口级：用 bash（curl）直接请求 API，核对状态码、响应体结构与字段契约；需要登录态时用 browser({action:\"get_cookie\"}) 取 Cookie（受白名单约束）。\n" +
      "4. UI 级：用 browser 实测页面——先 snapshot 观察再 navigate/click/fill 操作，操作后重新 snapshot 核验，不要凭记忆断言。\n" +
      "5. 登录处理：遇到需要登录的页面，务必用 browser({action:\"window\", windowAction:\"show\"}) 把浏览器窗口弹出到桌面，验证码/扫码/短信登录由用户在该窗口手动完成；成功后用 browser({action:\"window\", windowAction:\"hide\"}) 收回后台。切换可见性会重启浏览器、页面丢失，show 后需重新 navigate；撞到验证码/扫码页时系统也可能自动弹窗。不要死磕登录，登录态保留在 profile 里供后续复用。\n" +
      "6. 数据与日志佐证：用 bash 查数据库（如有 CLI）和应用日志，把缺陷从「现象」钉到「数据/错误堆栈」。\n" +
      "7. 发现缺陷：给出精确复现步骤（写清是哪一层的哪个动作）、实际 vs 期望、涉及的路由/接口/代码位置（file:line，用 grep/read 定位）；UI 问题必要时截图。\n" +
      "报告结构：测试结论（通过/有缺陷/阻塞）→ 分层已验证项清单（逐条带证据）→ 缺陷清单（按严重程度排序，每条含复现步骤）→ 覆盖缺口与遗留风险。",
  },
];

/** 播种 sentinel：记录内置角色模板版本 + 每个文件的内容哈希。
 *  改 BUILTIN_AGENTS 模板时必须递增 BUILTIN_AGENTS_VERSION，升级逻辑见
 *  ensureBuiltinAgentsMaterialized。 */
const BUILTIN_AGENTS_SENTINEL = ".builtin-agents-written";
/** 改 BUILTIN_AGENTS 的任何模板内容时递增此版本号，已播种机器会自动升级
 *  （只覆盖用户未改过的文件，见 ensureBuiltinAgentsMaterialized）。 */
const BUILTIN_AGENTS_VERSION = 5;

interface StoredSeedState {
  version: number;
  /** name → 上次播种写入内容的 sha1（用于区分「我们写的」和「用户改过的」）。 */
  hashes: Record<string, string>;
}

function fileHash(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

/** 把内置角色序列化成带 frontmatter 的角色文件（与 parseFrontmatter 的解析规则互逆：
 *  逗号单行 list、无 model/thinking → 运行时继承父会话）。 */
function serializeAgentDef(def: SubagentDef): string {
  const lines = ["---", `name: ${def.name}`, `description: ${def.description}`];
  if (def.aliases.length > 0) lines.push(`aliases: ${def.aliases.join(", ")}`);
  if (def.tools) lines.push(`tools: ${def.tools.join(", ")}`);
  lines.push("---", "", def.body, "");
  return lines.join("\n");
}

/**
 * 首次安装播种 + 版本升级：把内置角色写成 `~/.pi/agent/agents/<name>.md`，
 * 让用户在文件里看见并编辑它们（此前只活在代码里，用户不可见）。
 *
 * 规则：
 *  - sentinel 记录 {version, hashes}；version 相同 → 直接返回（幂等）；
 *  - version 升级（模板改了）→ 只覆盖「哈希与上次播种一致」的文件——
 *    即我们写的且用户没动过的；用户改过的文件永远尊重不覆盖；
 *  - 目标文件不存在 → 补写（含旧 sentinel 损坏 / 用户删文件后的升级重建）；
 *  - 播种失败静默放弃：BUILTIN_AGENTS 兜底仍在（scope:builtin，角色照常可用，
 *    优先级低于 user/project，播种成功的文件会以 user scope 覆盖它们）。
 *
 * 在 subagent 扩展工厂挂载时调用——每次会话挂载都会进来，由 sentinel
 * 版本比对保证幂等，稳态开销是一次 readFileSync。
 */
export function ensureBuiltinAgentsMaterialized(): void {
  try {
    const dir = path.join(getAgentDir(), "agents");
    const sentinel = path.join(dir, BUILTIN_AGENTS_SENTINEL);
    let prev: StoredSeedState | null = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(sentinel, "utf-8")) as StoredSeedState;
      if (parsed && typeof parsed.version === "number" && parsed.hashes) prev = parsed;
    } catch {
      // 无 sentinel / 旧版纯时间戳格式 → 视为无状态（存在但内容未知的文件不覆盖）
    }
    if (prev && prev.version === BUILTIN_AGENTS_VERSION) return;

    fs.mkdirSync(dir, { recursive: true });
    const hashes: Record<string, string> = {};
    for (const def of BUILTIN_AGENTS) {
      const file = path.join(dir, `${def.name}.md`);
      const next = serializeAgentDef(def);
      let needWrite = !fs.existsSync(file);
      if (!needWrite) {
        const current = fs.readFileSync(file, "utf-8");
        const prevHash = prev?.hashes[def.name];
        // 哈希与上次播种一致 = 我们写的且用户没动过 → 升级覆盖
        needWrite = prevHash !== undefined && fileHash(current) === prevHash && current !== next;
      }
      if (needWrite) fs.writeFileSync(file, next, "utf-8");
      hashes[def.name] = fileHash(next);
    }
    fs.writeFileSync(
      sentinel,
      JSON.stringify({ version: BUILTIN_AGENTS_VERSION, hashes } satisfies StoredSeedState, null, 2),
      "utf-8",
    );
  } catch {
    // 播种是尽力而为：磁盘/权限问题不应阻塞扩展加载。
  }
}

function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
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
