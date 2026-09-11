import { DatabaseManager } from './db';
import {
  buildFallbackFts5Query,
  buildNaturalLanguageFallbackQuery,
  collectLikeTerms,
  isFts5QueryError,
  normalizeFts5Query,
  normalizeNaturalLanguageFts5Query,
} from './fts-query';
import { normalizeMemoryLookupText } from './memory-lookup';
import { tokenizeForStorage } from '../ranking/tokenizer';
import { rankCandidates } from '../ranking/ranker';
import { tokenizeQuery } from '../ranking/signals';
import { type RankableMemory, type RankCandidate, type RankedMemory, type RankingConfig } from '../ranking/types';
import type { MemoryCategory } from '../types';

export { isFts5QueryError };

const MEMORY_SELECT_COLUMNS = `
  id,
  project,
  target,
  category,
  content,
  failure_reason,
  tool_state,
  corrected_to,
  created,
  last_referenced,
  search_tokens,
  access_count,
  pinned,
  source_session_id,
  conflict_with,
  conflict_status
`;

// The BM25-ranked search joins memory_fts, which also has a `content` column,
// so that one query needs the same list qualified with the `memories` alias.
const MEMORY_SELECT_COLUMNS_M = MEMORY_SELECT_COLUMNS
  .split(',')
  .map((column) => `m.${column.trim()}`)
  .join(',\n        ');

const FAILURE_CATEGORY_SET = new Set<MemoryCategory>([
  'failure',
  'correction',
  'insight',
  'preference',
  'convention',
  'tool-quirk',
]);

/**
 * A memory entry stored in SQLite.
 */
export interface SqliteMemoryEntry {
  id: number;
  project: string | null;
  target: 'memory' | 'user' | 'failure';
  category: MemoryCategory | null;
  content: string;
  failureReason: string | null;
  toolState: string | null;
  correctedTo: string | null;
  created: string;
  lastReferenced: string;
  /** Precomputed ranking tokens (see ranking/tokenizer). */
  searchTokens: string;
  /** How many times this memory has been surfaced/referenced. Drives decay reinforcement. */
  accessCount: number;
  /** Whether this memory is pinned as a durable anchor. */
  pinned: boolean;
  /** Origin session id for episodic link-back (nullable). */
  sourceSessionId: string | null;
  /** Id of a contradictory entry this one was flagged against (nullable). */
  conflictWith: number | null;
  /** Conflict review status: 'flagged' | null. */
  conflictStatus: string | null;
}

export interface SqliteMemorySyncInput {
  content: string;
  target: 'memory' | 'user' | 'failure';
  project?: string | null;
  category?: MemoryCategory | null;
  failureReason?: string | null;
  toolState?: string | null;
  correctedTo?: string | null;
  created?: string | null;
  lastReferenced?: string | null;
  /** Origin session id parsed from the Markdown `src64` metadata. */
  sourceSessionId?: string | null;
  /**
   * Reinforcement to seed a NEW row with (ignored when the row already exists).
   * Lets the caller hand a freshly written memory a starting access count so it
   * is not permanently stuck at zero. See RankingConfig.initialAccessCount.
   */
  initialAccessCount?: number;
}

export interface SqliteMemorySyncResult {
  action: 'inserted' | 'existing';
  entry: SqliteMemoryEntry;
}

export interface SqliteMemoryUpdateResult {
  matched: number;
  updated: number;
  entries: SqliteMemoryEntry[];
}

export interface SqliteMemoryRemoveResult {
  matched: number;
  removed: number;
}

export interface SqliteMemoryRemoveOptions {
  target: 'memory' | 'user' | 'failure';
  project?: string | null;
}

export interface MarkdownMemoryReconcileResult {
  inserted: number;
  existing: number;
  removed: number;
  /**
   * True when the scope was left un-reconciled because of a genuine FTS5
   * search-index error. Markdown remains the source of truth and the write
   * did not fail; search may be stale until /memory-sync-markdown rebuilds
   * the index. Callers should surface that repair guidance to the user.
   */
  degraded?: boolean;
  /** Human-readable reason for the degraded state, when degraded is true. */
  degradedReason?: string;
}

export interface ParsedMarkdownMemoryEntry extends SqliteMemorySyncInput {}

function today(): string {
  return new Date().toISOString().split('T')[0];
}

