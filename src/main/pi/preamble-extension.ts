import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PREAMBLE_RE, readPreambleSync } from "./preamble";

/**
 * Replaces the SDK-hardcoded default preamble with the user's own.
 *
 * What it is: the identity sentence pi writes at the very start of the
 * assembled system prompt ("You are an expert coding assistant operating
 * inside pi, …"). The user configures their own text in Assistant Settings →
 * Preamble; it is stored at `~/.pi/agent/preamble.md`.
 *
 * Why a before_agent_start hook instead of a config: the SDK has no toggle
 * that swaps ONLY the preamble — `customPrompt` would also drop the tools and
 * rules sections (system-prompt.js builds them only when no customPrompt is
 * given). The hook gets the fully assembled prompt, so an anchored, exact
 * replacement of the default sentence touches nothing else. The file is
 * re-read on EVERY turn, so edits apply on the next message with no restart.
 *
 * Failure mode is deliberately boring: when the default sentence is not found
 * (SDK reworded it, or a customPrompt already replaced it) the handler returns
 * nothing — zero residue, prompt untouched. Replacement uses a function
 * callback so `$` sequences in user text are never treated as replacement
 * patterns.
 */
export const preambleExtension: InlineExtension = {
  name: "preamble",
  factory: (pi) => {
    pi.on("before_agent_start", (event) => {
      const preamble = readPreambleSync();
      if (!preamble) return;
      if (!DEFAULT_PREAMBLE_RE.test(event.systemPrompt)) return;
      return { systemPrompt: event.systemPrompt.replace(DEFAULT_PREAMBLE_RE, () => preamble) };
    });
  },
};
