/**
 * Episodic memory link — connect extracted memories back to the raw
 * conversation they came from.
 *
 * The authoritative memory store is Markdown; SQLite is a search mirror kept
 * in sync by sync-markdown-memories. To survive that reconcile, a memory's
 * origin session id rides inside the Markdown entry metadata
 * (`src64=<base64url(sessionId)>`) and is mirrored into the
 * `memories.source_session_id` column.
 *
 * This module reads that link back: given a memory id, return the session it
 * came from plus a bounded slice of the original messages, so a too-abstract
 * memory can be "rewound" to what was actually said.
 */

import type { DatabaseManager } from "./db";

export interface EpisodicMessage {
  role: string;
  content: string;
  timestamp: string;
}

export interface EpisodicResult {
  /** Source session id recorded when the memory was written, if any. */
  sessionId: string | null;
  /** Human-readable project/cwd of that session, when known. */
  sessionProject: string | null;
  sessionCwd: string | null;
  /** Original messages around the memory's origin (oldest first). */
  messages: EpisodicMessage[];
  /** True when a session id exists but its transcript was pruned/not indexed. */
  transcriptUnavailable: boolean;
}

/**
 * Look up the source session recorded for a memory, then return a bounded
 * slice of that session's original messages.
 *
 * @param aroundCount max messages to return (most recent N when no anchor).
 */
export function getEpisodicForMemory(
  dbManager: DatabaseManager,
  memoryId: number,
  aroundCount = 40,
): EpisodicResult {
  const db = dbManager.getDb();

  const row = db
    .prepare("SELECT source_session_id FROM memories WHERE id = ?")
    .get(memoryId) as { source_session_id: string | null } | undefined;

  const sessionId = row?.source_session_id?.trim() || null;
  if (!sessionId) {
    return {
      sessionId: null,
      sessionProject: null,
      sessionCwd: null,
      messages: [],
      transcriptUnavailable: false,
    };
  }

  const session = db
    .prepare("SELECT project, cwd FROM sessions WHERE id = ?")
    .get(sessionId) as { project: string | null; cwd: string | null } | undefined;

  const messages = db
    .prepare(
      `SELECT role, content, timestamp
         FROM messages
        WHERE session_id = ?
        ORDER BY rowid ASC
        LIMIT ?`,
    )
    .all(sessionId, Math.max(1, Math.trunc(aroundCount))) as Array<{
      role: string;
      content: string;
      timestamp: string;
    }>;

  return {
    sessionId,
    sessionProject: session?.project ?? null,
    sessionCwd: session?.cwd ?? null,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    })),
    transcriptUnavailable: messages.length === 0,
  };
}

/** How many memories carry an episodic link (for diagnostics / panel). */
export function countLinkedMemories(dbManager: DatabaseManager): number {
  const db = dbManager.getDb();
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM memories WHERE source_session_id IS NOT NULL")
    .get() as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}
