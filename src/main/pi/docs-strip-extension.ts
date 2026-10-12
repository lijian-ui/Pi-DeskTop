import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * Strips the SDK-hardcoded `<docs>` section from the assembled system prompt.
 *
 * What it is: pi's own README / docs / examples absolute paths plus 13
 * "question X → read docs/x.md" mappings (system-prompt.js L86-93), ~500
 * tokens on EVERY turn. It only matters when the user asks about pi itself
 * (writing extensions / themes / TUI / SDK integration) — never for ordinary
 * pi-desktop chat, IM, or scheduled-task sessions.
 *
 * Why a before_agent_start strip instead of a config: the section has no
 * toggle — the only SDK-side escape is `customPrompt`, which would also drop
 * preamble/tools/rules. The event hands us the fully assembled prompt (same
 * hook soul/rules append through), so a deterministic regex removal lands the
 * strip without touching any other section. When `<docs>` is absent (e.g. a
 * custom prompt already replaced it) the handler returns nothing — zero
 * residue, prompt untouched.
 */
const DOCS_SECTION_RE = /\n*<docs>[\s\S]*?<\/docs>/;

export const docsStripExtension: InlineExtension = {
  name: "docs-strip",
  factory: (pi) => {
    pi.on("before_agent_start", (event) => {
      if (!event.systemPrompt.includes("<docs>")) return;
      return { systemPrompt: event.systemPrompt.replace(DOCS_SECTION_RE, "") };
    });
  },
};
