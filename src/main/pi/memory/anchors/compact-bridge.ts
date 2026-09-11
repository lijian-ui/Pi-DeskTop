/**
 * Compact bridge — keeps durable memories from being silently dropped when the
 * agent compacts its context window.
 *
 * Two touch points:
 *  - promoteAnchorsBeforeCompact(): called from the session_before_compact hook;
 *    pins memories whose access_count is high so the facts they encode stay
 *    durable.
 *  - buildAnchorContextBlock(): called from before_agent_start; renders the
 *    pinned anchor set as a system-prompt block so key facts are always present,
 *    even right after a compaction that would otherwise evict them.
 */

import { DatabaseManager } from '../store/db';
import type { AnchorConfig } from './types';
import { promoteAnchors, collectAnchorMemories } from './anchor-store';

/**
 * Pin high-value memories before compaction. Best-effort — a failure must never
 * block compaction.
 */
export function promoteAnchorsBeforeCompact(
  dbManager: DatabaseManager,
  config: AnchorConfig,
  projectName?: string | null,
): void {
  if (!config.enabled) return;
  try {
    const promoted = promoteAnchors(dbManager, config, projectName);
    if (promoted > 0) {
      console.info(`🧠 Pinned ${promoted} high-value memorie(s) as compaction anchors`);
    }
  } catch (err) {
    console.warn(`⚠️ Anchor promotion failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Render the anchor block for injection into the system prompt. Returns '' when
 * no anchors exist (so callers can skip concatenation).
 */
export function buildAnchorContextBlock(
  dbManager: DatabaseManager,
  config: AnchorConfig,
  projectName?: string | null,
): string {
  const memories = collectAnchorMemories(dbManager, config, projectName);
  if (memories.length === 0) return '';

  const lines: string[] = [
    '<memory-anchors>',
    'Durable, pinned memories. They survive context compaction and are always available; treat them as confirmed facts:',
  ];
  for (const memory of memories) {
    const text = memory.content.replace(/\s+/g, ' ').trim();
    if (text) lines.push(`- ${text}`);
  }
  lines.push('</memory-anchors>');
  return lines.join('\n');
}