function normalizeNullable(value?: string | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCategory(value?: MemoryCategory | null): MemoryCategory | null {
  return value ?? null;
}

function mapRow(row: {
  id: number;
  project: string | null;
  target: string;
  category: string | null;
  content: string;
  failure_reason: string | null;
  tool_state: string | null;
  corrected_to: string | null;
  created: string;
  last_referenced: string;
  search_tokens?: string | null;
  access_count?: number;
  pinned?: number;
  source_session_id?: string | null;
  conflict_with?: number | null;
  conflict_status?: string | null;
}): SqliteMemoryEntry {
  return {
    id: row.id,
    project: row.project,
    target: row.target as 'memory' | 'user' | 'failure',
    category: row.category as MemoryCategory | null,
    content: row.content,
    failureReason: row.failure_reason,
    toolState: row.tool_state,
    correctedTo: row.corrected_to,
    created: row.created,
    lastReferenced: row.last_referenced,
    searchTokens: row.search_tokens ?? '',
    accessCount: Number(row.access_count ?? 0),
    pinned: Number(row.pinned ?? 0) !== 0,
    sourceSessionId: row.source_session_id ?? null,
    conflictWith: row.conflict_with ?? null,
    conflictStatus: row.conflict_status ?? null,
  };
}

/** Project a stored entry into the shape the ranking layer consumes. */
export function toRankableMemory(entry: SqliteMemoryEntry): RankableMemory {
  return {
    id: entry.id,
    content: entry.content,
    project: entry.project,
    target: entry.target,
    category: entry.category,
    created: entry.created,
    lastReferenced: entry.lastReferenced,
    accessCount: entry.accessCount,
    pinned: entry.pinned,
    searchTokens: entry.searchTokens,
  };
}

function buildScopeConditions(params: unknown[], target?: string, project?: string | null, category?: MemoryCategory | null): string[] {
  const conditions: string[] = [];

  if (target) {
    conditions.push('target = ?');
    params.push(target);
  }

  if (project !== undefined) {
    if (project === null) {
      conditions.push('project IS NULL');
    } else {
      conditions.push('project = ?');
      params.push(project);
    }
  }

  if (category !== undefined) {
    if (category === null) {
      conditions.push('category IS NULL');
    } else {
      conditions.push('category = ?');
      params.push(category);
    }
  }

  return conditions;
}

/** Maps memory_search target filters onto SQLite columns (search paths only). */
function buildSearchTargetConditions(params: unknown[], target: string | undefined, tablePrefix: string): string[] {
  const conditions: string[] = [];

  if (target === 'project') {
    conditions.push(`${tablePrefix}.target = 'memory'`);
    conditions.push(`${tablePrefix}.project IS NOT NULL`);
  } else if (target) {
    conditions.push(`${tablePrefix}.target = ?`);
    params.push(target);
  }

  return conditions;
}

function getMemoryById(dbManager: DatabaseManager, id: number): SqliteMemoryEntry | null {
  const db = dbManager.getDb();
  const row = db.prepare(`
    SELECT ${MEMORY_SELECT_COLUMNS}
    FROM memories
    WHERE id = ?
  `).get(id) as {
    id: number;
    project: string | null;
    target: string;
    category: string | null;
    content: string;
    failure_reason: string | null;
    tool_state: string | null;
    corrected_to: string | null;
    created: string;
    last_referenced: string;
  } | undefined;

  return row ? mapRow(row) : null;
}

function minDate(a: string, b: string): string {
  return a <= b ? a : b;
}

function maxDate(a: string, b: string): string {
  return a >= b ? a : b;
}

function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&');
}

function isShortCjkLiteralQuery(query: string): boolean {
  const trimmed = query.trim();
  return [...trimmed].length <= 2
    && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(trimmed);
}

function parseMetadataComment(raw: string): { text: string; created: string; lastReferenced: string; project: string | null; sourceSessionId: string | null } {
  const match = raw.match(/^(.*?)\s*<!--\s*created=([^,]+),\s*last=([^,>]+)(?:,\s*project64=([A-Za-z0-9_-]+))?(?:,\s*src64=([A-Za-z0-9_-]+))?\s*-->\s*$/);
  if (match) {
    let project: string | null = null;
    if (match[4]) {
      try { project = Buffer.from(match[4], 'base64url').toString('utf-8').trim() || null; } catch {}
    }
    let sourceSessionId: string | null = null;
    if (match[5]) {
      try { sourceSessionId = Buffer.from(match[5], 'base64url').toString('utf-8').trim() || null; } catch {}
    }
    return {
      text: match[1].trim(),
      created: match[2].trim(),
      lastReferenced: match[3].trim(),
      project,
      sourceSessionId,
    };
  }

  const fallback = today();
  return {
    text: raw.trim(),
    created: fallback,
    lastReferenced: fallback,
    project: null,
    sourceSessionId: null,
  };
}

/**
 * Add a memory entry to the SQLite store.
 */
