/**
 * Shared content-block extraction utilities.
 *
 * The Pi SDK represents message content as either a plain string or an array
 * of { type, text/thinking/data/… } blocks. These helpers normalise both
 * shapes into simple strings for the renderer. Previously duplicated across
 * session-store, useAgentSession, and session-export; extracted here so the
 * logic is defined once and stays consistent across every code path.
 */

/** A single Pi SDK content block (subset of the full union). */
interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  data?: string;
}

/**
 * Extract the visible text from a message's content.
 * - String content → returned as-is.
 * - Array of content blocks → text blocks joined with newlines.
 */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: ContentBlock) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("\n");
  }
  return "";
}

/**
 * Extract thinking content from a message's content array.
 * Only arrays carry thinking blocks; string content never contains thinking.
 */
export function extractThinking(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .filter((b: ContentBlock) => b && b.type === "thinking" && typeof b.thinking === "string")
      .map((b) => b.thinking!)
      .join("\n");
  }
  return "";
}
