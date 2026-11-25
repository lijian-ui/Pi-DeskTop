/**
 * Memory write tools — registers the LLM-callable memory_add, memory_replace,
 * and memory_remove tools.
 * See PLAN.md → "Hermes Source File Reference Map" for source lines.
 */

import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { MemoryStore } from "../store/memory-store";
import { DatabaseManager } from "../store/db";
import { flagConflictsForWrite } from "../store/conflict-flag";
import {
  formatFailureMemoryContent,
  reconcileMarkdownFailureScopes,
  reconcileMarkdownMemoryScope,
  removeExactSyncedMemories,
  removeSyncedMemories,
  replaceSyncedMemories,
  syncMemoryEntry,
  isFts5QueryError,
} from "../store/sqlite-memory-store";
import { MEMORY_TOOL_DESCRIPTION } from "../constants";
import type { MemoryCategory, MemoryConfig, MemoryResult } from "../types";
import { normalizeMemoryLookupText } from "../store/memory-lookup";
import { scanMemoryContent } from "../guard";
import { createSharedToolResultRenderer } from "./shared-output-view";
import { memoryResultView } from "./tool-result-views";

function appendSyncWarning(result: MemoryResult, warning: string): MemoryResult {
  const warnings = [...(((result as any).warnings ?? []) as string[]), warning];
  const message = result.message ? `${result.message} Warning: ${warning}` : warning;
  return {
    ...result,
    message,
    warning,
    warnings,
  } as MemoryResult;
}

function formatMemoryToolText(result: MemoryResult): string {
  const evictedEntries = result.evicted_entries ?? [];
  if (result.success && evictedEntries.length > 0) {
    const lines = [
      result.message ?? `Memory updated. Rotated ${evictedEntries.length} older ${evictedEntries.length === 1 ? "entry" : "entries"} to stay within the limit.`,
      "",
      "Rotated active memory entries:",
      "",
    ];

    evictedEntries.forEach((entry, index) => {
      lines.push(`${index + 1}. ${entry}`);
      lines.push("");
    });

    lines.push("If one of these entries should stay active, add it again.");
    if (result.usage) lines.push(`Usage: ${result.usage}`);
    return lines.join("\n").trim();
  }

  return JSON.stringify(result);
}

function matchingMutationTargets(
  oldText: string,
  store: MemoryStore,
): Array<"memory" | "user" | "failure"> {
  const lookup = normalizeMemoryLookupText(oldText);
  if (!lookup) return [];

  const targets: Array<"memory" | "user" | "failure"> = [];
  if (store.getMemoryEntries().some((entry) => entry.includes(lookup))) targets.push("memory");
  if (store.getUserEntries().some((entry) => entry.includes(lookup))) targets.push("user");
  if (store.getAllFailureEntries().some((entry) => entry.includes(lookup))) targets.push("failure");
  return targets;
}

function addWrongTargetHint(
  result: MemoryResult,
  rawTarget: "memory" | "user" | "failure",
  oldText: string,
  store: MemoryStore,
): MemoryResult {
  if (result.success || !result.error?.startsWith("No entry matched")) return result;

  const alternatives = matchingMutationTargets(oldText, store)
    .filter((target) => target !== rawTarget);
  if (alternatives.length === 0) return result;

  const quotedTargets = alternatives.map((target) => `"${target}"`).join(", ");
  const noun = alternatives.length === 1 ? "target" : "targets";
  return {
    ...result,
    error: `No match in target "${rawTarget}"; matching entry found in ${noun} ${quotedTargets}. Retry with the displayed target.`,
    matching_targets: alternatives,
  };
}

