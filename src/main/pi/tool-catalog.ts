/**
 * Tool catalog — single source of truth for the 设置 → 可用工具 page.
 *
 * Two tool families, two enable mechanisms:
 *  - Built-in SDK tools: `settings.json` `activeTools` (handled by
 *    PiSessionManager — BUILTIN_TOOL_NAMES lives here so both sides agree).
 *  - First-party extension tools: registered by extension factories
 *    (session-manager `extensionFactories`); each feature is gated by its own
 *    `*-config.json` `enabled`. The switch in the settings UI writes that
 *    config; PiSessionManager then re-applies the active-tool set so enabled
 *    tools stay / disabled tools leave the session's active set.
 *
 * Keep the FEATURES table in sync whenever a new first-party tool extension
 * is added (mirror of docs/pi-tool-extension-guide.md §5).
 */
import { readTodoConfigSync, writeTodoConfig } from "./todo/todo-config";
import { readAskUserConfigSync, writeAskUserConfig } from "./ask-user/ask-user-config";
import { readBrowserConfigSync, writeBrowserConfig } from "./browser/browser-config";
import { readScheduleConfigSync, writeScheduleConfig } from "./schedule/schedule-config";
import {
  mcpServerCapabilities,
  readMcpFeatureConfig,
  readMcpFeatureConfigSync,
  writeMcpFeatureConfig,
} from "./mcp/mcp-config";
import {
  readWebSearchConfig,
  readWebSearchConfigSync,
  writeWebSearchConfig,
} from "../websearch/config";
import type {
  ExtensionToolFeature,
  ExtensionToolFeatureUpdate,
  ToolMode,
} from "../../shared/tool-catalog-types";

/** Built-in tools the Pi SDK registers (docs/sdk.md:492). The SDK activates
 * only read/bash/edit/write by default; the rest are opt-in via settings.json
 * `activeTools`. */
export const BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/**
 * Chat-composer tool modes. A mode is the SESSION-LEVEL lens: which built-in
 * tools and which extension FEATURES a workspace's live session may keep in
 * its active set. The global config (settings.activeTools + *-config enabled)
 * stays the ceiling — a mode can only NARROW it (see comment on ToolMode).
 *
 * If you add a new feature that should appear in 办公 mode, register it in
 * FEATURES below with key "office" (or extend TOOL_MODES.office.features).
 */
export const TOOL_MODES: Record<ToolMode, { builtins: readonly string[]; features: readonly string[] }> = {
  // Only read / bash / write + the subagent delegation channel.
  minimal: { builtins: ["read", "bash", "write"], features: ["subagent"] },
  // Everything first-party (subagent and memory have no switch, so they are
  // listed too).
  standard: {
    builtins: BUILTIN_TOOL_NAMES,
    features: ["subagent", "todo", "ask-user", "web-search", "office", "memory", "send-file", "schedule", "mcp"],
  },
  // Standard + the planned office-operation feature set (registered later as
  // FEATURES key "office"; harmless while the feature does not exist yet).
  office: {
    builtins: BUILTIN_TOOL_NAMES,
    features: ["subagent", "todo", "ask-user", "web-search", "office", "memory", "send-file", "schedule", "mcp"],
  },
};

/** 扩展特性定义：在 UI 载荷字段之外，额外支持动态工具名的前缀匹配。 */
interface FeatureDef extends Omit<ExtensionToolFeature, "enabled"> {
  /**
   * 无法穷举名字的工具前缀（MCP 的 `mcp__<server>__<tool>` 由服务器在运行时
   * 决定），命中的名字归到本特性。
   */
  prefixes?: string[];
}

/**
 * MCP 扩展带进来的固定名工具（非 `mcp__` 前缀那批）：
 *  - `codemode` / `tool_search`：SDK 的间接调用通道，注册时是 inactive，
 *    由 MCP 扩展在「有服务器用该 exposure 连上」时自动激活；
 *  - 三个资源工具：有服务器提供 resources 时被注册。
 */
const MCP_INFRA_TOOL_NAMES = [
  "codemode",
  "tool_search",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
];

