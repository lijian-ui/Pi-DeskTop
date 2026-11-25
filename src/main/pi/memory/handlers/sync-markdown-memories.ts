/**
 * Markdown memory sync — reconciles the SQLite search mirror with the
 * authoritative Markdown memory files. Runs on session start and after memory
 * mutations; there is no user-facing command for it on the desktop shell.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DatabaseManager } from '../store/db';
import {
  reconcileMarkdownFailureScopes,
  reconcileMarkdownMemoryScope,
} from '../store/sqlite-memory-store';
import { ENTRY_DELIMITER, MEMORY_FILE, USER_FILE } from '../constants';
import {
  migrateExtensionRoot,
  type ExtensionRootMigrationOptions,
} from '../extension-root-migration';
import { withMarkdownMutationLock } from '../store/markdown-mutation-lock';

export interface BackfillCounters {
  filesScanned: number;
  entriesScanned: number;
  imported: number;
  skipped: number;
  removed: number;
  warnings: string[];
}

export interface MigrationSyncOptions extends ExtensionRootMigrationOptions {
  onMigrationSucceeded?: () => void;
}

function readEntries(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8').trim();
  if (!raw) return [];
  return raw.split(ENTRY_DELIMITER).map((entry) => entry.trim()).filter(Boolean);
}

export async function syncMarkdownMemoriesToSqlite(
  dbManager: DatabaseManager,
  globalDir: string,
): Promise<BackfillCounters> {
  const counters: BackfillCounters = {
    filesScanned: 0,
    entriesScanned: 0,
    imported: 0,
    skipped: 0,
    removed: 0,
    warnings: [],
  };

  const globalMemoryFile = path.join(globalDir, MEMORY_FILE);
  const globalUserFile = path.join(globalDir, USER_FILE);
  const globalFailureFile = path.join(globalDir, 'failures.md');

  const reconcileFile = async (
    filePath: string | null,
    target: 'memory' | 'user' | 'failure',
  ) => {
    // 记忆是长期上下文，不应因删除会话 / 记忆文件而消失。
    // 权威源 Markdown 缺失时保留 SQLite 镜像、不触发孤儿清理；
    // 仅当 md 存在但被手编删除了条目，才视为用户主动删除记忆。
    if (!filePath || !fs.existsSync(filePath)) {
      return;
    }
    const reconcile = () => {
      counters.filesScanned++;
      const entries = readEntries(filePath);
      counters.entriesScanned += entries.length;
      try {
        const result = target === 'failure'
          ? reconcileMarkdownFailureScopes(dbManager, entries)
          : reconcileMarkdownMemoryScope(dbManager, entries, target, null);
        counters.imported += result.inserted;
        counters.skipped += result.existing;
        counters.removed += result.removed;
        if (result.degraded) {
          counters.warnings.push(
            `${target}: FTS5 search index error (${result.degradedReason}); the index will be rebuilt on the next memory write or session start`,
          );
        }
      } catch (err) {
        counters.warnings.push(
          `${target}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    await withMarkdownMutationLock(filePath, reconcile);
  };

  await reconcileFile(globalMemoryFile, 'memory');
  await reconcileFile(globalUserFile, 'user');
  await reconcileFile(globalFailureFile, 'failure');

  return counters;
}

export async function migrateThenSyncMarkdownMemories(
  dbManager: DatabaseManager,
  legacyGlobalDir: string | null,
  globalDir: string,
  migrationOptions: MigrationSyncOptions = {},
): Promise<BackfillCounters> {
  if (legacyGlobalDir) {
    const migration = await migrateExtensionRoot(legacyGlobalDir, globalDir, migrationOptions);
    const sessionsFailure = migration.criticalFailures.find((failure) => failure.name === 'sessions.db');
    if (sessionsFailure) {
      throw new Error(`sessions.db migration failed: ${sessionsFailure.message}`);
    }
    migrationOptions.onMigrationSucceeded?.();
  }
  return await syncMarkdownMemoriesToSqlite(dbManager, globalDir);
}
