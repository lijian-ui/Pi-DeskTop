/**
 * Anchor (compact bridge) configuration.
 *
 * Anchors are durable memories that survive context compaction. Before
 * compaction we promote frequently-referenced memories to "pinned"; at
 * agent-start we inject the pinned set back into the system prompt so key facts
 * are never lost when the context window is reset.
 */

export interface AnchorConfig {
  /** Master switch for the compact-bridge behavior. Default: true */
  enabled: boolean;
  /** access_count at or above which a memory is promoted to an anchor. Default: 3 */
  minAccessCount: number;
  /** Maximum number of anchor lines injected into the system prompt. Default: 5 */
  maxAnchors: number;
}