export function addMemory(
  dbManager: DatabaseManager,
  content: string,
  target: 'memory' | 'user' | 'failure' = 'memory',
  project: string | null = null,
  category: MemoryCategory | null = null,
  failureReason: string | null = null,
  toolState: string | null = null,
  correctedTo: string | null = null,
  created = today(),
  lastReferenced = created,
  sourceSessionId: string | null = null,
  initialAccessCount = 0,
): SqliteMemoryEntry {
  const db = dbManager.getDb();
  const searchTokens = tokenizeForStorage(content, dbManager.getDirectory());
  const seedAccess = Math.max(0, Math.trunc(initialAccessCount));

  const result = db.prepare(`
    INSERT INTO memories (project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced, search_tokens, access_count, pinned, source_session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(project, target, category, content, failureReason, toolState, correctedTo, created, lastReferenced, searchTokens, seedAccess, sourceSessionId);

  return {
    id: Number(result.lastInsertRowid),
    project,
    target,
    category,
    content,
    failureReason,
    toolState,
    correctedTo,
    created,
    lastReferenced,
    searchTokens,
    accessCount: seedAccess,
    pinned: false,
    sourceSessionId,
    conflictWith: null,
    conflictStatus: null,
  };
}

/**
 * Build the visible failure-memory text stored in Markdown.
 */
export function formatFailureMemoryContent(
  content: string,
  options: {
    category: MemoryCategory;
    failureReason?: string | null;
    toolState?: string | null;
    correctedTo?: string | null;
    project?: string | null;
  }
): string {
  const categoryTag = `[${options.category}]`;
  const parts = [`${categoryTag} ${content.trim()}`.trim()];
  if (options.failureReason) parts.push(`Failed: ${options.failureReason}`);
  if (options.toolState) parts.push(`Tool state: ${options.toolState}`);
  if (options.correctedTo) parts.push(`Corrected to: ${options.correctedTo}`);
  return parts.join(' — ');
}

/**
 * Parse a Markdown memory entry into SQLite sync fields.
 * Best-effort only: if failure metadata cannot be fully reconstructed,
 * content is still imported and available for search.
 */
export function parseMarkdownMemoryEntry(
  rawEntry: string,
  target: 'memory' | 'user' | 'failure',
  project: string | null = null,
): ParsedMarkdownMemoryEntry {
  const metadata = parseMetadataComment(rawEntry);
  const { text, created, lastReferenced, sourceSessionId } = metadata;
  const parsedProject = normalizeNullable(project);

  if (target !== 'failure') {
    return {
      content: text,
      target,
      project: parsedProject,
      created,
      lastReferenced,
      sourceSessionId,
    };
  }

  let category: MemoryCategory | null = null;
  let failureReason: string | null = null;
  let toolState: string | null = null;
  let correctedTo: string | null = null;

  const categoryMatch = text.match(/^\[([^\]]+)\]\s+/);
  if (categoryMatch && FAILURE_CATEGORY_SET.has(categoryMatch[1] as MemoryCategory)) {
    category = categoryMatch[1] as MemoryCategory;
  }

  const segments = text.split(' — ');
  for (const segment of segments.slice(1)) {
    if (segment.startsWith('Failed: ') && !failureReason) {
      failureReason = segment.slice('Failed: '.length).trim() || null;
      continue;
    }
    if (segment.startsWith('Tool state: ') && !toolState) {
      toolState = segment.slice('Tool state: '.length).trim() || null;
      continue;
    }
    if (segment.startsWith('Corrected to: ') && !correctedTo) {
      correctedTo = segment.slice('Corrected to: '.length).trim() || null;
    }
  }

  return {
    content: text,
    target: 'failure',
    project: parsedProject,
    category,
    failureReason,
    toolState,
    correctedTo,
    created,
    lastReferenced,
    sourceSessionId,
  };
}

/**
 * Idempotently sync a Markdown-backed memory entry into SQLite.
 * Duplicate identity is exact: project + target + category + content.
 */
export function syncMemoryEntry(
  dbManager: DatabaseManager,
  input: SqliteMemorySyncInput,
): SqliteMemorySyncResult {
  const db = dbManager.getDb();
  const content = input.content.trim();
  const project = normalizeNullable(input.project);
  const category = normalizeCategory(input.category);
  const failureReason = normalizeNullable(input.failureReason);
  const toolState = normalizeNullable(input.toolState);
  const correctedTo = normalizeNullable(input.correctedTo);
  const created = input.created?.trim() || today();
  const lastReferenced = input.lastReferenced?.trim() || created;

  const params: unknown[] = [];
  const conditions = buildScopeConditions(params, input.target, project, category);
  conditions.push('content = ?');
  params.push(content);

  const existing = db.prepare(`
    SELECT ${MEMORY_SELECT_COLUMNS}
    FROM memories
    WHERE ${conditions.join(' AND ')}
    ORDER BY id ASC
    LIMIT 1
  `).get(...params) as {
    id: number;
    project: string | null;
    target: string;
    category: string | null;
    content: string;
    failure_reason: string | null;
    tool_state: string | null;
    corrected_to: string | null;
    created: string;
    last_referenced: string;
    source_session_id: string | null;
  } | undefined;

  if (!existing) {
    return {
      action: 'inserted',
      entry: addMemory(
        dbManager,
        content,
        input.target,
        project,
        category,
        failureReason,
        toolState,
        correctedTo,
        created,
        lastReferenced,
        normalizeNullable(input.sourceSessionId),
        input.initialAccessCount ?? 0,
      ),
    };
  }

  const updatedCreated = minDate(existing.created, created);
  const updatedLastReferenced = maxDate(existing.last_referenced, lastReferenced);
  const updatedCategory = (existing.category as MemoryCategory | null) ?? category;
  const updatedFailureReason = existing.failure_reason ?? failureReason;
  const updatedToolState = existing.tool_state ?? toolState;
  const updatedCorrectedTo = existing.corrected_to ?? correctedTo;
  const incomingSource = normalizeNullable(input.sourceSessionId);
  const updatedSource = existing.source_session_id ?? incomingSource;

  db.prepare(`
    UPDATE memories
    SET category = ?, failure_reason = ?, tool_state = ?, corrected_to = ?, created = ?, last_referenced = ?, source_session_id = ?
    WHERE id = ?
  `).run(
    updatedCategory,
    updatedFailureReason,
    updatedToolState,
    updatedCorrectedTo,
    updatedCreated,
    updatedLastReferenced,
    updatedSource,
    existing.id,
  );

  return {
    action: 'existing',
    entry: getMemoryById(dbManager, existing.id)!,
  };
}

/**
 * Make one exact Markdown target/project scope authoritative in SQLite.
 * Upserts and orphan deletion are committed together when transactions are
 * supported by the active SQLite driver.
 */
export function reconcileMarkdownMemoryScope(
  dbManager: DatabaseManager,
  rawEntries: string[],
  target: 'memory' | 'user' | 'failure',
  project: string | null = null,
): MarkdownMemoryReconcileResult {
  const normalizedProject = normalizeNullable(project);

  // The full reconcile runs against the CURRENT database handle. It must fetch
  // it via dbManager.getDb() rather than a pre-fetched handle: after corruption
  // recovery quarantines the old file and rebuilds a fresh one, the retry has
  // to run on the new handle.
  const reconcile = (): MarkdownMemoryReconcileResult => {
    const db = dbManager.getDb();
    let inserted = 0;
    let existing = 0;
    let removed = 0;
    const desiredIdentities = new Set<string>();

    for (const rawEntry of rawEntries) {
      const parsed = parseMarkdownMemoryEntry(rawEntry, target, normalizedProject);
      desiredIdentities.add(JSON.stringify([
        normalizeCategory(parsed.category),
        parsed.content.trim(),
      ]));
      const result = syncMemoryEntry(dbManager, parsed);
      if (result.action === 'inserted') inserted++;
      else existing++;
    }

    const params: unknown[] = [];
    const conditions = buildScopeConditions(params, target, normalizedProject);
    const scopedRows = db.prepare(`
      SELECT id, content, category
      FROM memories
      WHERE ${conditions.join(' AND ')}
      ORDER BY id ASC
    `).all(...params) as Array<{ id: number; content: string; category: MemoryCategory | null }>;
    const retainedIdentities = new Set<string>();
    const orphanIds: number[] = [];
    for (const row of scopedRows) {
      const identity = JSON.stringify([normalizeCategory(row.category), row.content.trim()]);
      if (!desiredIdentities.has(identity) || retainedIdentities.has(identity)) {
        orphanIds.push(row.id);
      } else {
        retainedIdentities.add(identity);
      }
    }

    if (orphanIds.length > 0) {
      const placeholders = orphanIds.map(() => '?').join(', ');
      removed = db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...orphanIds).changes;
    }

    return { inserted, existing, removed };
  };

  const run = (): MarkdownMemoryReconcileResult => {
    const db = dbManager.getDb();
    const transactional = db.transaction?.(reconcile);
    return transactional ? transactional() : reconcile();
  };

  try {
    // Corruption errors (e.g. "database disk image is malformed") are NOT
    // search-index problems: they must stay on the recovery path so
    // DatabaseManager quarantines the corrupt file, rebuilds a fresh one, and
    // retries this sync (#186). Swallowing them would hide corruption and
    // leave a corrupt database in place.
    return dbManager.withCorruptionRecovery(run);
  } catch (err) {
    if (isFts5QueryError(err)) {
      // A genuine FTS5 query/index error means the search index is stale or
      // broken, not that the database is corrupt. Markdown is the source of
      // truth, so the write must not fail: warn in the log and report a
      // DEGRADED result so the caller can surface the /memory-sync-markdown
      // repair guidance to the user.
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[pi-hermes-memory] FTS5 search index error during markdown sync (search may be stale; run /memory-sync-markdown): ${detail}`);
      return { inserted: 0, existing: 0, removed: 0, degraded: true, degradedReason: detail };
    }
    throw err;
  }
}

