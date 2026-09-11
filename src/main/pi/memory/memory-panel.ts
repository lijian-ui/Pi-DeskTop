/**
 * Desktop memory-browsing panel service.
 *
 * Exposes the Hermes memory store to the renderer (MemoryPage) over IPC. The
 * renderer never touches SQLite directly — it calls these functions, which open
 * a dedicated WAL connection to the global memory directory and return plain
 * serializable DTOs (MemoryView). Edits re-run the same guard scan and token
 * recomputation the agent write path uses, so the panel and the agent stay
 * consistent.
 */

import { DatabaseManager } from "./store/db";
import {
  getMemories,
  searchMemories,
  removeMemory,
  setMemoryPinned,
  type SqliteMemoryEntry,
} from "./store/sqlite-memory-store";
import { tokenizeForStorage } from "./ranking";
import { getEpisodicForMemory, type EpisodicResult } from "./store/episodic";
import { flagConflictsForWrite } from "./store/conflict-flag";
import { scanMemoryContent } from "./guard";
import { loadConfig } from "./config";
import { resolveGlobalMemoryDir, AGENT_ROOT } from "./paths";
import {
  GUARD_RULES_FILENAME,
  ENTRY_DELIMITER,
  MEMORY_FILE,
  USER_FILE,
  DEFAULT_PROJECTS_MEMORY_DIR,
} from "./constants";
import { resolveAuthoritativeMemoryFile } from "./handlers/sync-markdown-memories";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MemoryCategory } from "./types";

export interface MemoryView {
  id: number;
  project: string | null;
  target: "memory" | "user" | "failure";
  category: MemoryCategory | null;
  content: string;
  failureReason: string | null;
  toolState: string | null;
  correctedTo: string | null;
  created: string;
  lastReferenced: string;
  /** Precomputed ranking tokens (see ranking/tokenizer). */
  searchTokens: string;
  /** How many times this memory has been surfaced/referenced. Drives decay. */
  accessCount: number;
  /** Whether this memory is pinned as a durable anchor. */
  pinned: boolean;
  /** Session this memory was distilled from (episodic link), when known. */
  sourceSessionId: string | null;
  /** Peer memory id this one lexically contradicts, when flagged. */
  conflictWith: number | null;
  /** "flagged" when a conflicting pair was detected, else null. */
  conflictStatus: string | null;
}

export const MEMORY_CATEGORIES: MemoryCategory[] = [
  "failure",
  "correction",
  "insight",
  "preference",
  "convention",
  "tool-quirk",
];

export interface UpdateMemoryResult {
  success: boolean;
  error?: string;
}

// One shared connection for the panel's lifetime (WAL allows the extension to
// hold its own in parallel). Cheaper than open/close on every interaction.
let panelDb: DatabaseManager | null = null;
function dbFor(globalDir: string): DatabaseManager {
  if (!panelDb) panelDb = new DatabaseManager(globalDir);
  return panelDb;
}

/** Global memory directory shared by the extension and the desktop panel. */
export function memoryGlobalDir(): string {
  return resolveGlobalMemoryDir(loadConfig());
}

function toView(e: SqliteMemoryEntry): MemoryView {
  return { ...e };
}

export function listMemories(globalDir: string): MemoryView[] {
  return getMemories(dbFor(globalDir), {}).map(toView);
}

export function searchMemoriesView(globalDir: string, query: string): MemoryView[] {
  const q = (query ?? "").trim();
  if (!q) return listMemories(globalDir);
  return searchMemories(dbFor(globalDir), q, { limit: 200 }).map(toView);
}

export function deleteMemory(globalDir: string, id: number): boolean {
  const dbManager = dbFor(globalDir);
  const db = dbManager.getDb();
  const row = db
    .prepare("SELECT id, content, target, project FROM memories WHERE id = ?")
    .get(id) as
    | { id: number; content: string; target: "memory" | "user" | "failure"; project: string | null }
    | undefined;
  if (!row) return false;

  // 同步删除 Markdown 权威源中的对应条目，避免下次对账时从 md 重新插回 SQLite（"删除复活"）。
  // 先动权威源、再删镜像：即使镜像删除失败，对账也会按"md 已无此条目"把孤儿 SQL 行清掉。
  removeMarkdownMemoryEntry(globalDir, row.target, row.project, row.content);

  return removeMemory(dbManager, id);
}

/**
 * 从 Markdown 权威源文件中删除与给定 SQLite 记忆行匹配的那一条。
 * - md 文件缺失：按"记忆不应因文件被删而消失"的设计直接跳过（此时 removeMemory 会清掉 SQL 行，且不会复活）。
 * - md 中找不到匹配条目：跳过写回（不误删）。
 * - 匹配到多条（超罕见）：全部移除，确保该记忆彻底消失、不会被对账复活。
 */
function removeMarkdownMemoryEntry(
  globalDir: string,
  target: "memory" | "user" | "failure",
  project: string | null,
  content: string,
): void {
  const filePath = resolveMarkdownFileForScope(globalDir, target, project);
  if (!filePath || !fs.existsSync(filePath)) return;

  const raw = fs.readFileSync(filePath, "utf-8");
  const entries = raw.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);
  if (entries.length === 0) return;

  const needle = content.trim();
  if (!needle) return;

  const visibleOf = (entry: string) => stripMarkdownEntryMetadata(entry);
  const exact = entries.filter((e) => visibleOf(e) === needle);
  const candidates = exact.length > 0 ? exact : entries.filter((e) => visibleOf(e).includes(needle));
  if (candidates.length === 0) return;

  const toRemove = new Set(candidates);
  const remaining = entries.filter((e) => !toRemove.has(e));
  if (remaining.length === entries.length) return;

  writeMemoryFileAtomic(filePath, remaining.join(ENTRY_DELIMITER));
}

