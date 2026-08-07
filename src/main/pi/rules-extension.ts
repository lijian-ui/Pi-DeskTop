import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { readRulesSync } from "./rules";

/**
 * Rules inline extension.
 *
 * Injects the user's rules at the ABSOLUTE BOTTOM of the system prompt — after
 * the soul's <personality> and any scheduled-task block — as a
 * `<rules>…</rules>` section. Registered AFTER soulExtension so the
 * before_agent_start chain appends rules last (handlers are chained in
 * registration order, each receiving the previous result's systemPrompt).
 *
 * Hot-reload: re-reads rules.md synchronously on EVERY turn, so a saved edit
 * applies on the very next message — no session.reload() / services rebuild.
 * Returning nothing when the file is empty keeps the prompt untouched.
 */
export const rulesExtension: InlineExtension = {
  name: "rules",
  factory: (pi) => {
    pi.on("before_agent_start", (event) => {
      const rules = readRulesSync().trim();
      if (!rules) return;
      return {
        systemPrompt: `${event.systemPrompt}\n\n<rules>\n${rules}\n</rules>`,
      };
    });
  },
};
