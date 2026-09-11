/**
 * 7-day rotating snapshot of the Hermes memory SQLite database.
 *
 * The memory store is a living, self-rewriting system (search increments
 * access_count, promotion flips pinned, decay weights shift every query). A
 * snapshot is the safety net: if a migration goes wrong or decay unfairly
 * buries a memory, you can fall back to last week's sessions.db.
 *
 * Safety: WAL mode is enabled (db.ts:373), so opening a second connection and
 * running `VACUUM INTO` produces a consistent point-in-time copy of the live
 * database without blocking the extension's own connection.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseManager } from "./store/db";

export const SNAPSHOT_INTERVAL_DAYS = 7;
export const SNAPSHOT_KEEP = 4;
const SNAPSHOT_DIR = "snapshots";

export interface SnapshotInfo {
  name: string;
  path: string;
  /** mtime in ms — used as the snapshot's creation timestamp. */
  createdAt: number;
  size: number;
}

function snapshotDir(globalDir: string): string {
  return path.join(globalDir, SNAPSHOT_DIR);
}

function dateStamp(d = new Date()): string {
  // YYYY-MM-DD (local), filesystem-safe and chronologically sortable.
  return d.toISOString().split("T")[0];
}

/** VACUUM INTO requires a single-quoted, non-existent target; escape quotes. */
function quoteSqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function statSnapshot(fullPath: string): SnapshotInfo | null {
  try {
    const st = fs.statSync(fullPath);
    return {
      name: path.basename(fullPath),
      path: fullPath,
      createdAt: st.mtimeMs,
      size: st.size,
    };
  } catch {
    return null;
  }
}

export function listSnapshots(globalDir: string): SnapshotInfo[] {
  const dir = snapshotDir(globalDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const infos: SnapshotInfo[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".db")) continue;
    const info = statSnapshot(path.join(dir, e.name));
    if (info) infos.push(info);
  }
  infos.sort((a, b) => b.createdAt - a.createdAt);
  return infos;
}

/**
 * Take a snapshot now. Uses VACUUM INTO on a throwaway connection so the copy
 * is a clean, standalone sessions.db regardless of the live WAL state. Removes
 * any same-day file first (VACUUM INTO refuses to overwrite).
 */
export function takeSnapshot(globalDir: string, when = new Date()): SnapshotInfo {
  const dir = snapshotDir(globalDir);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${dateStamp(when)}.db`);
  fs.rmSync(dest, { force: true });

  const mgr = new DatabaseManager(globalDir);
  try {
    const db = mgr.getDb();
    db.exec(`VACUUM INTO ${quoteSqlString(dest)}`);
  } finally {
    mgr.close();
  }

  const info = statSnapshot(dest);
  if (!info) throw new Error("Snapshot file was not created");
  return info;
}

export interface RotateResult {
  skipped: boolean;
  snapshot?: SnapshotInfo;
  pruned: string[];
  reason?: string;
}

/**
 * Rotate snapshots. Skips when the newest snapshot is younger than `intervalDays`
 * (so calling this on every agent start yields a ~7-day cadence). Otherwise
 * takes a fresh snapshot and prunes oldest copies down to `keep`.
 */
export function maybeRotateSnapshot(
  globalDir: string,
  opts: { intervalDays?: number; keep?: number } = {}
): RotateResult {
  const intervalDays = opts.intervalDays ?? SNAPSHOT_INTERVAL_DAYS;
  const keep = opts.keep ?? SNAPSHOT_KEEP;
  const existing = listSnapshots(globalDir);
  const newest = existing[0];

  if (newest && Date.now() - newest.createdAt < intervalDays * 24 * 3600 * 1000) {
    return { skipped: true, pruned: [], reason: "within interval" };
  }

  const snapshot = takeSnapshot(globalDir);

  const remaining = listSnapshots(globalDir);
  const pruned: string[] = [];
  for (let i = keep; i < remaining.length; i++) {
    try {
      fs.rmSync(remaining[i].path, { force: true });
      pruned.push(remaining[i].name);
    } catch {
      // best effort
    }
  }
  return { skipped: false, snapshot, pruned };
}
