/**
 * Load and merge guard rules.
 *
 * Built-in floor rules are the base. A user rules file (guard-rules.json) can:
 *  - disable a built-in rule by referencing its id with `enabled: false`
 *  - override a built-in rule (id + new pattern/name/description)
 *  - add entirely new rules (new id)
 *
 * A corrupt or missing user file degrades to the built-ins instead of throwing —
 * the guard must never block startup or writes because a rules file is broken.
 */

import * as fs from 'node:fs';
import type { GuardRule } from './types';
import { DEFAULT_GUARD_RULES } from './defaults';
import { readJsonFileSync } from '../../../json-file';

interface UserRuleShape {
  id?: unknown;
  name?: unknown;
  category?: unknown;
  pattern?: unknown;
  description?: unknown;
  enabled?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readUserRules(rulesPath?: string): UserRuleShape[] {
  if (!rulesPath) return [];
  try {
    if (!fs.existsSync(rulesPath)) return [];
    const parsed: unknown = readJsonFileSync(rulesPath);
    if (Array.isArray(parsed)) return parsed as UserRuleShape[];
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { rules?: unknown }).rules)) {
      return (parsed as { rules: unknown[] }).rules as UserRuleShape[];
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Resolve the effective rule set: built-ins overridden/extended by the user file.
 */
export function loadGuardRules(rulesPath?: string): GuardRule[] {
  const byId = new Map<string, GuardRule>();
  for (const rule of DEFAULT_GUARD_RULES) {
    byId.set(rule.id, { ...rule });
  }

  for (const user of readUserRules(rulesPath)) {
    const id = asString(user.id);
    if (!id) continue;

    const existing = byId.get(id);
    if (existing) {
      const pattern = asString(user.pattern);
      const category = asString(user.category);
      const name = asString(user.name);
      const description = asString(user.description);
      byId.set(id, {
        ...existing,
        ...(name ? { name } : {}),
        ...(category ? { category: category as GuardRule['category'] } : {}),
        ...(description ? { description } : {}),
        ...(pattern ? { pattern } : {}),
        enabled: typeof user.enabled === 'boolean' ? user.enabled : existing.enabled,
      });
    } else {
      const pattern = asString(user.pattern);
      const category = asString(user.category);
      const name = asString(user.name);
      if (!pattern || !category || !name) continue; // new rules need all fields
      byId.set(id, {
        id,
        name,
        category: category as GuardRule['category'],
        pattern,
        description: asString(user.description) ?? name,
        enabled: typeof user.enabled === 'boolean' ? user.enabled : true,
      });
    }
  }

  return [...byId.values()];
}
