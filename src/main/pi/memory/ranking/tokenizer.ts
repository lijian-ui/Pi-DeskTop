/**
 * Lightweight CJK-aware tokenizer for the memory ranking layer.
 *
 * Why a custom tokenizer instead of relying on FTS5's trigram index?
 * FTS5 already does substring matching (the candidate set). This tokenizer
 * produces *whole tokens* (identifier words + CJK dictionary max-match with a
 * bigram fallback) so the ranking layer can compute a token-overlap signal
 * between a query and each candidate. The same tokenizer is used at write time
 * (sqlite-memory-store stores the result in memories.search_tokens) and at
 * query time, guaranteeing symmetric overlap counts.
 *
 * This is intentionally NOT a full Chinese segmenter — it only needs enough
 * structure for overlap counting, and the dictionary keeps domain compounds
 * (记忆系统, 压缩锚点) whole.
 */

import { getDictionary, type MemoryDictionary } from './dictionary';

// Latin / identifier runs: letters, digits, and the symbols that appear in
// technical tokens. Keeps "node.js", "c++", "jsonl", "pi-desktop", "vite@6"
// whole instead of splitting on punctuation.
const LATIN_TOKEN = /[a-z0-9](?:[a-z0-9_+#./:@-]*[a-z0-9])?/gi;
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

function pushUnique(tokens: string[], seen: Set<string>, token: string): void {
  if (token.length === 0) return;
  if (seen.has(token)) return;
  seen.add(token);
  tokens.push(token);
}

/**
 * Segment a CJK run with dictionary max-match, falling back to overlapping
 * bigrams for unmatched characters. Overlapping bigrams keep query/entry
 * tokenization symmetric, so term-overlap counts stay consistent even when a
 * dictionary word does not exist for a fragment.
 */
function tokenizeCjkSegment(segment: string, dict: MemoryDictionary, tokens: string[], seen: Set<string>): void {
  const chars = [...segment];
  let i = 0;
  while (i < chars.length) {
    let matched = false;
    const maxLen = Math.min(dict.maxWordLength, chars.length - i);
    for (let len = maxLen; len >= 2; len--) {
      const candidate = chars.slice(i, i + len).join('');
      if (dict.words.has(candidate)) {
        pushUnique(tokens, seen, candidate);
        i += len;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // No dictionary word matched: emit an overlapping bigram. When at the last
    // character, emit the single character so it is at least represented.
    const piece = chars.slice(i, i + 2).join('');
    pushUnique(tokens, seen, piece);
    i += 1;
  }
}

export function tokenizeText(text: string, dict: MemoryDictionary): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  const seen = new Set<string>();

  // 1. Latin / identifier tokens — extracted whole, no dictionary needed.
  for (const match of lower.matchAll(LATIN_TOKEN)) {
    const token = match[0];
    if (token.length < 1) continue;
    // Drop pure-punctuation tokens that the regex may capture at edges.
    if (!/[a-z0-9]/.test(token)) continue;
    pushUnique(tokens, seen, token);
  }

  // 2. CJK runs — dictionary max-match with bigram fallback.
  for (const segment of lower.match(CJK_RUN) ?? []) {
    if (segment.length > 0) tokenizeCjkSegment(segment, dict, tokens, seen);
  }

  return tokens;
}

/**
 * Tokenize for storage: resolves the active dictionary (built-in + user file)
 * and returns a single space-joined token string suitable for
 * memories.search_tokens.
 */
export function tokenizeForStorage(text: string, memoryDir?: string | null): string {
  return tokenizeText(text, getDictionary(memoryDir)).join(' ');
}