/** 三个 MCP 资源工具（它们的可用性取决于「是否至少有一个 enabled 服务器」）。 */
const MCP_RESOURCE_TOOL_NAMES = [
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
];

/** 是否为 MCP 相关工具名（含 `mcp__` 前缀与固定名的基础工具）。 */
export function isMcpToolName(name: string): boolean {
  return name.startsWith("mcp__") || MCP_INFRA_TOOL_NAMES.includes(name);
}

/**
 * 是否为「服务器无关」的 MCP 资源工具。它们能读取任意已连接服务器的资源，
 * 因此无人值守白名单光拦 `mcp__*` 不够 —— 还得把这三个一并挡掉。
 */
export function isMcpResourceTool(name: string): boolean {
  return MCP_RESOURCE_TOOL_NAMES.includes(name);
}

/**
 * 固定名的 MCP 基础工具是否需要放行。
 *
 * `mcp__*` 不需要这层判断：它们只有在服务器真的连上并注册后才会出现在
 * getAllTools() 里。但 codemode / tool_search / 资源工具是扩展**无条件注册**的，
 * 若只凭「mcp 特性开启」就放行，没配任何服务器时也会凭空多出一个 codemode 工具。
 * 所以这里回读 mcp.json：只有当存在对应 exposure 的 enabled 服务器时才放行。
 */
export function mcpInfraAllowed(name: string): boolean {
  if (!readMcpFeatureConfigSync().enabled) return false;
  const caps = mcpServerCapabilities();
  // autoEnableCodemode 为 false 时，SDK 不会激活 codemode —— 宿主重跑显式工具集
  // 时也必须尊重它，否则等于绕过用户的显式选择。
  if (name === "codemode") return caps.hasCodemode && caps.autoEnableCodemode;
  if (name === "tool_search") return caps.hasDeferred;
  if (MCP_RESOURCE_TOOL_NAMES.includes(name)) return caps.hasEnabled;
  return false;
}

/** Map a registered tool name back to its extension feature key (undefined
 * for built-in tools). Used to decide whether a mode's feature allowlist
 * admits an extension tool. */
export function featureKeyForToolName(name: string): string | undefined {
  for (const f of FEATURES) {
    if (f.toolNames.includes(name)) return f.key;
    if (f.prefixes?.some((p) => name.startsWith(p))) return f.key;
  }
  return undefined;
}

/** Whether a mode allows the given tool name (built-in or extension). */
export function modeAllowsTool(mode: ToolMode, name: string): boolean {
  const def = TOOL_MODES[mode];
  if (BUILTIN_TOOL_NAMES.includes(name)) return def.builtins.includes(name);
  const key = featureKeyForToolName(name);
  return key !== undefined && def.features.includes(key);
}

/** Static description of every first-party extension tool feature. */
const FEATURES: ReadonlyArray<FeatureDef> = [
  {
    key: "todo",
    toolNames: ["todo"],
    switchable: true,
    configFile: "todo-config.json",
  },
  {
    key: "ask-user",
    toolNames: ["ask_user_question"],
    switchable: true,
    configFile: "askuser-config.json",
  },
  {
    key: "web-search",
    toolNames: ["web_search", "web_fetch"],
    switchable: true,
    configFile: "websearch-config.json",
  },
  {
    // 业务系统 browser-use（伴侣 Chrome 扩展 + 本地回环桥）。
    // 挂载在普通会话与定时任务两个数组（见 session-manager）。
    key: "office",
    // 业务系统 browser-use：单一 `browser` 工具（action 参数区分操作），
    // 内核 send→bridge→service_worker 不变。挂载在普通会话与定时任务两个数组（见 session-manager）。
    toolNames: ["browser"],
    switchable: true,
    configFile: "browser-config.json",
  },
  {
    key: "subagent",
    toolNames: ["subagent"],
    switchable: false, // always loaded with the app; no separate config today
    configFile: "",
  },
  {
    key: "send-file",
    toolNames: ["send_file"],
    switchable: true,
    configFile: "sendfile-config.json",
  },
  {
    // Scheduled tasks: create/manage the same tasks the 自动化 page edits.
    // Mounted in normal/workspace sessions only (never inside a scheduled run).
    key: "schedule",
    toolNames: ["schedule"],
    switchable: true,
    configFile: "schedule-config.json",
  },
  {
    // Persistent memory layer (src/main/pi/memory, ported from
    // pi-hermes-memory). Always on like subagent — no separate config today.
    key: "memory",
    toolNames: [
      "memory_add",
      "memory_replace",
      "memory_remove",
      "memory_search",
      "session_search",
      "skill_manage",
    ],
    switchable: false,
    configFile: "",
  },
  {
    // MCP（Model Context Protocol）服务器：由 SDK 的 createMcpExtension 提供，
    // 服务器定义在 ~/.pi/agent/mcp.json（与 CLI / Claude Desktop / Cursor 共享）。
    // 工具名是运行期才知道的 `mcp__<server>__<tool>`，所以靠 prefixes 归类；
    // 另有 codemode / tool_search / 资源工具这几个固定名，见 MCP_INFRA_TOOL_NAMES。
    key: "mcp",
    toolNames: MCP_INFRA_TOOL_NAMES,
    prefixes: ["mcp__"],
    switchable: true,
    configFile: "mcp-config.json",
  },
];

