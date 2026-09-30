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
    features: ["subagent", "todo", "ask-user", "web-search", "office", "memory", "send-file"],
  },
  // Standard + the planned office-operation feature set (registered later as
  // FEATURES key "office"; harmless while the feature does not exist yet).
  office: {
    builtins: BUILTIN_TOOL_NAMES,
    features: ["subagent", "todo", "ask-user", "web-search", "office", "memory", "send-file"],
  },
};

/** Map a registered tool name back to its extension feature key (undefined
 * for built-in tools). Used to decide whether a mode's feature allowlist
 * admits an extension tool. */
export function featureKeyForToolName(name: string): string | undefined {
  for (const f of FEATURES) {
    if (f.toolNames.includes(name)) return f.key;
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
const FEATURES: ReadonlyArray<Omit<ExtensionToolFeature, "enabled">> = [
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
    default:
      return true; // subagent (or unknown) → always on
  }
}

/** Full feature list with live enabled states, for the settings UI. */
export function readExtensionToolFeaturesSync(): ExtensionToolFeature[] {
  return FEATURES.map((f) => ({ ...f, enabled: readFeatureEnabled(f.key) }));
}

/**
 * Names of extension tools that are currently SWITCHED OFF. Used when
 * re-applying the active-tool set on live sessions: these must be dropped
 * even though they are still registered (config only gates future
 * registration; already-running units keep the tools in their registry).
 */
export function disabledExtensionToolNames(): Set<string> {
  const disabled = new Set<string>();
  for (const f of FEATURES) {
    if (f.switchable && !readFeatureEnabled(f.key)) {
      for (const n of f.toolNames) disabled.add(n);
    }
  }
  return disabled;
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
