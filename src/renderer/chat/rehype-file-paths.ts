/**
 * rehype plugin: wrap filesystem paths found in prose so the chat can render
 * them as clickable "preview this file" links.
 *
 * Design notes
 * ------------
 * - The regex is deliberately permissive (single filenames like `config.json`
 *   match too). False positives are NOT a problem because every candidate is
 *   stat()-ed before it becomes a link: anything that doesn't resolve to a
 *   real file renders as plain text again. That trade keeps the regex simple
 *   while guaranteeing no dead links.
 * - Code block content is skipped by refusing to descend into `pre`. That one
 *   check covers the block's inner `code` too, and is what keeps
 *   rehype-highlight's per-token spans intact (matching paths there would be
 *   unreliable and would fight the syntax highlighting).
 * - Inline code is NOT skipped: models habitually write produced paths as
 *   `E:/test/5.txt`, so leaving it out would miss the most common case.
 *   Inline code has a single plain-text child, so matching is safe there.
 * - Links (`a`) are skipped so we never nest a path link inside a real link
 *   (a markdown link's URL lives in an attribute, not a text node, anyway).
 */

type HNode = any;

/** Elements we never descend into (see file header). */
const SKIP_TAGS = new Set(["pre", "a", "script", "style"]);

// Windows absolute: C:\dir\file.ext | C:/dir/file.ext
const WIN_ABS = String.raw`[A-Za-z]:[\\/](?:[^\\/:*?"<>|\s]+[\\/])*[^\\/:*?"<>|\s]+`;
// POSIX absolute: /dir/file.ext
const POSIX_ABS = String.raw`/(?:[^\s\\/:*?"<>|]+/)*[^\s\\/:*?"<>|\s]+`;
// Relative (must end in an extension): config.json | src/app.tsx | ./out/a.txt
const RELATIVE = String.raw`\.{0,2}[\\/]?[\w.-]+(?:[\\/][\w.-]+)*\.[A-Za-z0-9]{1,10}`;

// Assertions are built with String.raw on purpose: inside a plain template
// literal `\w` is an invalid escape and silently degrades to `w`, which made
// the lookbehind stop rejecting paths welded onto a word character (so
// `https://example.com/a.txt` wrongly yielded `xample.com/a.txt`).
// `.` is rejected too: it is what separates a domain label from its TLD, so
// without it `https://example.com/docs/a.txt` still yields `com/docs/a.txt`.
const LOOKBEHIND = String.raw`(?<![\w.:/\\-])`;
const LOOKAHEAD = String.raw`(?![\w/\\-])`;

/**
 * The lookbehind rejects paths welded to a preceding word char, `:` or `/` —
 * that is what keeps `https://example.com/a.txt` from yielding `/a.txt`.
 */
const PATH_RE = new RegExp(
  `${LOOKBEHIND}(?:${WIN_ABS}|${POSIX_ABS}|${RELATIVE})${LOOKAHEAD}`,
  "g",
);

/**
 * Custom (non-HTML) tag name. We deliberately avoid `<a href="file:...">`
 * because react-markdown's default urlTransform strips unknown schemes; a
 * custom tag is matched via `components` instead and keeps URL sanitising
 * intact for real links.
 */
export const PATH_LINK_TAG = "file-path";

/** Split a text node into [text, <file-path>, text, ...]; null when no path. */
function splitPaths(value: string): HNode[] | null {
  PATH_RE.lastIndex = 0;
  const out: HNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let found = false;
  while ((m = PATH_RE.exec(value)) !== null) {
    found = true;
    if (m.index > last) {
      out.push({ type: "text", value: value.slice(last, m.index) });
    }
    out.push({
      type: "element",
      tagName: PATH_LINK_TAG,
      properties: { path: m[0] },
      children: [{ type: "text", value: m[0] }],
    });
    last = m.index + m[0].length;
  }
  if (!found) return null;
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

function walk(node: HNode): void {
  if (!node) return;
  if (node.type === "element" && SKIP_TAGS.has(node.tagName)) return;
  const children = node?.children;
  if (!Array.isArray(children)) return;

  let changed = false;
  const next: HNode[] = [];
  for (const child of children) {
    if (child && child.type === "text" && typeof child.value === "string") {
      const parts = splitPaths(child.value);
      if (parts) {
        next.push(...parts);
        changed = true;
        continue;
      }
    }
    next.push(child);
    walk(child);
  }
  if (changed) node.children = next;
}

/**
 * rehype plugin factory. Must run BEFORE rehype-highlight so the code blocks
 * it skips are still in one piece when highlighting walks them.
 */
export function rehypeFilePaths() {
  return (tree: HNode) => walk(tree);
}