function resolveMarkdownFileForScope(
  globalDir: string,
  target: "memory" | "user" | "failure",
  project: string | null,
): string | null {
  if (target === "user") return path.join(globalDir, USER_FILE);
  if (target === "failure") return path.join(globalDir, "failures.md");
  // target === "memory"
  if (!project) return path.join(globalDir, MEMORY_FILE);
  const projectsRoot = path.resolve(AGENT_ROOT, DEFAULT_PROJECTS_MEMORY_DIR);
  return resolveAuthoritativeMemoryFile(projectsRoot, project)
    ?? path.join(projectsRoot, project, MEMORY_FILE);
}

/** 去掉记忆条目尾部 `<!-- created=... -->` 元数据注释，取可见文本用于匹配。 */
function stripMarkdownEntryMetadata(entry: string): string {
  return entry.replace(/<!--[\s\S]*?-->/g, "").trim();
}

/** 同目录临时文件 + rename 的原子写，避免写到一半进程退出导致 md 损坏（与 MemoryStore 一致）。 */
function writeMemoryFileAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, filePath);
}

export function setPinned(globalDir: string, id: number, pinned: boolean): void {
  setMemoryPinned(dbFor(globalDir), id, pinned);
}

/**
 * Clear a lexical-conflict flag on a memory. Conflict detection only ADVISES —
 * both entries stay; the reviewer decides in the panel whether to keep, edit,
 * or delete one of the pair.
 */
export function resolveConflict(globalDir: string, id: number): void {
  dbFor(globalDir)
    .getDb()
    .prepare("UPDATE memories SET conflict_status = NULL WHERE id = ?")
    .run(id);
}

/**
 * Return the raw conversation slice a memory was distilled from (episodic
 * link). Empty when the memory predates episodic linking or its transcript was
 * pruned.
 */
export function getMemoryEpisodic(
  globalDir: string,
  id: number,
  aroundCount = 40,
): EpisodicResult {
  return getEpisodicForMemory(dbFor(globalDir), id, aroundCount);
}

/**
 * Edit a memory's content and/or category. Mirrors the agent write path:
 * recomputes ranking tokens and runs the content guard before committing.
 */
export function updateMemory(
  globalDir: string,
  id: number,
  input: { content?: string; category?: string | null },
): UpdateMemoryResult {
  const db = dbFor(globalDir).getDb();
  const row = db
    .prepare("SELECT id, content, category FROM memories WHERE id = ?")
    .get(id) as
    | { id: number; content: string; category: string | null }
    | undefined;
  if (!row) return { success: false, error: "记忆不存在" };

  const content = input.content !== undefined ? input.content.trim() : row.content;
  const contentChanged = content !== row.content;
  let category: MemoryCategory | null =
    input.category !== undefined
      ? (input.category as MemoryCategory | null)
      : (row.category as MemoryCategory | null);

  if (input.category !== undefined) {
    category = MEMORY_CATEGORIES.includes(input.category as MemoryCategory)
      ? (input.category as MemoryCategory | null)
      : null;
  }

  // Same guard the agent write path applies (memory-tool.ts).
  const cfg = loadConfig();
  const guardCfg = cfg.guard ?? { enabled: true, severity: "block" as const };
  const rulesPath =
    cfg.guard?.rulesPath ?? path.join(memoryGlobalDir(), GUARD_RULES_FILENAME);
  const scan = scanMemoryContent(content, guardCfg, rulesPath);
  if (!scan.allowed) {
    const hit = scan.violations[0];
    return {
      success: false,
      error: `内容被守卫拦截（${hit?.category ?? "guard"}）：${hit?.snippet ?? ""}`,
    };
  }

  const tokens = tokenizeForStorage(content, dbFor(globalDir).getDirectory());
  const today = new Date().toISOString().split("T")[0];
  db.prepare(
    "UPDATE memories SET content = ?, category = ?, search_tokens = ?, last_referenced = ? WHERE id = ?",
  ).run(content, category, tokens, today, id);

  // An edit can introduce a contradiction with a neighbouring entry, so run the
  // same lexical check the write paths use. Advisory: the edit already applied,
  // and a stale flag from the previous content is cleared first so the panel
  // never shows a conflict that the edit just resolved.
  if (contentChanged) {
    db.prepare("UPDATE memories SET conflict_status = NULL, conflict_with = NULL WHERE id = ?").run(id);
    const row2 = db.prepare("SELECT project, target FROM memories WHERE id = ?").get(id) as
      | { project: string | null; target: "memory" | "user" | "failure" }
      | undefined;
    if (row2) {
      const peers = db
        .prepare(
          `SELECT content FROM memories
            WHERE id <> ? AND target = ?
              AND ((project IS NULL AND ? IS NULL) OR project = ?)`,
        )
        .all(id, row2.target, row2.project, row2.project) as Array<{ content: string }>;
      flagConflictsForWrite({
        dbManager: dbFor(globalDir),
        existingTexts: peers.map((p) => p.content),
        content,
        target: row2.target,
        project: row2.project,
      });
    }
  }

  return { success: true };
}
