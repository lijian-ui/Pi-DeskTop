/**
 * 记忆遗忘（像人一样淡出）。
 *
 * 与「排序衰减」不同：排序只是把旧条目排后面，这一层是真正把它从
 * Markdown 与 SQLite 中移除。判定条件故意保守：
 *
 *   access_count <= 0（从未被检索/注入/编辑过）
 *   且 距最后引用（没有则用创建时间）>= 90 天
 *
 * 被搜到、被注入、被面板编辑都会让 access_count 增加，所以「用过的
 * 不会忘」。移除前先追加到 archive/YYYY-MM.md，随时可以翻回来。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseManager } from "../store/db";
import type { MemoryStore } from "../store/memory-store";
import { getMemories } from "../store/sqlite-memory-store";

export const FORGET_MIN_AGE_DAYS = 90;

export interface ForgetResult {
  archived: number;
  failed: number;
}

function daysSince(iso: string, now: number): number {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 0;
  return Math.floor((now - ts) / (24 * 60 * 60 * 1000));
}

export async function forgetStaleMemories(
  store: MemoryStore,
  dbManager: DatabaseManager | null,
  memoryDir: string,
  now: Date = new Date(),
): Promise<ForgetResult> {
  if (!dbManager) return { archived: 0, failed: 0 };

  let rows;
  try {
    rows = getMemories(dbManager);
  } catch {
    return { archived: 0, failed: 0 };
  }

  const nowMs = now.getTime();
  const stale = rows.filter((row) => {
    if (row.pinned) return false;
    if (row.accessCount > 0) return false;
    return daysSince(row.lastReferenced || row.created, nowMs) >= FORGET_MIN_AGE_DAYS;
  });
  if (!stale.length) return { archived: 0, failed: 0 };

  const archivedAt = now.toISOString().slice(0, 10);
  const month = archivedAt.slice(0, 7);
  const archiveDir = path.join(memoryDir, "archive");
  const archiveFile = path.join(archiveDir, `${month}.md`);

  const lines = stale.map(
    (row) =>
      `- [${row.target}] ${row.content} <!-- created=${row.created}, last=${row.lastReferenced}, archived=${archivedAt} -->`,
  );

  // 先归档再移除：归档写失败就整体放弃，避免出现「删了但没备份」。
  try {
    fs.mkdirSync(archiveDir, { recursive: true });
    const header = fs.existsSync(archiveFile) ? "" : `# Archived Memories ${month}\n\n`;
    fs.appendFileSync(archiveFile, `${header}${lines.join("\n")}\n`, "utf8");
  } catch {
    return { archived: 0, failed: stale.length };
  }

  let archived = 0;
  let failed = 0;
  for (const row of stale) {
    try {
      const result = await store.remove(row.target, row.content);
      if (result.success) archived++;
      else failed++;
    } catch {
      failed++;
    }
  }

  return { archived, failed };
}
