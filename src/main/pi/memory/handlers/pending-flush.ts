/**
 * Pending flush snapshots — written on session shutdown, drained on the next
 * session start.
 *
 * The SDK aborts the current session BEFORE emitting `session_shutdown`
 * (agent-session-runtime.teardownCurrent), so no agent turn can run at that
 * point. Writing a snapshot is a millisecond-level filesystem operation; the
 * actual extraction is deferred to the next start, where a model is available.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_ROOT } from "../paths";

export interface PendingFlushSnapshot {
  sessionId: string;
  createdAt: number;
  attempts: number;
  parts: string[];
  /** 关闭前刚做过一次压缩沉淀：补做时提示模型只补遗漏，避免重复提取。 */
  recentFlush?: boolean;
}

export interface PendingFlushFile {
  file: string;
  snapshot: PendingFlushSnapshot;
}

function pendingDir(): string {
  return path.join(AGENT_ROOT, "memory", "pending-flush");
}

function fileFor(sessionId: string): string {
  const key = createHash("sha1").update(sessionId).digest("hex").slice(0, 16);
  return path.join(pendingDir(), `${key}.json`);
}

/** Write (or overwrite) the snapshot for a session. Never throws. */
export function writePendingFlush(sessionId: string, parts: string[], recentFlush = false): void {
  if (!sessionId || parts.length === 0) return;
  try {
    fs.mkdirSync(pendingDir(), { recursive: true });
    const snapshot: PendingFlushSnapshot = {
      sessionId,
      createdAt: Date.now(),
      attempts: 0,
      parts,
      ...(recentFlush ? { recentFlush: true } : {}),
    };
    const target = fileFor(sessionId);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot), "utf8");
    fs.renameSync(tmp, target);
  } catch {
    // Best-effort: shutdown must never fail because of the snapshot.
  }
}

/** List readable snapshots, oldest first. Corrupt files are removed. */
export function listPendingFlushes(): PendingFlushFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(pendingDir());
  } catch {
    return [];
  }

  const out: PendingFlushFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(pendingDir(), name);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as PendingFlushSnapshot;
      if (!parsed || !Array.isArray(parsed.parts) || parsed.parts.length === 0) {
        fs.unlinkSync(file);
        continue;
      }
      out.push({ file, snapshot: { ...parsed, attempts: parsed.attempts ?? 0 } });
    } catch {
      try {
        fs.unlinkSync(file);
      } catch {
        // Ignore: next drain will try again.
      }
    }
  }
  return out.sort((a, b) => a.snapshot.createdAt - b.snapshot.createdAt);
}

/** Record a failed catch-up attempt so a permanently broken snapshot is dropped. */
export function bumpPendingAttempt(file: string, snapshot: PendingFlushSnapshot): void {
  try {
    const next: PendingFlushSnapshot = { ...snapshot, attempts: snapshot.attempts + 1 };
    fs.writeFileSync(file, JSON.stringify(next), "utf8");
  } catch {
    deletePendingFlush(file);
  }
}

export function deletePendingFlush(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone.
  }
}