function failureProject(rawEntry: string): string | null {
  return parseMetadataComment(rawEntry).project;
}

export function reconcileMarkdownFailureScopes(
  dbManager: DatabaseManager,
  rawEntries: string[],
): MarkdownMemoryReconcileResult {
  const entriesByProject = new Map<string | null, string[]>();
  for (const rawEntry of rawEntries) {
    const project = failureProject(rawEntry);
    const entries = entriesByProject.get(project) ?? [];
    entries.push(rawEntry);
    entriesByProject.set(project, entries);
  }

  const mirroredProjects = dbManager.getDb().prepare(`
    SELECT DISTINCT project
    FROM memories
    WHERE target = 'failure'
  `).all() as Array<{ project: string | null }>;
  const projects = new Set<string | null>([
    null,
    ...entriesByProject.keys(),
    ...mirroredProjects.map(({ project }) => normalizeNullable(project)),
  ]);
  const total: MarkdownMemoryReconcileResult = { inserted: 0, existing: 0, removed: 0 };

  for (const project of projects) {
    const result = reconcileMarkdownMemoryScope(
      dbManager,
      entriesByProject.get(project) ?? [],
      'failure',
      project,
    );
    total.inserted += result.inserted;
    total.existing += result.existing;
    total.removed += result.removed;
    if (result.degraded && !total.degraded) {
      // Surface the first degraded scope: repair guidance applies to the whole
      // sync run, and the first reason is the one to act on.
      total.degraded = true;
      total.degradedReason = result.degradedReason;
    }
  }

  return total;
}

/**
 * Best-effort substring replacement for SQLite-backed memory sync.
 * Updates all matches in the scoped slice to recover from prior duplicate rows.
 */
export function replaceSyncedMemories(
  dbManager: DatabaseManager,
  oldText: string,
  updates: {
    content: string;
    target: 'memory' | 'user' | 'failure';
    project?: string | null;
    category?: MemoryCategory | null;
    failureReason?: string | null;
    toolState?: string | null;
    correctedTo?: string | null;
    lastReferenced?: string | null;
  },
): SqliteMemoryUpdateResult {
  const db = dbManager.getDb();
  const normalizedOldText = normalizeMemoryLookupText(oldText);
  if (!normalizedOldText) return { matched: 0, updated: 0, entries: [] };
  const params: unknown[] = [];
  const conditions = buildScopeConditions(params, updates.target, updates.project ?? undefined);
  conditions.push(`content LIKE ? ESCAPE '\\'`);
  params.push(`%${escapeLikePattern(normalizedOldText)}%`);

  const rows = db.prepare(`
    SELECT ${MEMORY_SELECT_COLUMNS}
    FROM memories
    WHERE ${conditions.join(' AND ')}
    ORDER BY id ASC
  `).all(...params) as Array<{
    id: number;
    project: string | null;
    target: string;
    category: string | null;
    content: string;
    failure_reason: string | null;
    tool_state: string | null;
    corrected_to: string | null;
    created: string;
    last_referenced: string;
  }>;

  if (rows.length === 0) {
    return { matched: 0, updated: 0, entries: [] };
  }

  const nextLastReferenced = updates.lastReferenced?.trim() || today();

  for (const row of rows) {
    db.prepare(`
      UPDATE memories
      SET content = ?,
          category = ?,
          failure_reason = ?,
          tool_state = ?,
          corrected_to = ?,
          last_referenced = ?,
          search_tokens = ?
      WHERE id = ?
    `).run(
      updates.content.trim(),
      updates.category === undefined ? row.category : updates.category,
      updates.failureReason === undefined ? row.failure_reason : normalizeNullable(updates.failureReason),
      updates.toolState === undefined ? row.tool_state : normalizeNullable(updates.toolState),
      updates.correctedTo === undefined ? row.corrected_to : normalizeNullable(updates.correctedTo),
      nextLastReferenced,
      tokenizeForStorage(updates.content.trim(), dbManager.getDirectory()),
      row.id,
    );
  }

  return {
    matched: rows.length,
    updated: rows.length,
    entries: rows
      .map((row) => getMemoryById(dbManager, row.id))
      .filter((entry): entry is SqliteMemoryEntry => entry !== null),
  };
}

