export function normalizeMemoryLookupText(text: string): string {
  let normalized = text.trim();
  if (!normalized) return "";

  const firstNonEmptyLine = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstNonEmptyLine) normalized = firstNonEmptyLine;

  // Older memory_search results prefixed entries with a scope token; keep
  // stripping it so previously copied lines still work as lookup text.
  normalized = normalized.replace(
    /^\S+\s+scope=global\s+\[target=(?:memory|user|failure)\]\s+/u,
    "",
  );
  normalized = normalized.replace(/^\S+\s+\[[^\]]+\]\s+/u, "");
  // memory_search labels each result with its mutation target.
  // Keep copied search lines usable as replace/remove lookup text.
  normalized = normalized.replace(/^\[target=(?:memory|user|failure)\]\s+/u, "");
  normalized = normalized.replace(/^(\[[^\]]+\])\s+\1(\s+|$)/, "$1 ");

  return normalized.trim();
}
