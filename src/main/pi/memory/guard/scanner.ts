/**
 * Content scanner for the memory guard.
 *
 * Compiles each enabled rule's pattern once (cached by source string) and tests
 * the candidate text. With severity 'block', any violation rejects the write;
 * with 'warn', violations are recorded but the write is allowed. The caller
 * (memory_add / memory_replace) decides what to do with a 'warn' result.
 */

import type { GuardConfig, GuardRule, GuardViolation, ScanResult } from './types';
import { loadGuardRules } from './rules';

const compiledCache = new Map<string, RegExp | null>();

function compile(pattern: string): RegExp | null {
  if (compiledCache.has(pattern)) return compiledCache.get(pattern) ?? null;
  let re: RegExp | null = null;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    re = null; // invalid user pattern — skip rather than crash the write path
  }
  compiledCache.set(pattern, re);
  return re;
}

function snippetOf(text: string, match: RegExpMatchArray): string {
  const raw = match[0] ?? '';
  const start = Math.max(0, (match.index ?? 0) - 8);
  const end = Math.min(text.length, (match.index ?? 0) + raw.length + 8);
  let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (snippet.length > 48) snippet = `${snippet.slice(0, 45)}...`;
  return snippet;
}

/**
 * Scan text against the effective rule set. Safe to call on every write: invalid
 * patterns are skipped, and a broken user rules file falls back to built-ins.
 */
export function scanMemoryContent(
  text: string,
  config: GuardConfig,
  rulesPath?: string,
): ScanResult {
  if (!config.enabled || !text) {
    return { allowed: true, violations: [] };
  }

  const rules = loadGuardRules(rulesPath);
  const violations: GuardViolation[] = [];

  for (const rule of rules) {
    if (rule.enabled === false) continue;
    const re = compile(rule.pattern);
    if (!re) continue;
    const match = text.match(re);
    if (match) {
      violations.push({
        ruleId: rule.id,
        name: rule.name,
        category: rule.category,
        snippet: snippetOf(text, match),
      });
    }
  }

  const allowed = config.severity === 'warn' || violations.length === 0;
  return { allowed, violations };
}

export type { GuardRule };