function readFeatureEnabled(key: string): boolean {
  switch (key) {
    case "todo":
      return readTodoConfigSync().enabled;
    case "ask-user":
      return readAskUserConfigSync().enabled;
    case "web-search":
      return readWebSearchConfigSync().enabled;
    case "office":
      return readBrowserConfigSync().enabled;
    case "schedule":
      return readScheduleConfigSync().enabled;
    case "mcp":
      return readMcpFeatureConfigSync().enabled;
    default:
      return true; // subagent (or unknown) → always on
  }
}

/** Full feature list with live enabled states, for the settings UI. */
export function readExtensionToolFeaturesSync(): ExtensionToolFeature[] {
  return FEATURES.map((f) => ({
    key: f.key,
    toolNames: f.toolNames,
    switchable: f.switchable,
    configFile: f.configFile,
    enabled: readFeatureEnabled(f.key),
  }));
}

/**
 * Whether one extension tool name belongs to a feature that is SWITCHED OFF.
 * Used when re-applying the active-tool set on live sessions: these must be
 * dropped even though they are still registered (config only gates future
 * registration; already-running units keep the tools in their registry).
 *
 * Works by name (not by a prebuilt Set) because the MCP feature owns runtime
 * tool names that cannot be enumerated up front.
 */
export function isExtensionToolDisabled(name: string): boolean {
  for (const f of FEATURES) {
    if (!f.switchable) continue;
    const hit = f.toolNames.includes(name) || f.prefixes?.some((p) => name.startsWith(p));
    if (hit) return !readFeatureEnabled(f.key);
  }
  return false;
}

/** Persist a feature's enabled flag to its config file. */
export async function setExtensionToolFeatureEnabled(
  key: string,
  enabled: boolean,
): Promise<void> {
  switch (key) {
    case "todo":
      await writeTodoConfig({ enabled });
      return;
    case "ask-user":
      await writeAskUserConfig({ enabled });
      return;
    case "web-search": {
      // Preserve the rest of the config (providers/keys/limits) — never
      // overwrite with a bare {enabled}.
      const cfg = await readWebSearchConfig();
      cfg.enabled = enabled;
      await writeWebSearchConfig(cfg);
      return;
    }
    case "office": {
      // 读-改-写整对象，保留 allowedDomains / screenshot 等字段。
      await writeBrowserConfig({ enabled });
      return;
    }
    case "schedule":
      await writeScheduleConfig({ enabled });
      return;
    case "mcp": {
      // 读-改-写整对象，保留 autoApproveServers / unattendedServers 白名单。
      const cfg = await readMcpFeatureConfig();
      cfg.enabled = enabled;
      await writeMcpFeatureConfig(cfg);
      return;
    }
    default:
      return; // subagent / unknown → not switchable, ignore
  }
}

export async function applyExtensionToolFeatureUpdates(
  updates: readonly ExtensionToolFeatureUpdate[],
): Promise<void> {
  for (const u of updates) {
    await setExtensionToolFeatureEnabled(u.key, u.enabled);
  }
}
