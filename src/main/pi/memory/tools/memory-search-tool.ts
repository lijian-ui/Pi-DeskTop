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
- Find repo conventions or architecture decisions: "What conventions does this repo follow?"
- Find user preferences: "What are the user's testing preferences?"
- Search for past failures: "memory_search('auth', category='failure')"
- List everything stored: call memory_search with an empty query (optionally filter by target/category) to browse all memories.

Returns matching memory entries with their mutation target and dates. The displayed target is the value required by memory_replace and memory_remove.`,
    promptSnippet: 'Search extended memory store (unlimited capacity)',
    // 前三条已被 description 的 Use cases + category 参数 schema 覆盖；
    // 空查询 browse 兜底纪律现由 <memory-policy> 统一声明（compact 版）。
    promptGuidelines: [],
    renderResult: createSharedToolResultRenderer(searchResultView),
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: 'Search query. Use natural language or specific terms. Leave empty to list all memories (optionally filtered by target/category).' })),
      target: Type.Optional(StringEnum(['memory', 'user', 'failure'] as const, { description: 'Filter by target type: memory, user, or failure.' })),
      category: Type.Optional(StringEnum(['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk'] as const, { description: 'Filter by memory category.' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum results to return (default: 10, max: 20).' })),
    }),
    // pi 1.6.0：Optional(StringEnum) 的推断退化成 unknown，手写窄标注按参数逆变
    // 会直接编译失败；同 skill-tool —— 让 pi 推断，进来后 as 回真实形状。
    execute: async (_id: string, params: unknown) => {
      const args = params as { query?: string; target?: 'memory' | 'user' | 'failure'; category?: string; limit?: number };
      const query = (args.query ?? '').trim();
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
      let browseTotal = 0;

      if (isListAll) {
        // Browse mode: list every stored memory (optionally scoped by filters).
        // 项目记忆功能已移除：历史行仍保留在 SQLite 里（不删行），
        // 但 project 列非空的行属于已不可见来源的旧数据，必须过滤掉，
        // 否则会出现「看不见来源的幽灵记忆」。
        const all = getMemories(dbManager, { project: null, target, category });
        browseTotal = all.length;
        entries = all.slice(0, limit);
      } else {
        const results = searchMemoriesRanked(dbManager, query, {
          project: null,
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
            message: `No memories found matching "${query}". Try a different search term, or call memory_search with an empty query to list all stored memories. Note: the search index is trigram-based — terms shorter than 3 characters (common with short Chinese words) cannot match; use longer, more specific terms.`,
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
        ? // 不能说 "all"：结果被 limit 截断，说 all 会让使用者误以为这就是全库规模。
          `Showing first ${entries.length} of ${browseTotal} memories${entries.length < browseTotal ? " — raise the limit, or narrow with target/category filters, to see the rest" : ""}:\n\n`
        : `Found ${entries.length} memories matching "${query}":\n\n`;

      for (const entry of entries) {
        const mutationTargetLabel = `[target=${entry.target}]`;
        const targetLabel = entry.target === 'user' ? '👤' : entry.target === 'failure' ? '⚠️' : '🧠';
        const categoryLabel = entry.category ? ` [${entry.category}]` : '';
        // failure 条目的 Markdown 正文自带 "[category] " 前缀（权威格式的一部分），
        // 展示时剥掉，避免与 categoryLabel 拼出 "[tool-quirk] [tool-quirk]"。
        const bodyText = entry.category && entry.content.startsWith(`[${entry.category}] `)
          ? entry.content.slice(entry.category.length + 3)
          : entry.content;
        output += `${targetLabel} ${mutationTargetLabel}${categoryLabel} ${bodyText}\n`;
        output += `   Created: ${entry.created} | Last used: ${entry.lastReferenced}\n\n`;
      }

      const finalResult: SearchResult = { success: true, count: entries.length, output: output.trim() };
      return { content: [{ type: 'text' as const, text: output.trim() }], details: finalResult };
    },
  });
}
