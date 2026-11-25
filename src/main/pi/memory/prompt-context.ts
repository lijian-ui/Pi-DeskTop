import { MEMORY_POLICY_PROMPT } from "./constants";
import type { MemoryConfig } from "./types";
import type { MemoryStore } from "./store/memory-store";

/** What buildPromptContext produced: the prompt slice plus the entries it injected. */
export interface PromptContextResult {
  text: string;
  /** Failure / correction entries actually rendered, used for access counting. */
  injectedTexts: string[];
}

/**
 * Assemble the memory slice of the system prompt.
 *
 * Stored memory bodies NEVER enter the system prompt — the model has to
 * retrieve them with memory_search. The only exception is the
 * corrections/preferences block: a correction like "use pnpm, not npm" is
 * worthless if the model has to think of searching for it first. The block is
 * small and bounded, so it cannot crowd out context the way a full MEMORY.md
 * dump would.
 *
 * Note: there is no standing-instructions channel. The desktop app injects
 * user-authored always-active 规则 via rulesExtension (pi/rules-extension.ts),
 * which covers every session including scheduled tasks. A second channel with
 * the same semantics and trigger would only duplicate that text, so the
 * upstream StandingInstructions store was removed entirely.
 */
export async function buildPromptContext(
  config: MemoryConfig,
  store: MemoryStore,
): Promise<PromptContextResult> {
  const parts: string[] = [MEMORY_POLICY_PROMPT];

  // Corrections/preferences are read from the single global store.
  const correctionEntries = store.getCorrectionInjectionEntries();
  const correctionBlock = store.formatCorrectionBlock();
  if (correctionBlock) parts.push(correctionBlock);

  return {
    text: parts.join("\n\n"),
    injectedTexts: correctionEntries,
  };
}