async function syncAddToSqlite(
  rawTarget: "memory" | "user" | "failure",
  content: string,
  category: MemoryCategory | undefined,
  failureReason: string | undefined,
  dbManager: DatabaseManager | null,
  /**
   * Seed reinforcement for a brand-new row. Without this the row starts at
   * access_count = 0, and since the only place counts are ever incremented is
   * an explicit memory_search hit, a memory the model writes but never searches
   * for stays at 0 forever — it can never reach the anchor threshold and its
   * decay half-life never stretches. Seeding a small initial count breaks that
   * deadlock at the source.
   */
  initialAccessCount = 0,
): Promise<string | null> {
  if (!dbManager) return null;

  try {
    if (rawTarget === "failure") {
      const failureCategory = category ?? "failure";
      syncMemoryEntry(dbManager, {
        content: formatFailureMemoryContent(content, {
          category: failureCategory,
          failureReason,
        }),
        target: "failure",
        project: null,
        category: failureCategory,
        failureReason,
        initialAccessCount,
      });
      return null;
    }

    syncMemoryEntry(dbManager, {
      content,
      target: rawTarget,
      project: null,
      initialAccessCount,
    });
    return null;
  } catch (err) {
    return `Saved to Markdown, but SQLite search sync failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function syncReplaceToSqlite(
  rawTarget: "memory" | "user" | "failure",
  oldText: string,
  newContent: string,
  dbManager: DatabaseManager | null,
): Promise<string | null> {
  if (!dbManager) return null;

  try {
    const syncResult = replaceSyncedMemories(dbManager, oldText, {
      content: newContent,
      target: rawTarget,
      project: null,
    });

    if (syncResult.matched === 0) {
      return "Saved to Markdown, but no matching SQLite memory row was updated. Run /memory-sync-markdown if search results look stale.";
    }

    return null;
  } catch (err) {
    return `Saved to Markdown, but SQLite search sync failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function syncRemoveFromSqlite(
  rawTarget: "memory" | "user" | "failure",
  oldText: string,
  dbManager: DatabaseManager | null,
): Promise<string | null> {
  if (!dbManager) return null;

  try {
    const syncResult = removeSyncedMemories(dbManager, oldText, {
      target: rawTarget,
      project: null,
    });

    if (syncResult.matched === 0) {
      return "Saved to Markdown, but no matching SQLite memory row was removed. Run /memory-sync-markdown if search results look stale.";
    }

    return null;
  } catch (err) {
    return `Saved to Markdown, but SQLite search sync failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function syncEvictionsFromSqlite(
  rawTarget: "memory" | "user" | "failure",
  evictedEntries: string[] | undefined,
  dbManager: DatabaseManager | null,
): Promise<void> {
  if (!dbManager) return;
  if (!evictedEntries || evictedEntries.length === 0) return;

  for (const entry of evictedEntries) {
    try {
      removeExactSyncedMemories(dbManager, entry, {
        target: rawTarget,
        project: null,
      });
    } catch {
      // FIFO already updated the Markdown source of truth. SQLite is only a
      // best-effort search mirror, so eviction cleanup must not fail the write.
    }
  }
}

async function reconcileStoreScope(
  entries: string[],
  rawTarget: "memory" | "user" | "failure",
  dbManager: DatabaseManager | null,
): Promise<string | null | undefined> {
  if (!dbManager) return undefined;
  try {
    if (rawTarget === "failure") {
      return degradedRepairMessage(reconcileMarkdownFailureScopes(dbManager, entries));
    }
    return degradedRepairMessage(
      reconcileMarkdownMemoryScope(dbManager, entries, rawTarget, null),
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (isFts5QueryError(err)) {
      return degradedRepairMessage({ degraded: true, degradedReason: detail });
    }
    return `Saved to Markdown, but SQLite search reconciliation failed: ${detail}`;
  }
}

// A degraded reconcile result means the Markdown write succeeded but the
// SQLite search mirror could not be updated (genuine FTS5 index error). The
// caller must tell the user how to repair the index instead of looking like a
// plain success.
function degradedRepairMessage(result: { degraded?: boolean; degradedReason?: string }): string | null {
  return result.degraded
    ? `Saved to Markdown. Search may be temporarily unavailable (FTS5 index error: ${result.degradedReason}). Run /memory-sync-markdown to rebuild the search index.`
    : null;
}

type MemoryAction = "add" | "replace" | "remove";

type MemoryToolParams = {
  target: "memory" | "user" | "failure";
  content?: string;
  old_text?: string;
  category?: MemoryCategory;
  failure_reason?: string;
};
export function registerMemoryTool(
  pi: ExtensionAPI,
  store: MemoryStore,
  dbManager: DatabaseManager | null = null,
  config: MemoryConfig = {} as MemoryConfig,
): void {
  const reconciledStores = new WeakSet<MemoryStore>();
  const attachMutationObserver = (candidate: MemoryStore | null): void => {
    if (!candidate || reconciledStores.has(candidate) || typeof candidate.setMutationObserver !== "function") return;
    candidate.setMutationObserver((target, entries) =>
      reconcileStoreScope(entries, target, dbManager),
    );
    reconciledStores.add(candidate);
  };
  attachMutationObserver(store);

  /**
   * Flag a direct-tool write against the store it landed in.
   *
   * Conflict detection previously only ran on the background-review path, so a
   * memory the model added by calling memory_add itself was never checked
   * against existing entries. This closes that gap using the shared helper.
   */
  const flagConflictsForActiveStore = async (
    activeStore: MemoryStore,
    rawTarget: "memory" | "user" | "failure",
    content: string,
  ): Promise<void> => {
    if (!dbManager) return;
    try {
      flagConflictsForWrite({
        dbManager,
        existingTexts: activeStore.getMemoryEntries(),
        content,
        target: rawTarget,
        project: null,
      });
    } catch {
      // Advisory only — a flag failure must never fail the write.
    }
  };

  if (typeof pi.on === "function") {
    pi.on("tool_result", (event) => {
      if (!event.toolName.startsWith("memory_")) return;
      const details = event.details as { success?: unknown } | undefined;
      if (details?.success === false) return { isError: true };
    });
  }

  const executeAction = async (
    action: MemoryAction,
    params: MemoryToolParams,
    signal?: AbortSignal,
    sourceSessionId?: string | null,
  ) => {
    const { target: rawTarget, content, old_text, category, failure_reason } = params;
    const target = rawTarget;
    const store_ = store;
    attachMutationObserver(store_);
    // Seed a new row's access_count so freshly written memories are not frozen
    // at zero reinforcement (see syncAddToSqlite).
    const seedAccessCount = Math.max(0, Math.trunc(config.ranking?.initialAccessCount ?? 0));
    let result: MemoryResult;
    let syncWarning: string | null = null;
    const syncHandled = reconciledStores.has(store_);

    // Content guard: block credentials / prompt-injection / encoded payloads
    // before they reach either store. Applies to writes that carry content.
    if ((action === "add" || action === "replace") && content) {
      const guardConfig = config.guard;
      if (guardConfig?.enabled) {
        const scan = scanMemoryContent(content, guardConfig, guardConfig.rulesPath);
        if (!scan.allowed) {
          const reasons = scan.violations
            .map((v) => `${v.name} (${v.category}): "${v.snippet}"`)
            .join("; ");
          const blocked = {
            success: false,
            error: `Memory write blocked by content guard: ${reasons}`,
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(blocked) }],
            details: blocked,
          };
        }
      }
    }

    switch (action) {
      case "add":
        if (!content) {
          throw new Error("Content is required for 'add' action.");
        }
        if (rawTarget === "failure") {
          const memoryCategory = category ?? "failure";
          result = await store_.addFailure(content, {
            category: memoryCategory,
            failureReason: failure_reason,
            sourceSessionId,
          });
          if (result.success && !syncHandled) {
            syncWarning = await syncAddToSqlite(rawTarget, content, memoryCategory, failure_reason, dbManager);
          }
        } else {
          result = await store_.add(target, content, signal, sourceSessionId);
          if (result.success && !syncHandled) {
            await syncEvictionsFromSqlite(rawTarget, result.evicted_entries, dbManager);
            syncWarning = await syncAddToSqlite(rawTarget, content, undefined, undefined, dbManager, seedAccessCount);
          }
        }
        if (result.success) {
          await flagConflictsForActiveStore(store_, rawTarget, content);
        }
        break;
      case "replace":
        if (!old_text) throw new Error("old_text is required for 'replace' action.");
        if (!content) throw new Error("content is required for 'replace' action.");
        result = await store_.replace(target, old_text, content);
        if (result.success && !syncHandled) {
          syncWarning = await syncReplaceToSqlite(rawTarget, old_text, content, dbManager);
        }
        if (result.success) {
          await flagConflictsForActiveStore(store_, rawTarget, content);
        }
        break;
      case "remove":
        if (!old_text) throw new Error("old_text is required for 'remove' action.");
        result = await store_.remove(target, old_text);
        if (result.success && !syncHandled) {
          syncWarning = await syncRemoveFromSqlite(rawTarget, old_text, dbManager);
        }
        break;
    }

    if (action !== "add" && old_text) {
      result = addWrongTargetHint(result, rawTarget, old_text, store);
    }

    if (result.success && !syncHandled && typeof store_.getRawEntriesForSync === "function") {
      const reconciliationWarning = await reconcileStoreScope(store_.getRawEntriesForSync(target), rawTarget, dbManager);
      if (reconciliationWarning !== undefined) syncWarning = reconciliationWarning;
    }

    if (syncWarning && result.success) result = appendSyncWarning(result, syncWarning);

    return {
      content: [{ type: "text" as const, text: formatMemoryToolText(result) }],
      details: result,
    };
  };

  const commonDescription = `${MEMORY_TOOL_DESCRIPTION}

This action-specific tool accepts only the parameters listed in its schema.`;

  const registerActionTool = (
    action: MemoryAction,
    name: string,
    label: string,
    description: string,
    parameters: TSchema,
  ) => {
    pi.registerTool({
      name,
      label,
      description,
      promptSnippet: `${label}: persistent memory that survives across sessions`,
      // 触发时机与禁存内容已在 description 内嵌的 MEMORY_TOOL_DESCRIPTION
      // （WHEN TO SAVE / Do NOT save）中完整声明，guidelines 不再复述。
      promptGuidelines: [],
      renderResult: createSharedToolResultRenderer(memoryResultView),
      parameters,
      async execute(_toolCallId, params, signal, _onUpdate, ctx?: ExtensionToolContext) {
        // 记录来源会话（episodic 回溯用）；无会话上下文时传 null。
        const sourceSessionId = ctx?.sessionManager?.getSessionId() ?? null;
        return executeAction(action, params as MemoryToolParams, signal, sourceSessionId);
      },
    });
  };

  const target = StringEnum(["memory", "user", "failure"] as const, {
    description: "Memory scope. Use failure for failures, corrections, insights, and tool quirks.",
  });
  const category = StringEnum(["failure", "correction", "insight", "preference", "convention", "tool-quirk"] as const, {
    description: "Category for failure memories.",
  });

  registerActionTool(
    "add",
    "memory_add",
    "Memory Add",
    `${commonDescription}

Add one durable entry. The target and content fields are required.`,
    Type.Object({
      target,
      content: Type.String({ description: "Entry content to save." }),
      category: Type.Optional(category),
      failure_reason: Type.Optional(Type.String({ description: "Why a failure occurred." })),
    }),
  );
  registerActionTool(
    "replace",
    "memory_replace",
    "Memory Replace",
    `${commonDescription}

Replace one existing entry. The target, old_text, and content fields are required.`,
    Type.Object({
      target,
      old_text: Type.String({ description: "Substring identifying the entry to replace." }),
      content: Type.String({ description: "Replacement entry content." }),
    }),
  );
  registerActionTool(
    "remove",
    "memory_remove",
    "Memory Remove",
    `${commonDescription}

Remove one existing entry. The target and old_text fields are required.`,
    Type.Object({
      target,
      old_text: Type.String({ description: "Substring identifying the entry to remove." }),
    }),
  );
}
