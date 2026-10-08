/**
 * Two-layer custom dictionary for the memory tokenizer.
 *
 * Layer 1 is a small built-in set of technical terms; layer 2 is the user's
 * own file at <memoryDir>/dict-extra.json. Without a dictionary the CJK
 * tokenizer falls back to bigrams, which is decent but splits domain
 * compounds ("记忆系统" -> "记忆" + "忆系" + "系统").
 *
 * The dictionary is data, not code: adding a word is an edit to a JSON file,
 * never a patch to the tokenizer.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readJsonFileSync } from '../../../json-file';

export const DICT_EXTRA_FILENAME = 'dict-extra.json';

/**
 * Generic technical vocabulary. Deliberately small — it exists to keep
 * identifiers and domain compounds whole, not to be a Chinese word list.
 */
const BUILTIN_WORDS: readonly string[] = [
  // English / identifiers
  'electron', 'vite', 'typescript', 'javascript', 'sqlite', 'fts5', 'openai',
  'node', 'nodejs', 'npm', 'pnpm', 'yarn', 'esm', 'cjs', 'ipc', 'preload',
  'renderer', 'main', 'tokenizer', 'embedding', 'embeddings', 'rerank',
  'pagerank', 'jsonl', 'yaml', 'toml', 'json', 'docker', 'git', 'github',
  'bash', 'powershell', 'windows', 'macos', 'linux', 'sqlite3', 'trigram',
  'bigram', 'bm25', 'rrf', 'api', 'key', 'token', 'prompt',
  'agent', 'subagent', 'extension', 'plugin', 'skill', 'skills', 'session',
  'sessions', 'context', 'compaction', 'compact', 'anchor', 'anchors',
  'memory', 'memories', 'decay', 'reinforcement', 'threshold', 'snapshot',
  'guard', 'scanner', 'dictionary', 'index', 'indexer', 'backfill', 'cache',
  'thinking', 'tool', 'tools', 'model', 'models', 'provider',
  'stream', 'streaming', 'markdown', 'config', 'settings', 'schema',
  'migration', 'migrate', 'retention', 'prune', 'checkpoint', 'wal',
  'dingtalk', 'gateway', 'webhook', 'tts', 'cron', 'schedule',
  // Chinese domain compounds
  '记忆', '记忆系统', '会话', '扩展', '插件', '压缩', '锚点', '检索', '权重',
  '衰减', '索引', '缓存', '依赖', '构建', '打包', '渲染', '主进程', '渲染进程',
  '渲染端', '托盘', '工作区', '任务', '空间', '工具调用', '子代理', '定时任务',
  '钉钉', '网关', '知识库', '分词', '向量', '图谱', '去重', '快照', '守卫',
  '纠正', '复习', '后台', '前台', '提示词', '系统提示', '上下文', '项目',
  '全局', '偏好', '约定', '教训', '失败', '技能', '流程', '流水线', '门控',
  '配置', '开关', '阈值', '半衰期', '强化', '排序', '融合', '候选', '信号',
];

export interface MemoryDictionary {
  words: ReadonlySet<string>;
  maxWordLength: number;
}

interface CacheEntry {
  dict: MemoryDictionary;
  mtimeMs: number;
}

const cache = new Map<string, CacheEntry>();
const BUILTIN_DICT: MemoryDictionary = build([...BUILTIN_WORDS]);

function build(words: Iterable<string>): MemoryDictionary {
  const set = new Set<string>();
  let maxWordLength = 1;
  for (const raw of words) {
    const word = raw.trim().toLowerCase();
    if (word.length === 0) continue;
    set.add(word);
    if (word.length > maxWordLength) maxWordLength = word.length;
  }
  return { words: set, maxWordLength };
}

/**
 * Read the user's extra dictionary. Accepts either a bare array or an object
 * with a `words` array. A missing or corrupt file degrades to the built-in
 * dictionary instead of throwing — tokenizer setup must never break startup.
 */
function readExtraWords(filePath: string): string[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const parsed: unknown = readJsonFileSync(filePath);
    if (Array.isArray(parsed)) return parsed.filter((w): w is string => typeof w === 'string');
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { words?: unknown }).words)) {
      return ((parsed as { words: unknown[] }).words).filter((w): w is string => typeof w === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Resolve the dictionary for a memory directory. Results are cached per
 * directory and invalidated by mtime, so editing dict-extra.json takes effect
 * without a restart.
 */
export function getDictionary(memoryDir?: string | null): MemoryDictionary {
  if (!memoryDir) return BUILTIN_DICT;

  const filePath = path.join(memoryDir, DICT_EXTRA_FILENAME);
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    // No user dictionary — built-ins only. Drop any stale cache entry.
    cache.delete(filePath);
    return BUILTIN_DICT;
  }

  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.dict;

  const dict = build([...BUILTIN_WORDS, ...readExtraWords(filePath)]);
  cache.set(filePath, { dict, mtimeMs });
  return dict;
}

/** Invalidate the cached dictionary (used by tests and reload paths). */
export function clearDictionaryCache(): void {
  cache.clear();
}
