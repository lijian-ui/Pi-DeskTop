/**
 * Types for the memory content guard.
 *
 * The guard intercepts memory writes before they reach either store (Markdown or
 * SQLite), blocking content that looks like a leaked credential, a prompt-
 * injection attempt, or an obfuscated/encoded payload. Rules are data, not code:
 * built-in floor rules ship with the extension, and a user can disable or extend
 * them via a JSON file — no code changes required.
 */

export type GuardSeverity = 'block' | 'warn';

export type GuardCategory = 'credential' | 'prompt-injection' | 'encoded-payload';

export interface GuardRule {
  id: string;
  name: string;
  category: GuardCategory;
  /** Regex source string (case-insensitive match). */
  pattern: string;
  description: string;
  /** When false the rule is skipped. Defaults to true. */
  enabled?: boolean;
}

export interface GuardViolation {
  ruleId: string;
  name: string;
  category: GuardCategory;
  /** Matched substring, truncated for safe logging. */
  snippet: string;
}

export interface ScanResult {
  allowed: boolean;
  violations: GuardViolation[];
}

export interface GuardConfig {
  enabled: boolean;
  /** 'block' rejects the write; 'warn' records violations but allows it. */
  severity: GuardSeverity;
  /** Optional absolute path to a user rules JSON file. Built-in rules always apply unless disabled by a same-id user rule. */
  rulesPath?: string;
}
