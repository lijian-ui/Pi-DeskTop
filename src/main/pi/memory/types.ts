/**
 * Shared TypeScript types for the Hermes Memory extension.
 */

import type { ModelThinkingLevel, TextContent } from "@earendil-works/pi-ai";
import type { RankingConfig } from "./ranking/types";
import type { AnchorConfig } from "./anchors/types";
import type { GuardConfig } from "./guard/types";

export type MemoryOverflowStrategy = "auto-consolidate" | "reject" | "fifo-evict";

export type SessionSearchVariant = "legacy" | "anchors";

export type ThinkingLevel = ModelThinkingLevel;

export type ReviewTransport = "direct" | "subprocess";

export interface SessionSearchConfig {
  /** Session search implementation variant. Default: legacy */
  variant: SessionSearchVariant;
}

export interface MemoryConfig {
  /**
   * Prompt memory mode. Only "policy-only" remains: the policy prompt is always
   * injected and memory bodies are never dumped into the system prompt
   * (old configs holding "legacy-inject" are silently migrated in config.ts).
   */
  memoryMode: "policy-only";
  /** Max chars for MEMORY.md (agent notes). Default: 5000 */
  memoryCharLimit: number;
  /** Max chars for USER.md (user profile). Default: 5000 */
  userCharLimit: number;
  /** How background LLM calls (consolidation, pending-flush catch-up) invoke the model. Default: direct */
  reviewTransport?: ReviewTransport;
  /**
   * Single auto-deposit switch. When on:
   * - a hidden user-role flush turn is injected once enough context has been
   *   dropped (merged trigger: N events or M dropped tokens);
   * - shutdown writes a conversation snapshot for the next session to drain.
   * When off, neither path runs. Default: true
   */
  autoDeposit: boolean;
  /** Override extension storage directory. Default: ~/.pi/agent/pi-hermes-memory */
  memoryDir?: string;
  /** Directory for project-scoped memory (relative to ~/.pi/agent). Default: "projects-memory" */
  projectsMemoryDir?: string;
  /** Session search configuration. Default: { variant: "legacy" } */
  sessionSearch?: SessionSearchConfig;
  /** Run a full SQLite quick_check asynchronously after opening. Default: true */
  quickCheckOnOpen?: boolean;
  /** Override model used for child pi -p subprocess LLM calls. Default: unset */
  llmModelOverride?: string;
  /** Fallback model chain tried in order when the primary review model fails (rate limit, 401/403, 404, 500/503, invalid response). Default: unset */
  llmFallbackModels?: string[];
  /** Override thinking level used for child pi -p subprocess LLM calls. Default: unset */
  llmThinkingOverride?: ThinkingLevel;
  /** Trusted Pi extension sources required by child processes, such as custom providers or auth adapters. */
  childExtensionPaths?: string[];
  /** Strategy when memory is full. Default: auto-consolidate */
  memoryOverflowStrategy?: MemoryOverflowStrategy;
  /** Wall-clock grace after overflow before automatic consolidation. Default: 180000 */
  overflowGraceMs?: number;
  /** Legacy alias for memoryOverflowStrategy. Default: true */
  autoConsolidate: boolean;
  /**
   * Inject recent correction / preference memories into the system prompt.
   * Default: true
   */
  correctionInjectionEnabled?: boolean;
  /**
   * Append a one-line memory_search hint to user messages that refer to prior
   * context (上次 / 之前 / as we agreed ...). Default: true
   */
  retrievalHintEnabled?: boolean;
  /** Maximum time in milliseconds for a consolidation run, auto or manual. Default: 180000 */
  consolidationTimeoutMs: number;
  /** Log failed auto-consolidation attempts to the session console. Default: true */
  autoConsolidationWarnOnFailure: boolean;
  /**
   * Session retention window in days. A positive value opts in to pruning
   * sessions (and their messages) older than the window on startup; `0`/omitted
   * disables pruning so no existing searchable history is silently deleted.
   * Default: 0 (disabled).
   */
  sessionRetentionDays?: number;
  /** Multi-signal reranking of memory_search results (fts + term + decay + recency + affinity, fused with weighted RRF). */
  ranking?: RankingConfig;
  /** Compact bridge: pin high-value memories and inject them back after compaction so key facts survive context resets. */
  anchors?: AnchorConfig;
  /** Content guard: block credentials / prompt-injection / encoded payloads from being written to memory. */
  guard?: GuardConfig;
}

export type MemoryCategory =
  | "failure"
  | "correction"
  | "insight"
  | "preference"
  | "convention"
  | "tool-quirk";

export interface MemoryResult {
  success: boolean;
  error?: string;
  message?: string;
  warning?: string;
  warnings?: string[];
  target?: "memory" | "user" | "failure";
  entries?: string[];
  usage?: string;
  entry_count?: number;
  evicted_entries?: string[];
  evicted_count?: number;
  matches?: string[];
  /** Targets that contain old_text when a replace/remove was sent to the wrong one. */
  matching_targets?: Array<"memory" | "user" | "failure">;
}

export interface MemoryMutationOperation {
  action: "add" | "replace" | "remove";
  content?: string;
  oldText?: string;
  category?: MemoryCategory;
  failureReason?: string;
  project?: string;
}

export interface MemorySnapshot {
  memory: string;
  user: string;
}

export interface ConsolidationResult {
  /** Whether consolidation succeeded */
  consolidated: boolean;
  /** Error message if consolidation failed */
  error?: string;
  /**
   * Set when another session already holds the consolidation lock for this
   * target. Nothing is broken — the work is happening elsewhere — so callers
   * should tell the user to retry rather than report a failed consolidation.
   */
  deferred?: boolean;
}

export type SkillScope = "global" | "project";

export interface SkillIndex {
  /** Stable id for read/update/delete operations */
  skillId: string;
  /** Whether the skill is global or project-scoped */
  scope: SkillScope;
  /** File name on disk (usually SKILL.md) */
  fileName: string;
  /** Absolute path to the skill file */
  path: string;
  /** Active project name for project-scoped skills */
  projectName?: string;
  /** Pi skill slug stored in frontmatter and folder name */
  name: string;
  /** Optional human-friendly title preserved for UI output */
  displayName?: string;
  /** Short description shown in skill listings */
  description: string;
  /** ISO date created */
  created: string;
  /** ISO date last updated */
  updated: string;
}

export interface SkillDocument extends SkillIndex {
  /** Full markdown body (after frontmatter) */
  body: string;
  /** Version number */
  version: number;
}

export interface SkillResult {
  success: boolean;
  error?: string;
  message?: string;
  fileName?: string;
  skillId?: string;
  scope?: SkillScope;
  path?: string;
  conflictType?: "duplicate" | "similar" | "name-collision" | "scope-conflict";
  similarSkillIds?: string[];
  suggestedAction?: "patch" | "update" | "rename";
}

/**
 * Extract displayable text from a Pi session entry message.
 *
 * Accepts any value — returns null for non-message entries (BashExecutionMessage,
 * NotificationMessage, etc.) that lack a `content` property.
 *
 * Returns the concatenated text, truncated to `maxLength` chars.
 */
export function getMessageText(msg: unknown, maxLength = 500): string | null {
  if (typeof msg !== "object" || msg === null) return null;
  const { role, content } = msg as Record<string, unknown>;
  if (typeof role !== "string") return null;

  if (typeof content === "string") {
    return content.slice(0, maxLength);
  }
  if (Array.isArray(content)) {
    const text = (content as TextContent[])
      .filter((block): block is TextContent => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    return text.length > 0 ? text.slice(0, maxLength) : null;
  }
  return null;
}
