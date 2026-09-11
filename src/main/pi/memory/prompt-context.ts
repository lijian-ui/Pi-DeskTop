import { MEMORY_POLICY_PROMPT, MEMORY_POLICY_PROMPT_COMPACT } from "./constants";
import type { MemoryConfig } from "./types";
import type { MemoryStore } from "./store/memory-store";

type MemoryPolicyConfig = Pick<MemoryConfig, "memoryPolicyStyle" | "memoryPolicyCustomText">;

export function resolveMemoryPolicyPrompt(config: MemoryPolicyConfig): string {
  const style = config.memoryPolicyStyle ?? "full";

  switch (style) {
    case "compact":
      return MEMORY_POLICY_PROMPT_COMPACT;
    case "custom":
      return config.memoryPolicyCustomText && config.memoryPolicyCustomText.trim().length > 0
        ? config.memoryPolicyCustomText
        : MEMORY_POLICY_PROMPT_COMPACT;
    case "none":
      return "";
    case "full":
    default:
      return MEMORY_POLICY_PROMPT;
  }
}

/**
 * Assemble the memory slice of the system prompt.
 *
 * Two modes:
 * - `policy-only` (default): inject the policy prompt (how/when to use the
 *   memory tools) plus recent FAILURE LESSONS, and no stored memory content.
 *   Failures are the deliberate exception to "don't load memory into the
 *   prompt": a lesson like "this approach broke last time" is worthless if the
 *   model has to think of searching for it first, because by then it has
 *   already repeated the mistake. The block is small and bounded (default: 5
 *   entries / 7 days), so it cannot crowd out context the way MEMORY.md would.
 * - `legacy-inject`: the full frozen memory dump, which already contains the
 *   failure block (see MemoryStore.formatForSystemPrompt) — so it is not
 *   appended a second time here.
 *
 * Note: there is no standing-instructions channel. The desktop app injects
 * user-authored always-active 规则 via rulesExtension (pi/rules-extension.ts),
 * which covers every session including scheduled tasks. A second channel with
 * the same semantics and trigger would only duplicate that text, so the
 * upstream StandingInstructions store was removed entirely.
 */
export async function buildPromptContext(
  config: Pick<MemoryConfig, "memoryMode" | "memoryPolicyStyle" | "memoryPolicyCustomText">,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  projectName: string,
): Promise<string> {
  if (config.memoryMode === "policy-only") {
    const parts: string[] = [];
    const policy = resolveMemoryPolicyPrompt(config);
    if (policy) parts.push(policy);

    // Unconditional failure lessons. Prefer the project store (narrower, more
    // specific); fall back to the global store when the project has none, so a
    // fresh project still inherits cross-project lessons.
    const projectFailures = projectStore?.formatFailureBlock() ?? "";
    const failureBlock = projectFailures || store.formatFailureBlock();
    if (failureBlock) parts.push(failureBlock);

    return parts.join("\n\n");
  }

  const memoryBlock = store.formatForSystemPrompt();
  const projectBlock = projectStore ? projectStore.formatProjectBlock(projectName) : "";

  const parts: string[] = [];
  if (memoryBlock) parts.push(memoryBlock);
  if (projectBlock) parts.push(projectBlock);

  return parts.join("\n\n");
}
