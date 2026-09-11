import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { DatabaseManager } from '../store/db';
import { searchMemoriesRanked, incrementAccessCounts, getMemoryStats, getMemories, type SqliteMemoryEntry } from '../store/sqlite-memory-store';
import type { RankableMemory } from '../ranking/types';
import type { MemoryCategory, MemoryConfig } from '../types';
import { createSharedToolResultRenderer } from './shared-output-view';
import { searchResultView } from './tool-result-views';

interface SearchResult {
  success: boolean;
  count?: number;
  message?: string;
  output?: string;
}

function mutationTarget(entry: { target: "memory" | "user" | "failure"; project: string | null }): "memory" | "user" | "failure" | "project" {
  // A project name scopes ordinary memory entries, but project-attributed
  // failures still live in (and must be mutated through) the failure store.
  return entry.target === "memory" && entry.project ? "project" : entry.target;
}

function scopeLabel(project: string | null): string {
  return project ? `project:${encodeURIComponent(project)}` : "global";
}

export function registerMemorySearchTool(
  pi: ExtensionAPI,
  dbManager: DatabaseManager,
  config: MemoryConfig,
  memoryDir: string,
): void {
  pi.registerTool({
    name: 'memory_search',
    label: 'Memory Search',
    description: `Search extended memory store for relevant entries. Use this when you need context beyond what's in the system prompt — the extended store has unlimited capacity and is searchable.

Use cases:
- Find memories about a specific topic: "What do I know about auth setup?"
- Search project-specific memories: "What conventions does project X follow?"
- Find user preferences: "What are the user's testing preferences?"
- Search for past failures: "memory_search('auth', category='failure')"
- List everything stored: call memory_search with an empty query (optionally filter by project/target/category) to browse all memories.

target="project" returns only project-attributed memory entries (the ones labeled [target=project]); combine with project to search a named project.

Returns matching memory entries with their mutation target, scope, and dates. The displayed target is the value required by memory_replace and memory_remove.`,
    promptSnippet: 'Search extended memory store (unlimited capacity)',
    promptGuidelines: [
      'Use memory_search when you need context beyond what is in the system prompt.',
      'Use memory_search to find project-specific memories or user preferences.',
      'Use memory_search with category filter to find specific types of memories (failure, correction, insight, etc.).',
      'If a search returns nothing, call memory_search with an empty query to browse all stored memories (optionally filtered by project/target/category) before giving up.',
    ],
    renderResult: createSharedToolResultRenderer(searchResultView),
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: 'Search query. Use natural language or specific terms. Leave empty to list all memories (optionally filtered by project/target/category).' })),
      project: Type.Optional(Type.String({ description: 'Filter by project name. Pass null for global memories only.' })),
      target: Type.Optional(StringEnum(['memory', 'user', 'failure', 'project'] as const, { description: 'Filter by target type: memory, user, failure, or project-attributed memories.' })),
      category: Type.Optional(StringEnum(['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk'] as const, { description: 'Filter by memory category.' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum results to return (default: 10, max: 20).' })),
    }),
    execute: async (_id: string, args: { query?: string; project?: string; target?: 'memory' | 'user' | 'failure' | 'project'; category?: string; limit?: number }) => {
      const query = (args.query ?? '').trim();
      const project = args.project;
      const target = args.target;
      const category = args.category as MemoryCategory | undefined;
      const limit = Math.min(args.limit || 10, 20);

      const stats = getMemoryStats(dbManager);
      if (stats.total === 0) {
        const result: SearchResult = { success: false, message: 'No memories in extended store yet. Use memory_add to store memories.' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const isListAll = query.length === 0;
      let entries: Array<SqliteMemoryEntry | RankableMemory>;

      if (isListAll) {
        // Browse mode: list every stored memory (optionally scoped by filters).
        entries = getMemories(dbManager, { project, target, category }).slice(0, limit);
      } else {
        const results = searchMemoriesRanked(dbManager, query, {
          project,
          target,
          category,
          limit,
          ranking: config.ranking ?? null,
          memoryDir,
        });
        if (results.length === 0) {
          const result: SearchResult = {
            success: true,
            count: 0,
            message: `No memories found matching "${query}". Try a different search term, or call memory_search with an empty query to list all stored memories.`,
          };
          return { content: [{ type: 'text' as const, text: result.message! }], details: result };
        }
        // Reinforce surfaced memories so frequently-referenced entries decay slower.
        incrementAccessCounts(dbManager, results.map((r) => r.memory.id));
        entries = results.map((r) => r.memory);
      }

      if (entries.length === 0) {
        const scope = [
          target ? `target=${target}` : '',
          project ? `project=${project}` : '',
          category ? `category=${category}` : '',
        ].filter(Boolean).join(', ');
        const result: SearchResult = {
          success: true,
          count: 0,
          message: `No memories found${scope ? ` for ${scope}` : ''}. Use memory_add to store memories.`,
        };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      let output = isListAll
        ? `Listing all ${entries.length} memories${limit < entries.length ? ` (showing first ${limit} of ${entries.length})` : ''}:\n\n`
        : `Found ${entries.length} memories matching "${query}":\n\n`;

      for (const entry of entries) {
        const mt = mutationTarget(entry);
        const projectLabel = `scope=${scopeLabel(entry.project)}`;
        const mutationTargetLabel = `[target=${mt}]`;
        const targetLabel = entry.target === 'user' ? '👤' : entry.target === 'failure' ? '⚠️' : '🧠';
        const categoryLabel = entry.category ? ` [${entry.category}]` : '';
        output += `${targetLabel} ${projectLabel} ${mutationTargetLabel}${categoryLabel} ${entry.content}\n`;
        output += `   Created: ${entry.created} | Last used: ${entry.lastReferenced}\n\n`;
      }

      const finalResult: SearchResult = { success: true, count: entries.length, output: output.trim() };
      return { content: [{ type: 'text' as const, text: output.trim() }], details: finalResult };
    },
  });
}
