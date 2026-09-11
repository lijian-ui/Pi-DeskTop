/**
 * Tool catalog — shared payload types for the 设置 → 可用工具 page.
 *
 * The page has two families of tools with two independent enable/disable
 * mechanisms:
 *  - Built-in SDK tools (read/bash/edit/write/grep/find/ls): toggled via
 *    settings.json `activeTools` (PiSessionManager.saveActiveTools).
 *  - First-party extension tools (todo / ask_user_question / web_search /
 *    web_fetch / subagent): registered by extension factories; each feature
 *    is gated by its own `*-config.json` `enabled` (see tool-catalog.ts in
 *    the main process for the single source of truth).
 */
export interface ExtensionToolFeature {
  /** Stable feature key — matches the renderer's i18n keys (tools.ext.<key>). */
  key: string;
  /** Tool names this feature registers (what the model calls). */
  toolNames: string[];
  /** Whether the user can toggle it (subagent has no switch today). */
  switchable: boolean;
  /** Current enabled state from the feature's config file. */
  enabled: boolean;
  /** Config file the switch writes to (display only). */
  configFile: string;
}

export interface ExtensionToolFeatureUpdate {
  key: string;
  enabled: boolean;
}

/**
 * Chat-composer tool modes (per-workspace preset). A mode is a SESSION-LEVEL
 * (per cwd/unit) lens applied on top of the global tool config: the final
 * active set of a session = (global built-in selection ∩ mode's builtins) ∪
 * (globally-enabled extension features ∩ mode's features). Switching a mode
 * only touches the active set of the ONE workspace's unit — it never rewrites
 * settings.json `activeTools` or any *-config.json, so other sessions and the
 * global 可用工具 page are unaffected.
 */
export type ToolMode = "minimal" | "standard" | "office";