/**
 * Best-effort substring removal for SQLite-backed memory sync.
 * Deletes all matches in the scoped slice to recover from prior duplicate rows.
 */
export function removeSyncedMemories(
  dbManager: DatabaseManager,
  oldText: string,
  options: SqliteMemoryRemoveOptions,
): SqliteMemoryRemoveResult {
  const db = dbManager.getDb();
  const normalizedOldText = normalizeMemoryLookupText(oldText);
  if (!normalizedOldText) return { matched: 0, removed: 0 };
  const params: unknown[] = [];
  const conditions = buildScopeConditions(params, options.target, options.project ?? undefined);
  conditions.push(`content LIKE ? ESCAPE '\\'`);
  params.push(`%${escapeLikePattern(normalizedOldText)}%`);

  const matchingIds = db.prepare(`
    SELECT id
    FROM memories
    WHERE ${conditions.join(' AND ')}
  `).all(...params) as Array<{ id: number }>;

  if (matchingIds.length === 0) {
    return { matched: 0, removed: 0 };
  }

  const deleteParams = matchingIds.map((row) => row.id);
  const placeholders = deleteParams.map(() => '?').join(', ');
  const result = db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...deleteParams);

  return {
    matched: matchingIds.length,
    removed: result.changes,
  };
}

/**
 * Exact removal for Markdown entries whose full content is known.
 * Used for FIFO eviction cleanup, where substring matching could remove
 * unrelated SQLite mirror rows that merely contain the evicted text.
 */
export function removeExactSyncedMemories(
  dbManager: DatabaseManager,
  content: string,
  options: SqliteMemoryRemoveOptions,
): SqliteMemoryRemoveResult {
  const db = dbManager.getDb();
  const params: unknown[] = [];
  const conditions = buildScopeConditions(params, options.target, options.project ?? undefined);
  conditions.push('content = ?');
  params.push(content.trim());

  const matchingIds = db.prepare(`
    SELECT id
    FROM memories
    WHERE ${conditions.join(' AND ')}
  `).all(...params) as Array<{ id: number }>;

  if (matchingIds.length === 0) {
    return { matched: 0, removed: 0 };
  }

  const deleteParams = matchingIds.map((row) => row.id);
  const placeholders = deleteParams.map(() => '?').join(', ');
  const result = db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...deleteParams);

  return {
    matched: matchingIds.length,
    removed: result.changes,
  };
}

/**
 * Search memories using FTS5.
 */
