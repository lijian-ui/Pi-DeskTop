/**
 * Memory content guard — public API.
 *
 * Call scanMemoryContent() on memory write paths (memory_add / memory_replace)
 * before the text reaches either store. See guard/types.ts for the config shape.
 */

export { scanMemoryContent } from './scanner';
export { loadGuardRules } from './rules';
export { DEFAULT_GUARD_RULES } from './defaults';
export type {
  GuardConfig,
  GuardRule,
  GuardViolation,
  GuardCategory,
  GuardSeverity,
  ScanResult,
} from './types';
