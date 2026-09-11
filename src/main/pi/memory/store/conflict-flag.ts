/**
 * Shared conflict-flagging for memory writes.
 *
 * Conflict detection originally lived only inside `review-memory-ops.ts`, which
 * meant it fired on the background-review `add` path and nowhere else. Three
 * other write paths silently skipped it:
 *   - `review-memory-ops` `replace` branch
 *   - `tools/memory-tool.ts` (the model calling memory_add directly)
 *   - the desktop panel's edit action (`memory-panel.updateMemory`)
 *
 * Factoring it here lets every writer flag a pair the same way. Detection stays
 * lexical and advisory: both entries are kept, both sides get each other's id,
 * and the panel surfaces the pair for a human to resolve.
 */

import type { DatabaseManager } from "../store/db";
import { detectConflicts } from "../store/conflict";

export interface FlagConflictsInput {
  dbManager: DatabaseManager | null;
  /** Existing memory texts of the same target, metadata already stripped. */
  existingTexts: string[];
  /** The content just written. */
  content: string;
  target: "memory" | "user" | "failure";
  /** Project scope of the write; null means the user-level (global) store. */
  project: string | null;
}

/** Number of conflicts flagged by one call (0 or 1; a pair is flagged at most once). */
export function flagConflictsForWrite(input: FlagConflictsInput): number {
  const { dbManager, existingTexts, content, target, project } = input;
  if (!dbManager || existingTexts.length === 0 || !content.trim()) return 0;

  try {
    const hits = detectConflicts(content, existingTexts);
    if (hits.length === 0) return 0;

    const db = dbManager.getDb();
    const newRow = db
      .prepare(
        `SELECT id FROM memories
          WHERE content = ? AND target = ? AND ((project IS NULL AND ? IS NULL) OR project = ?)
          ORDER BY id DESC LIMIT 1`,
      )
      .get(content, target, project, project) as { id: number } | undefined;

    if (!newRow) return 0;

    for (const hit of hits) {
      const oldRow = db
        .prepare(
          `SELECT id FROM memories
            WHERE content = ? AND target = ? AND id <> ?
              AND ((project IS NULL AND ? IS NULL) OR project = ?)
            ORDER BY id DESC LIMIT 1`,
        )
        .get(hit.existingText, target, newRow.id, project, project) as
        | { id: number }
        | undefined;
      if (!oldRow) continue;
      // Point each side at the other so both render "⚠ 冲突 #N".
      db.prepare("UPDATE memories SET conflict_with = ?, conflict_status = 'flagged' WHERE id = ?")
        .run(oldRow.id, newRow.id);
      db.prepare("UPDATE memories SET conflict_with = ?, conflict_status = 'flagged' WHERE id = ?")
        .run(newRow.id, oldRow.id);
      return 1;
    }

    // Matched a peer we could not resolve (e.g. outside this scope): still mark
    // the new entry so it is surfaced rather than silently lost.
    db.prepare("UPDATE memories SET conflict_status = 'flagged' WHERE id = ?").run(newRow.id);
    return 1;
  } catch {
    // Conflict flagging is advisory — never break a successful write.
    return 0;
  }
}