export function searchMemories(
  dbManager: DatabaseManager,
  query: string,
  options: { project?: string; target?: string; category?: MemoryCategory; limit?: number } = {}
): SqliteMemoryEntry[] {
  if (query.trim().length === 0) {
    return [];
  }

  const db = dbManager.getDb();
  const { project, target, category, limit = 10 } = options;

  const conditions: string[] = [];
  const params: unknown[] = [];

  // FTS5 match via JOIN with BM25 ranking
  const normalizedQuery = normalizeFts5Query(query);

  let ftsParseError = false;

  const runSearch = (matchQuery: string): SqliteMemoryEntry[] => {
    const conditions: string[] = [];
    const params: unknown[] = [];

    conditions.push('memory_fts MATCH ?');
    params.push(matchQuery);

    if (project !== undefined) {
      if (project === null) {
        conditions.push('m.project IS NULL');
      } else {
        conditions.push('m.project = ?');
        params.push(project);
      }
    }

    conditions.push(...buildSearchTargetConditions(params, target, 'm'));

    if (category) {
      conditions.push('m.category = ?');
      params.push(category);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
      SELECT
        ${MEMORY_SELECT_COLUMNS_M},
        bm25(memory_fts) AS rank_score
      FROM memories m
      JOIN memory_fts ON memory_fts.rowid = m.id
      ${whereClause}
      ORDER BY rank_score ASC, m.last_referenced DESC
      LIMIT ?
    `;

    try {
      const rows = db.prepare(sql).all(...params, limit) as Array<{
        id: number;
        project: string | null;
        target: string;
        category: string | null;
        content: string;
        failure_reason: string | null;
        tool_state: string | null;
        corrected_to: string | null;
        created: string;
        last_referenced: string;
        rank_score: number;
      }>;

      return rows.map(mapRow);
    } catch (err) {
      if (isFts5QueryError(err)) {
        ftsParseError = true;
        return [];
      }
      throw err;
    }
  };

  // FTS5's trigram tokenizer cannot match one- and two-character CJK terms.
  // Use a scoped literal fallback only for those terms so FTS operators and
  // normal tokenized searches retain their existing semantics.
  const runShortCjkFallback = (): SqliteMemoryEntry[] => {
    const conditions: string[] = ["m.content LIKE ? ESCAPE '\\'"];
    const params: unknown[] = [`%${escapeLikePattern(query.trim())}%`];

    if (project !== undefined) {
      if (project === null) {
        conditions.push('m.project IS NULL');
      } else {
        conditions.push('m.project = ?');
        params.push(project);
      }
    }
    conditions.push(...buildSearchTargetConditions(params, target, 'm'));

    if (category) {
      conditions.push('m.category = ?');
      params.push(category);
    }

    const rows = db.prepare(`
      SELECT ${MEMORY_SELECT_COLUMNS}
      FROM memories m
      WHERE ${conditions.join(' AND ')}
      ORDER BY m.last_referenced DESC
      LIMIT ?
    `).all(...params, limit) as Array<{
      id: number;
      project: string | null;
      target: string;
      category: string | null;
      content: string;
      failure_reason: string | null;
      tool_state: string | null;
      corrected_to: string | null;
      created: string;
      last_referenced: string;
    }>;
    return rows.map(mapRow);
  };

  // Every term a stop word or connector leaves FTS5 nothing to match.
  // Degrade to a scoped literal substring search (OR over the raw terms) —
  // the same fallback session search uses for this case — instead of a hard
  // [].
  const runLiteralLikeFallback = (): SqliteMemoryEntry[] => {
    const terms = collectLikeTerms(query);
    if (terms.length === 0) return [];

    const conditions: string[] = [
      `(${terms.map(() => "m.content LIKE ? ESCAPE '\\'").join(' OR ')})`,
    ];
    const params: unknown[] = terms.map((term) => `%${escapeLikePattern(term.trim())}%`);

    if (project !== undefined) {
      if (project === null) {
        conditions.push('m.project IS NULL');
      } else {
        conditions.push('m.project = ?');
        params.push(project);
      }
    }
    if (target) {
      conditions.push('m.target = ?');
      params.push(target);
    }
    if (category) {
      conditions.push('m.category = ?');
      params.push(category);
    }

    const rows = db.prepare(`
      SELECT ${MEMORY_SELECT_COLUMNS}
      FROM memories m
      WHERE ${conditions.join(' AND ')}
      ORDER BY m.last_referenced DESC
      LIMIT ?
    `).all(...params, limit) as Array<{
      id: number;
      project: string | null;
      target: string;
      category: string | null;
      content: string;
      failure_reason: string | null;
      tool_state: string | null;
      corrected_to: string | null;
      created: string;
      last_referenced: string;
    }>;
    return rows.map(mapRow);
  };

  if (normalizedQuery.length === 0) {
    return runLiteralLikeFallback();
  }

  const exactResults = runSearch(normalizedQuery);
  if (exactResults.length > 0) {
    return exactResults;
  }

  if (isShortCjkLiteralQuery(query)) {
    return runShortCjkFallback();
  }

  // A query with uppercase operator words (e.g. "DO NOT USE FIND /") passes
  // through as raw FTS5 syntax; when that fails to parse, retry it as natural
  // language instead of silently returning nothing. Valid operator queries
  // that legitimately match nothing keep their exact semantics.
  if (ftsParseError) {
    const nlQuery = normalizeNaturalLanguageFts5Query(query);
    if (nlQuery.length === 0 || nlQuery === normalizedQuery) {
      return [];
    }
    const nlResults = runSearch(nlQuery);
    if (nlResults.length > 0) {
      return nlResults;
    }
    const nlFallback = buildNaturalLanguageFallbackQuery(query);
    if (nlFallback && nlFallback !== nlQuery) {
      return runSearch(nlFallback);
    }
    return nlResults;
  }

  const fallbackQuery = buildFallbackFts5Query(query);
  if (!fallbackQuery || fallbackQuery === normalizedQuery) {
    return exactResults;
  }

  return runSearch(fallbackQuery);
}

/**
 * Get all memories, optionally filtered.
 */
export function getMemories(
  dbManager: DatabaseManager,
  options: { project?: string | null; target?: string; category?: MemoryCategory } = {}
): SqliteMemoryEntry[] {
  const db = dbManager.getDb();
  const { project, target, category } = options;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (project !== undefined) {
    if (project === null) {
      conditions.push('project IS NULL');
    } else {
      conditions.push('project = ?');
      params.push(project);
    }
  }

  if (target) {
    conditions.push('target = ?');
    params.push(target);
  }

  if (category) {
    conditions.push('category = ?');
    params.push(category);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT ${MEMORY_SELECT_COLUMNS}
    FROM memories
    ${whereClause}
    ORDER BY last_referenced DESC
  `).all(...params) as Array<{
    id: number;
    project: string | null;
    target: string;
    category: string | null;
    content: string;
    failure_reason: string | null;
    tool_state: string | null;
    corrected_to: string | null;
    created: string;
    last_referenced: string;
  }>;

  return rows.map(mapRow);
}

/**
 * Remove a memory by ID.
 */
export function removeMemory(dbManager: DatabaseManager, id: number): boolean {
  const db = dbManager.getDb();
  const result = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Get recent failure memories (last N days).
 */
export function getRecentFailures(
  dbManager: DatabaseManager,
  maxAgeDays = 7,
  project?: string | null
): SqliteMemoryEntry[] {
  const db = dbManager.getDb();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxAgeDays);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const conditions: string[] = ['target = ?', 'created >= ?'];
  const params: unknown[] = ['failure', cutoffStr];

  if (project !== undefined) {
    if (project === null) {
      conditions.push('project IS NULL');
    } else {
      conditions.push('(project = ? OR project IS NULL)');
      params.push(project);
    }
  }

  const rows = db.prepare(`
    SELECT ${MEMORY_SELECT_COLUMNS}
    FROM memories
    WHERE ${conditions.join(' AND ')}
    ORDER BY created DESC
    LIMIT 5
  `).all(...params) as Array<{
    id: number;
    project: string | null;
    target: string;
    category: string | null;
    content: string;
    failure_reason: string | null;
    tool_state: string | null;
    corrected_to: string | null;
    created: string;
    last_referenced: string;
  }>;

  return rows.map(mapRow);
}

/**
 * Update a memory's last_referenced date.
 */
export function touchMemory(dbManager: DatabaseManager, id: number): void {
  const db = dbManager.getDb();
  db.prepare('UPDATE memories SET last_referenced = ? WHERE id = ?').run(today(), id);
}

/**
 * Get memory statistics.
 */
export function getMemoryStats(dbManager: DatabaseManager): {
  total: number;
  byProject: { project: string | null; count: number }[];
  byTarget: { target: string; count: number }[];
} {
  const db = dbManager.getDb();

  const total = (db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }).count;

  const byProject = db.prepare(`
    SELECT project, COUNT(*) as count
    FROM memories
    GROUP BY project
    ORDER BY count DESC
  `).all() as { project: string | null; count: number }[];

  const byTarget = db.prepare(`
    SELECT target, COUNT(*) as count
    FROM memories
    GROUP BY target
    ORDER BY count DESC
  `).all() as { target: string; count: number }[];

  return { total, byProject, byTarget };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ranking-aware search + access/pin helpers (used by the ranking + anchors
// subsystems). Kept in the store layer so all SQLite access stays in one place.
// ─────────────────────────────────────────────────────────────────────────────

type RankedSearchOptions = {
  project?: string;
  target?: string;
  category?: MemoryCategory;
  limit?: number;
  ranking?: RankingConfig | null;
  memoryDir?: string | null;
};

const RANKED_SELECT_COLUMNS = `${MEMORY_SELECT_COLUMNS_M},\n        bm25(memory_fts) AS rank_score`;

interface RankedFtsRow {
  id: number;
  project: string | null;
  target: string;
  category: string | null;
  content: string;
  failure_reason: string | null;
  tool_state: string | null;
  corrected_to: string | null;
  created: string;
  last_referenced: string;
  search_tokens?: string | null;
  access_count?: number;
  pinned?: number;
  rank_score: number;
}

function buildRankedScope(params: unknown[], project: string | undefined, target: string | undefined, category: MemoryCategory | undefined): string[] {
  const conditions: string[] = [];
  if (project !== undefined) {
    if (project === null) conditions.push('m.project IS NULL');
    else { conditions.push('m.project = ?'); params.push(project); }
  }
  conditions.push(...buildSearchTargetConditions(params, target, 'm'));
  if (category) { conditions.push('m.category = ?'); params.push(category); }
  return conditions;
}

function runRankedFts(db: ReturnType<DatabaseManager['getDb']>, matchQuery: string, options: RankedSearchOptions): RankCandidate[] {
  const params: unknown[] = [matchQuery];
  const conditions = ['memory_fts MATCH ?'];
  conditions.push(...buildRankedScope(params, options.project, options.target, options.category));
  const where = `WHERE ${conditions.join(' AND ')}`;

  const sql = `
    SELECT ${RANKED_SELECT_COLUMNS}
    FROM memories m
    JOIN memory_fts ON memory_fts.rowid = m.id
    ${where}
    ORDER BY rank_score ASC, m.last_referenced DESC
    LIMIT ?
  `;

  try {
    const rows = db.prepare(sql).all(...params, options.limit ?? 10) as RankedFtsRow[];
    return rows.map((row, idx) => ({
      memory: toRankableMemory(mapRow(row)),
      ftsOrder: idx + 1,
      ftsScore: row.rank_score,
    }));
  } catch (err) {
    if (isFts5QueryError(err)) return [];
    throw err;
  }
}

function runRankedLike(db: ReturnType<DatabaseManager['getDb']>, likePattern: string, options: RankedSearchOptions): RankCandidate[] {
  const params: unknown[] = [`%${escapeLikePattern(likePattern)}%`];
  const conditions = ['m.content LIKE ? ESCAPE \'\\\''];

  if (options.project !== undefined) {
    if (options.project === null) conditions.push('m.project IS NULL');
    else { conditions.push('m.project = ?'); params.push(options.project); }
  }
  conditions.push(...buildSearchTargetConditions(params, options.target, 'm'));
  if (options.category) { conditions.push('m.category = ?'); params.push(options.category); }

  const sql = `
    SELECT ${MEMORY_SELECT_COLUMNS}
    FROM memories m
    WHERE ${conditions.join(' AND ')}
    ORDER BY m.last_referenced DESC
    LIMIT ?
  `;

  const rows = db.prepare(sql).all(...params, options.limit ?? 10) as Array<{
    id: number; project: string | null; target: string; category: string | null; content: string;
    failure_reason: string | null; tool_state: string | null; corrected_to: string | null;
    created: string; last_referenced: string; search_tokens?: string | null; access_count?: number; pinned?: number;
  }>;
  // No FTS position available for literal fallback — these rank worst on the fts
  // signal but still benefit from decay/recency/affinity.
  return rows.map((row) => ({ memory: toRankableMemory(mapRow(row)), ftsOrder: null, ftsScore: null }));
}

/**
 * Search memories with multi-signal reranking.
 *
 * Runs the same FTS5 → literal fallback chain as searchMemories, but each
 * candidate is annotated with its FTS5 position, then re-ordered by the ranking
 * layer (fts + term-overlap + decay + recency + affinity, fused with weighted
 * RRF). When ranking is disabled or there is only one candidate, returns the
 * candidates in FTS5 order unchanged.
 */
export function searchMemoriesRanked(
  dbManager: DatabaseManager,
  query: string,
  options: RankedSearchOptions = {},
): RankedMemory[] {
  if (query.trim().length === 0) return [];

  const db = dbManager.getDb();
  const { project, target, category, limit = 10, ranking = null, memoryDir = null } = options;
  const normalizedQuery = normalizeFts5Query(query);

  let candidates: RankCandidate[] = [];
  if (normalizedQuery.length > 0) {
    candidates = runRankedFts(db, normalizedQuery, { project, target, category, limit });
  }
  if (candidates.length === 0 && isShortCjkLiteralQuery(query)) {
    candidates = runRankedLike(db, query.trim(), { project, target, category, limit });
  }
  if (candidates.length === 0) {
    const fallback = buildFallbackFts5Query(query);
    if (fallback && fallback !== normalizedQuery) {
      candidates = runRankedFts(db, fallback, { project, target, category, limit });
    }
    if (candidates.length === 0) {
      candidates = runRankedLike(db, query.trim(), { project, target, category, limit });
    }
  }

  if (candidates.length === 0) return [];

  const noRanking = !ranking || !ranking.enabled || candidates.length === 1;
  if (noRanking) {
    return candidates
      .sort((a, b) => (a.ftsOrder ?? Number.MAX_SAFE_INTEGER) - (b.ftsOrder ?? Number.MAX_SAFE_INTEGER))
      .map((c) => ({ memory: c.memory, score: 0, ranks: {} }));
  }

  const queryTokens = tokenizeQuery(query, memoryDir);
  return rankCandidates(candidates, {
    queryTokens,
    scope: { project: project ?? null },
    config: ranking,
    now: new Date(),
  });
}

/**
 * Bump access_count for memories that were surfaced by a search, so frequently
 * referenced memories decay more slowly. Best-effort: never throws.
 */
export function incrementAccessCounts(dbManager: DatabaseManager, ids: number[]): void {
  if (ids.length === 0) return;
  const db = dbManager.getDb();
  const placeholders = ids.map(() => '?').join(', ');
  try {
    db.prepare(`UPDATE memories SET access_count = access_count + 1 WHERE id IN (${placeholders})`).run(...ids);
  } catch {
    // Ranking telemetry only — a failure must not break the search result.
  }
}

export function setMemoryPinned(dbManager: DatabaseManager, id: number, pinned: boolean): void {
  const db = dbManager.getDb();
  db.prepare('UPDATE memories SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id);
}

/** Pinned memories, most-referenced first. Used by the anchor block injector. */
export function getPinnedMemories(
  dbManager: DatabaseManager,
  project?: string | null,
  limit = 5,
): SqliteMemoryEntry[] {
  const db = dbManager.getDb();
  const params: unknown[] = [];
  const conditions: string[] = ['pinned = 1'];
  if (project !== undefined) {
    if (project === null) conditions.push('project IS NULL');
    else { conditions.push('project = ?'); params.push(project); }
  }
  const rows = db.prepare(`
    SELECT ${MEMORY_SELECT_COLUMNS}
    FROM memories
    WHERE ${conditions.join(' AND ')}
    ORDER BY access_count DESC, last_referenced DESC
    LIMIT ?
  `).all(...params, limit) as Array<{
    id: number; project: string | null; target: string; category: string | null; content: string;
    failure_reason: string | null; tool_state: string | null; corrected_to: string | null;
    created: string; last_referenced: string; search_tokens?: string | null; access_count?: number; pinned?: number;
  }>;
  return rows.map(mapRow);
}

/** Memories at or above an access threshold, used to backfill anchors. */
export function getHighValueMemories(
  dbManager: DatabaseManager,
  minAccessCount: number,
  project?: string | null,
  limit = 5,
): SqliteMemoryEntry[] {
  const db = dbManager.getDb();
  const params: unknown[] = [minAccessCount];
  const conditions: string[] = ['access_count >= ?'];
  if (project !== undefined) {
    if (project === null) conditions.push('project IS NULL');
    else { conditions.push('project = ?'); params.push(project); }
  }
  const rows = db.prepare(`
    SELECT ${MEMORY_SELECT_COLUMNS}
    FROM memories
    WHERE ${conditions.join(' AND ')}
    ORDER BY access_count DESC, last_referenced DESC
    LIMIT ?
  `).all(...params, limit) as Array<{
    id: number; project: string | null; target: string; category: string | null; content: string;
    failure_reason: string | null; tool_state: string | null; corrected_to: string | null;
    created: string; last_referenced: string; search_tokens?: string | null; access_count?: number; pinned?: number;
  }>;
  return rows.map(mapRow);
}

/**
 * Promote high-value memories to pinned anchors. Called before compaction so
 * durable facts survive the context window reset (compact bridge).
 */
export function promoteHighValueMemories(
  dbManager: DatabaseManager,
  minAccessCount: number,
  project?: string | null,
): number {
  const db = dbManager.getDb();
  const params: unknown[] = [minAccessCount];
  const conditions: string[] = ['access_count >= ?', 'pinned = 0'];
  if (project !== undefined) {
    if (project === null) conditions.push('project IS NULL');
    else { conditions.push('project = ?'); params.push(project); }
  }
  const result = db.prepare(`UPDATE memories SET pinned = 1 WHERE ${conditions.join(' AND ')}`).run(...params);
  return result.changes;
}
