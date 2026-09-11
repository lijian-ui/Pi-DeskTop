/**
 * Anchor store — thin access layer over the SQLite memory table for the compact
 * bridge. All raw SQL lives in store/sqlite-memory-store.ts; this module only
 * applies anchor config policy (thresholds, counts, scope).
 */

import { DatabaseManager } from '../store/db';
import {
  getPinnedMemories,
  getHighValueMemories,
  promoteHighValueMemories,
  type SqliteMemoryEntry,
} from '../store/sqlite-memory-store';
import type { AnchorConfig } from './types';

/** Promote high-value memories to pinned anchors (called before compaction). */
export function promoteAnchors(
  dbManager: DatabaseManager,
  config: AnchorConfig,
  projectName?: string | null,
): number {
  if (!config.enabled) return 0;
  return promoteHighValueMemories(dbManager, config.minAccessCount, projectName ?? undefined);
}

/**
 * Collect the anchor set for injection: pinned memories first, then top
 * high-value (unpinned) memories up to maxAnchors.
 */
export function collectAnchorMemories(
  dbManager: DatabaseManager,
  config: AnchorConfig,
  projectName?: string | null,
): SqliteMemoryEntry[] {
  if (!config.enabled) return [];
  const pinned = getPinnedMemories(dbManager, projectName ?? undefined, config.maxAnchors);
  if (pinned.length >= config.maxAnchors) return pinned.slice(0, config.maxAnchors);

  const need = config.maxAnchors - pinned.length;
  const pinnedIds = new Set(pinned.map((m) => m.id));
  const extra = getHighValueMemories(dbManager, config.minAccessCount, projectName ?? undefined, need + 10)
    .filter((m) => !pinnedIds.has(m.id))
    .slice(0, need);

  return [...pinned, ...extra];
}
