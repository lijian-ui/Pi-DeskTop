import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { readSoulSync } from "./soul";

/**
 * Soul / persona inline extension.
 *
 * Injects the user's soul text at the ABSOLUTE BOTTOM of the system prompt —
 * after Pi's base prompt, <project_context> (AGENTS.md/CLAUDE.md), skills and
 * the trailing "Current working directory: ..." line.
 *
 * Why an extension instead of resourceLoaderOptions.appendSystemPromptOverride:
 * - The resource-loader pipeline hardcodes the assembly order in
 *   buildSystemPrompt() (system-prompt.js) and appendSystemPrompt sections are
 *   always placed BEFORE project context / cwd. There is no bottom hook there.
 * - The `before_agent_start` event hands us the fully assembled prompt
 *   (event.systemPrompt) right before each agent loop, so appending here lands
 *   the soul at the true end of the prompt.
 *
 * Hot-reload semantics (stronger than the previous override approach):
 * - The handler runs on EVERY turn and re-reads soul.md synchronously, so an
 *   edit takes effect on the very next message — no session.reload() and no
 *   services rebuild required. The existing watcher/invalidation for soul.md
 *   stays harmless (services rebuilds simply re-register this extension).
 * - Returning nothing when the soul is empty falls back to the untouched base
 *   prompt (SDK zero-residue behavior), which covers the cleared-soul case.
 */
export const soulExtension: InlineExtension = {
  name: "soul",
  factory: (pi) => {
    pi.on("before_agent_start", (event) => {
      const soul = readSoulSync().trim();
      if (!soul) return; // no soul → keep original prompt untouched
      // Wrap the soul in a <personality> section so it is visually and
      // semantically separated from the preceding prompt content, matching
      // Pi's own XML-tag sectioning style (e.g. <project_context>).
      return {
        systemPrompt: `${event.systemPrompt}\n\n<personality>\n${soul}\n</personality>`,
      };
    });
  },
};
