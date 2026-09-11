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
import { AGENT_ROOT } from '../paths';
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

function scanProjectDirs(agentRoot: string, globalDir: string, projectsMemoryDir = "projects-memory"): Array<{ name: string; memoryFile: string }> {
  const projectsRoot = path.resolve(agentRoot, projectsMemoryDir);
  const projects = new Map<string, string>();

  if (fs.existsSync(projectsRoot)) {
    for (const name of fs.readdirSync(projectsRoot)) {
      if (!isSafeProjectName(name, projectsRoot)) continue;
      const memoryFile = resolveAuthoritativeMemoryFile(projectsRoot, name);
      if (memoryFile) {
        projects.set(name, memoryFile);
      }
    }
  }

  const resolvedAgentRoot = path.resolve(agentRoot);
  const resolvedGlobalDir = path.resolve(globalDir);
  const globalDirName = path.dirname(resolvedGlobalDir) === resolvedAgentRoot
    ? path.basename(resolvedGlobalDir)
    : null;
  if (fs.existsSync(agentRoot)) {
    for (const name of fs.readdirSync(agentRoot)) {
      if ((globalDirName && name === globalDirName) || name === projectsMemoryDir || name === 'skills' || name.startsWith('.')) continue;
      if (projects.has(name)) continue;
      if (!isSafeProjectName(name, resolvedAgentRoot)) continue;
      const memoryFile = resolveAuthoritativeMemoryFile(resolvedAgentRoot, name);
      if (memoryFile) {
        projects.set(name, memoryFile);
      }
    }
  }

  return [...projects.entries()]
    .map(([name, memoryFile]) => ({ name, memoryFile }))
    .filter(({ memoryFile }) => fs.existsSync(memoryFile));
}

function realpathIfPresent(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path.resolve(filePath);
    throw error;
  }
}

function resolveAuthoritativeMemoryFile(root: string, projectName: string): string | null {
  const canonicalRoot = realpathIfPresent(root);
  if (!isSafeProjectName(projectName, path.resolve(root))) return null;

  const projectDir = path.join(root, projectName);
  let projectStat: fs.Stats;
  try {
    projectStat = fs.lstatSync(projectDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return path.join(canonicalRoot, projectName, MEMORY_FILE);
    }
    throw error;
  }
  if (projectStat.isSymbolicLink() || !projectStat.isDirectory()) return null;

  const canonicalProjectDir = fs.realpathSync(projectDir);
  if (path.dirname(canonicalProjectDir) !== canonicalRoot) return null;

  const memoryFile = path.join(projectDir, MEMORY_FILE);
  let memoryStat: fs.Stats;
  try {
    memoryStat = fs.lstatSync(memoryFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return path.join(canonicalProjectDir, MEMORY_FILE);
    }
    throw error;
  }
  if (memoryStat.isSymbolicLink() || !memoryStat.isFile()) return null;

  const canonicalMemoryFile = fs.realpathSync(memoryFile);
  if (path.dirname(canonicalMemoryFile) !== canonicalProjectDir || path.basename(canonicalMemoryFile) !== MEMORY_FILE) {
    return null;
  }
  return canonicalMemoryFile;
}

function isSafeProjectName(name: string, projectsRoot: string): boolean {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || path.isAbsolute(name)) {
    return false;
  }
  const projectDir = path.resolve(projectsRoot, name);
  return path.dirname(projectDir) === projectsRoot && path.basename(projectDir) === name;
}

export async function syncMarkdownMemoriesToSqlite(
  dbManager: DatabaseManager,
  globalDir: string,
  projectsMemoryDir?: string,
  agentRoot = AGENT_ROOT,
): Promise<BackfillCounters & { projectCount: number }> {
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
    project: string | null = null,
  ) => {
    const reconcile = () => {
      if (filePath && fs.existsSync(filePath)) counters.filesScanned++;
      const entries = filePath ? readEntries(filePath) : [];
      counters.entriesScanned += entries.length;
      try {
        const result = target === 'failure'
          ? reconcileMarkdownFailureScopes(dbManager, entries)
          : reconcileMarkdownMemoryScope(dbManager, entries, target, project);
        counters.imported += result.inserted;
        counters.skipped += result.existing;
        counters.removed += result.removed;
        if (result.degraded) {
          counters.warnings.push(
            `${path.basename(project ?? 'global')}/${target}: FTS5 search index error (${result.degradedReason}); the index will be rebuilt on the next memory write or session start`,
          );
        }
      } catch (err) {
        counters.warnings.push(
          `${path.basename(project ?? 'global')}/${target}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    if (filePath) await withMarkdownMutationLock(filePath, reconcile);
    else reconcile();
  };

  await reconcileFile(globalMemoryFile, 'memory');
  await reconcileFile(globalUserFile, 'user');
  await reconcileFile(globalFailureFile, 'failure');

  const projects = scanProjectDirs(agentRoot, globalDir, projectsMemoryDir);
  const projectFiles = new Map(projects.map((project) => [project.name, project.memoryFile]));
  const mirroredProjects = dbManager.getDb().prepare(`
    SELECT DISTINCT project
    FROM memories
    WHERE project IS NOT NULL AND target = 'memory'
  `).all() as Array<{ project: string }>;
  const projectNames = new Set([
    ...projectFiles.keys(),
    ...mirroredProjects.map(({ project }) => project),
  ]);
  const projectsRoot = path.resolve(agentRoot, projectsMemoryDir ?? 'projects-memory');
  for (const projectName of projectNames) {
    const memoryFile = projectFiles.get(projectName)
      ?? resolveAuthoritativeMemoryFile(projectsRoot, projectName);
    await reconcileFile(memoryFile, 'memory', projectName);
  }

  return { ...counters, projectCount: projectNames.size };
}

export async function migrateThenSyncMarkdownMemories(
  dbManager: DatabaseManager,
  legacyGlobalDir: string | null,
  globalDir: string,
  projectsMemoryDir?: string,
  agentRoot = AGENT_ROOT,
  migrationOptions: MigrationSyncOptions = {},
): Promise<BackfillCounters & { projectCount: number }> {
  if (legacyGlobalDir) {
    const migration = await migrateExtensionRoot(legacyGlobalDir, globalDir, migrationOptions);
    const sessionsFailure = migration.criticalFailures.find((failure) => failure.name === 'sessions.db');
    if (sessionsFailure) {
      throw new Error(`sessions.db migration failed: ${sessionsFailure.message}`);
    }
    migrationOptions.onMigrationSucceeded?.();
  }
  return await syncMarkdownMemoriesToSqlite(dbManager, globalDir, projectsMemoryDir, agentRoot);
}
