import {
  createToolSearchExtension,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

/**
 * Shared mounting helper for `exposure: "deferred"` pilot tools (browser,
 * schedule, …). One call per tool wires up everything the pilot needs:
 *
 *  1. `tool_search` — the on-demand load channel. Mounted independently here
 *     because MCP may be disabled (createMcpMount would not mount it); a
 *     duplicate same-name registration is harmless (first-registration-wins).
 *  2. A `before_agent_start` handler doing two jobs:
 *     - capability pointer: deferred tools are absent from <tools>, so a
 *       bottom-of-prompt line tells the model the tool exists and how to load
 *       it (weak models only pattern-match — the line names concrete triggers);
 *     - keyword auto-load: measured weak models never spontaneously run the
 *       two-step "tool_search first, then use" flow, so when the user message
 *       matches the tool's intent regex the HOST loads it directly, skipping
 *       the whole tool_search detour.
 *
 * Multiple deferred tools each register their own handler; the rendered block
 * is MERGED (each handler rewrites the single `<deferred_tools>` section with
 * its own line added), so N tools produce ONE section regardless of handler
 * order. A tool already active in this session contributes no line (its schema
 * is visible in <tools> now). When `tool_search` itself is not active (e.g.
 * minimal mode narrowed the mcp feature away), no block is rendered at all —
 * that session intentionally has no load channel.
 */
export interface DeferredToolSpec {
  /** Registered tool name (also the tool_search query that loads it). */
  name: string;
  /**
   * User-message intent regex for the weak-model auto-load fallback. Keep it
   * CONSERVATIVE — a miss still leaves the pointer line + tool_search path;
   * a false positive silently grows the active tool set.
   */
  intent: RegExp;
  /** Line shown while the tool is NOT loaded (how to load it). */
  hintLine: string;
  /** Line shown on the turn the host auto-loads it (call it directly). */
  loadedLine: string;
}

const BLOCK_RE = /<deferred_tools>([\s\S]*?)<\/deferred_tools>/;

export function mountDeferredTool(pi: ExtensionAPI, spec: DeferredToolSpec): void {
  createToolSearchExtension()(pi);
  pi.on("before_agent_start", (event) => {
    const active = pi.getActiveTools();
    if (!active.includes("tool_search")) return;
    // 1.2 起 before_agent_start 是 user / custom 两种事件的联合：只有用户提问的回合带
    // `prompt`，自定义消息（pi.sendMessage triggerTurn）触发的回合没有可匹配文本。
    const prompt = event.messageType === "user" ? event.prompt : "";
    let line: string | null = null;
    if (!active.includes(spec.name)) {
      if (spec.intent.test(prompt)) {
        pi.setActiveTools([...active, spec.name]);
        line = spec.loadedLine;
      } else {
        line = spec.hintLine;
      }
    }
    const existing = BLOCK_RE.exec(event.systemPrompt);
    if (!line && !existing) return;
    // Rebuild the block: keep other tools' lines, drop this tool's stale line.
    const prev = existing
      ? existing[1]
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith(`\`${spec.name}\``))
      : [];
    const body = line ? [...prev, line].join("\n") : prev.join("\n");
    const stripped = event.systemPrompt.replace(BLOCK_RE, "").replace(/\n+$/, "");
    if (!body) return { systemPrompt: stripped };
    return {
      systemPrompt: `${stripped}\n\n<deferred_tools>\n${body}\n</deferred_tools>`,
    };
  });
}
