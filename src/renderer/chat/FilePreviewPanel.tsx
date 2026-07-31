import { useEffect, useMemo, useRef, useState } from "react";
import { X, FileText, Eye, Code2, Loader2, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import hljs from "highlight.js";
import { useUIStore } from "../store/ui-store";
import Markdown from "./Markdown";
import type { FilePreviewResult } from "../../preload/api";
import styles from "./FilePreviewPanel.module.css";

/**
 * Count the number of text characters contained within a node (recursively).
 * Used to map a DOM selection offset back onto the original file text.
 */
function textLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0;
  let total = 0;
  node.childNodes.forEach((c) => (total += textLength(c)));
  return total;
}

/**
 * Map a DOM (node, offset) to a character offset within a single row's
 * `<code data-content>` element. Walks Text nodes in document order, since
 * highlight.js only wraps text in `<span>`s without reordering characters.
 */
function localOffsetIn(contentEl: HTMLElement, node: Node, offset: number): number {
  if (node.nodeType === Node.ELEMENT_NODE) {
    // offset is a child index; sum the text length of children before it.
    let count = 0;
    for (let i = 0; i < offset && i < node.childNodes.length; i++) {
      count += textLength(node.childNodes[i]);
    }
    return count;
  }
  const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
  let count = 0;
  let n = walker.nextNode();
  while (n) {
    if (n === node) return count + offset;
    count += n.textContent?.length ?? 0;
    n = walker.nextNode();
  }
  return count;
}

/**
 * Locate which per-line row a DOM position belongs to, and the local character
 * offset within that row's code text. Each row carries `data-line={i}`.
 */
function locateRow(
  root: HTMLElement,
  node: Node,
  offset: number,
): { line: number; local: number } | null {
  let el: HTMLElement | null =
    node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  while (el && el !== root && el.dataset.line === undefined) {
    el = el.parentElement;
  }
  if (!el || el === root || el.dataset.line === undefined) return null;
  const line = parseInt(el.dataset.line, 10);
  const contentEl = el.querySelector("[data-content]") as HTMLElement | null;
  if (!contentEl) return null;
  const local = localOffsetIn(contentEl, node, offset);
  return { line, local };
}

/**
 * Convert a (line, localOffset) pair into a character index in the original
 * file text. Each row's text is `lines[i]` and rows are joined by `\n`, so the
 * file offset before line `i` is `sum(lines[0..i-1].length) + i` (i newlines).
 */
function charIndexOf(lines: string[], line: number, local: number): number {
  let idx = 0;
  for (let i = 0; i < line; i++) idx += lines[i].length + 1;
  return idx + local;
}

/** Map a character index in the file text to a 1-based line number. Counting
 *  scan instead of slice+split: on a ~1MB file the old version allocated a
 *  huge array on EVERY selection. */
function lineOf(content: string, charIndex: number): number {
  let line = 1;
  const stop = Math.min(charIndex, content.length);
  for (let i = 0; i < stop; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}

/** Map a file extension to a highlight.js language id (best effort). */
const EXT_LANG: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", cs: "csharp",
  php: "php", swift: "swift", kt: "kotlin",
  sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell",
  bat: "dos", cmd: "dos",
  css: "css", scss: "scss", less: "less",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml",
  json: "json", jsonc: "json", yml: "yaml", yaml: "yaml", toml: "ini",
  ini: "ini", conf: "ini", env: "ini",
  sql: "sql", md: "markdown", markdown: "markdown",
  txt: "plaintext", log: "plaintext", csv: "plaintext",
};

// Skip token-level highlighting above this size to keep the UI snappy —
// the file still renders as plain text with line numbers.
const HIGHLIGHT_MAX = 300 * 1024;

// ── Code-view virtual scrolling ──
// Every code line is a fixed-height flex row (font-size 12px, line-height 1.6,
// white-space: pre → never wraps), so ROW_HEIGHT is a constant. Files above
// VIRT_THRESHOLD lines only render the visible window + overscan instead of
// thousands of DOM rows (a 1MB file is ~50k rows otherwise).
const ROW_HEIGHT = 12 * 1.6; // keep in sync with .codeRows / .codeRow css
const VIRT_THRESHOLD = 800;
const VIRT_OVERSCAN = 50;

interface ViewWindow {
  start: number;
  end: number;
}

function extOf(path: string): string {
  const base = path.split(/[\\/]/).pop() || "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * File preview panel shown over the chat area when a file is clicked in the
 * sidebar file manager. Text files render with line numbers + syntax
 * highlighting; Markdown defaults to rendered preview with a source toggle;
 * images render inline; binaries / oversized files show a friendly notice.
 */
export default function FilePreviewPanel({ filePath }: { filePath: string }) {
  const { t } = useTranslation();
  const closeFilePreview = useUIStore((s) => s.closeFilePreview);
  const previewWidth = useUIStore((s) => s.previewWidth);
  const setPreviewWidth = useUIStore((s) => s.setPreviewWidth);

  // Drag the divider on the left edge to resize the preview column
  // (same interaction model as the terminal panel).
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = previewWidth;
    const onMove = (ev: MouseEvent) => {
      // Dragging left (startX > ev.clientX) widens the column on the right.
      const next = Math.min(900, Math.max(320, startWidth + (startX - ev.clientX)));
      setPreviewWidth(next);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const [result, setResult] = useState<FilePreviewResult | null>(null);
  const [loading, setLoading] = useState(true);
  // Markdown view mode: rendered preview (default) vs raw source.
  const [mdMode, setMdMode] = useState<"preview" | "source">("preview");
  // Code-view virtual window (only meaningful when the file is virtualized).
  const [viewWin, setViewWin] = useState<ViewWindow>({ start: 0, end: 0 });
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);
  // Floating "Add to chat" button shown above a text selection in the code area.
  // We capture the structured range so the click can hand a CodeAttachment to
  // the composer instead of a plain-text blob.
  const [floatBtn, setFloatBtn] = useState<{
    top: number;
    left: number;
    filePath: string;
    startLine: number;
    endLine: number;
    content: string;
  } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Latest values for the document-level selection handler (avoids rebinding).
  // `content` is assigned further below (after `textContent` is computed), so we
  // initialise with an empty placeholder here and refresh it once per render.
  const latest = useRef<{ filePath: string; content: string }>({
    filePath,
    content: "",
  });

  const fileName = filePath.split(/[\\/]/).pop() || filePath;
  const ext = extOf(filePath);
  const isMarkdown = ext === "md" || ext === "markdown";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setResult(null);
    setMdMode("preview");
    setFloatBtn(null);
    // New file → reset the code-view scroll + virtual window.
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    setViewWin({ start: 0, end: 0 });
    window.piDesk
      .readFileForPreview(filePath)
      .then((res) => {
        if (!cancelled) setResult(res);
      })
      .catch((err) => {
        if (!cancelled) setResult({ kind: "error", error: String(err) });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  useEffect(() => {
    // Cancel any pending virtual-window rAF on unmount.
    return () => {
      if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

  // Show a floating "Add to chat" button whenever the user selects text inside
  // the code area. The selection's character range is mapped back to line
  // numbers in the original file so the injected reference reads `path:line`
  // (or `path:start-end`).
  //
  // We deliberately do NOT listen to `selectionchange` to clear the button:
  // pressing the button collapses the native selection, which would fire
  // `selectionchange`, unmount the button, and swallow the click before
  // `onClick` ever runs. Instead we keep the captured text (set on mouseup) and
  // only dismiss the button on an explicit mousedown outside the button, or on
  // scroll / file change.
  useEffect(() => {
    const onMouseUp = (e: MouseEvent) => {
      // Clicking the button itself triggers a mouseup too — leave the button
      // mounted so its onClick can fire (it uses the captured text).
      if (buttonRef.current && buttonRef.current.contains(e.target as Node)) return;
      const sel = window.getSelection();
      const codeEl = codeRef.current;
      const panelEl = panelRef.current;
      if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !codeEl || !panelEl) {
        setFloatBtn(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!codeEl.contains(range.startContainer) || !codeEl.contains(range.endContainer)) {
        setFloatBtn(null);
        return;
      }
      const startLoc = locateRow(codeEl, range.startContainer, range.startOffset);
      const endLoc = locateRow(codeEl, range.endContainer, range.endOffset);
      if (!startLoc || !endLoc) {
        setFloatBtn(null);
        return;
      }
      const lines = latest.current.content.split("\n");
      const startIdx = charIndexOf(lines, startLoc.line, startLoc.local);
      const endIdx = charIndexOf(lines, endLoc.line, endLoc.local);
      const start = Math.min(startIdx, endIdx);
      const end = Math.max(startIdx, endIdx);
      if (start === end) {
        setFloatBtn(null);
        return;
      }
      const content = latest.current.content;
      const fp = latest.current.filePath;
      const startLine = lineOf(content, start);
      const endLine = lineOf(content, end);
      const selected = content.slice(start, end);
      const rect = range.getBoundingClientRect();
      const panelRect = panelEl.getBoundingClientRect();
      // Clamp the top so the button never hides under the header / outside the
      // (overflow:hidden) panel when the selection sits near the top edge.
      const top = Math.max(rect.top - panelRect.top, 44);
      setFloatBtn({
        top,
        left: rect.left - panelRect.left + rect.width / 2,
        filePath: fp,
        startLine,
        endLine,
        content: selected,
      });
    };
    // Dismiss the button when the user presses down anywhere other than the
    // button itself (e.g. starting a fresh selection in the code, or clicking
    // elsewhere). The next mouseup re-shows it if a valid selection exists.
    const onMouseDown = (e: MouseEvent) => {
      if (buttonRef.current && buttonRef.current.contains(e.target as Node)) return;
      setFloatBtn(null);
    };
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, []);

  const textContent = result?.kind === "text" ? result.content : "";
  // Keep the latest file path + text available to the document-level selection
  // listener without rebinding it on every render. Updated in an effect to
  // avoid accessing/mutating a ref during render.
  useEffect(() => {
    latest.current = { filePath, content: textContent };
  }, [filePath, textContent]);
  // Split once per file (NOT per render) — `split` on a ~1MB string is O(n)
  // and the old code re-ran it on every keystroke/render of the panel.
  const lines = useMemo(
    () => (textContent ? textContent.split("\n") : []),
    [textContent]
  );

  /** Recompute the visible line window for the virtualized code view. Called
   *  from a rAF-throttled scroll handler and once after a file loads. */
  const updateViewWindow = () => {
    const el = bodyRef.current;
    if (!el) return;
    const start = Math.max(0, Math.floor(el.scrollTop / ROW_HEIGHT) - VIRT_OVERSCAN);
    const end = Math.min(
      lines.length,
      Math.ceil((el.scrollTop + el.clientHeight) / ROW_HEIGHT) + VIRT_OVERSCAN
    );
    setViewWin((prev) =>
      prev.start === start && prev.end === end ? prev : { start, end }
    );
  };

  // After a file loads, initialize the virtual window once the rows are in the
  // DOM (clientHeight is only measurable post-commit).
  useEffect(() => {
    if (!textContent) return;
    const raf = requestAnimationFrame(updateViewWindow);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textContent]);

  // Highlight once per file; split into lines for the numbered gutter.
  // hljs can emit spans that cross line boundaries when split naively, so we
  // highlight the whole text and render it as ONE <code> block, with a
  // separate gutter column that shares the same line-height/font metrics.
  const highlighted = useMemo(() => {
    if (!textContent) return { html: "", lines: 0 };
    const lines = textContent.split("\n").length;
    if (textContent.length > HIGHLIGHT_MAX) {
      return { html: "", lines };
    }
    const lang = EXT_LANG[ext];
    try {
      if (lang && hljs.getLanguage(lang)) {
        return { html: hljs.highlight(textContent, { language: lang }).value, lines };
      }
    } catch {
      /* fall through to plain text */
    }
    return { html: "", lines };
  }, [textContent, ext]);

  const renderBody = () => {
    if (loading) {
      return (
        <div className={styles.notice}>
          <Loader2 size={16} className={styles.spinner} />
          <span>{t("files.loading")}</span>
        </div>
      );
    }
    if (!result) return null;

    switch (result.kind) {
      case "image":
        return (
          <div className={styles.imageWrap}>
            <img
              className={styles.image}
              src={`data:${result.mime};base64,${result.base64}`}
              alt={fileName}
            />
          </div>
        );
      case "binary":
        return (
          <div className={styles.notice}>
            {t("files.binary")} ({formatSize(result.size)})
          </div>
        );
      case "too-large":
        return (
          <div className={styles.notice}>
            {t("files.tooLarge", {
              size: formatSize(result.size),
              limit: formatSize(result.limit),
            })}
          </div>
        );
      case "error":
        return <div className={styles.noticeError}>{result.error}</div>;
      case "text": {
        if (isMarkdown && mdMode === "preview") {
          return (
            <div className={styles.mdPreview}>
              <Markdown content={result.content} />
            </div>
          );
        }
        // Per-line rendering: each file line is a flex row [lineNo | code line].
        // Putting the line number and code in the SAME row box makes vertical
        // alignment structural — they live in the same flex item, so they
        // cannot drift. The whole-text hljs run is split on '\n' so spans that
        // cross line boundaries keep the opening/closing tags on each half.
        const htmlLines = highlighted.html ? highlighted.html.split("\n") : null;
        const isVirtual = lines.length > VIRT_THRESHOLD;

        if (isVirtual) {
          // Large file: render only the visible window (absolute-positioned
          // inside a full-height spacer) so the DOM stays at ~100 rows instead
          // of thousands. Rows keep their REAL line number in data-line, so
          // selection→line mapping (locateRow / charIndexOf) keeps working.
          const { start, end } = viewWin;
          return (
            <div className={styles.codeRows} ref={codeRef}>
              <div style={{ height: lines.length * ROW_HEIGHT, position: "relative" }}>
                {lines.slice(start, end).map((line, i) => {
                  const idx = start + i;
                  return (
                    <div
                      key={idx}
                      className={styles.codeRow}
                      data-line={idx}
                      style={{
                        position: "absolute",
                        top: idx * ROW_HEIGHT,
                        left: 0,
                        right: 0,
                      }}
                    >
                      <div className={styles.lineNo}>{idx + 1}</div>
                      {htmlLines ? (
                        <code
                          data-content
                          className="hljs"
                           
                          dangerouslySetInnerHTML={{ __html: htmlLines[idx] || "" }}
                        />
                      ) : (
                        <code data-content className="hljs">
                          {line}
                        </code>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        }

        return (
          <div className={styles.codeRows} ref={codeRef}>
            {lines.map((line, i) => (
              <div key={i} className={styles.codeRow} data-line={i}>
                <div className={styles.lineNo}>{i + 1}</div>
                {htmlLines ? (
                  <code
                    data-content
                    className="hljs"
                     
                    dangerouslySetInnerHTML={{ __html: htmlLines[i] || "" }}
                  />
                ) : (
                  <code data-content className="hljs">
                    {line}
                  </code>
                )}
              </div>
            ))}
          </div>
        );
      }
      default:
        return null;
    }
  };

  return (
    <div className={styles.panel} style={{ width: previewWidth }} ref={panelRef}>
      <div
        className={styles.resizeHandle}
        onMouseDown={startResize}
        title={t("terminal.resize")}
      />
      <div className={styles.header}>
        <FileText size={14} className={styles.headerIcon} />
        <span className={styles.fileName} title={filePath}>
          {fileName}
        </span>
        {result?.kind === "text" && (
          <span className={styles.fileMeta}>{formatSize(result.size)}</span>
        )}
        <span className={styles.headerSpacer} />
        {isMarkdown && result?.kind === "text" && (
          <div className={styles.mdToggle}>
            <button
              className={`${styles.mdToggleBtn} ${mdMode === "preview" ? styles.mdToggleActive : ""}`}
              onClick={() => setMdMode("preview")}
              title={t("files.mdPreview")}
            >
              <Eye size={12} />
              <span>{t("files.mdPreview")}</span>
            </button>
            <button
              className={`${styles.mdToggleBtn} ${mdMode === "source" ? styles.mdToggleActive : ""}`}
              onClick={() => setMdMode("source")}
              title={t("files.mdSource")}
            >
              <Code2 size={12} />
              <span>{t("files.mdSource")}</span>
            </button>
          </div>
        )}
        <button
          className={styles.closeBtn}
          onClick={closeFilePreview}
          title={t("files.close")}
        >
          <X size={14} />
        </button>
      </div>
      <div className={styles.pathBar} title={filePath}>
        {filePath}
      </div>
      <div
        className={styles.body}
        ref={bodyRef}
        onScroll={() => {
          setFloatBtn(null);
          // rAF-throttled: scroll fires faster than frames; the window only
          // needs recomputing once per frame.
          if (scrollRafRef.current == null) {
            scrollRafRef.current = requestAnimationFrame(() => {
              scrollRafRef.current = null;
              updateViewWindow();
            });
          }
        }}
      >
        {renderBody()}
      </div>
      {floatBtn && (
        <button
          ref={buttonRef}
          className={styles.addToChatBtn}
          style={{ top: floatBtn.top, left: floatBtn.left }}
          // Keep the text selection alive while clicking the button.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            useUIStore.getState().addCodeAttachment({
              filePath: floatBtn.filePath,
              startLine: floatBtn.startLine,
              endLine: floatBtn.endLine,
              content: floatBtn.content,
            });
            setFloatBtn(null);
            window.getSelection()?.removeAllRanges();
          }}
          title={t("files.addToChat")}
        >
          <Plus size={12} />
          <span>{t("files.addToChat")}</span>
        </button>
      )}
    </div>
  );
}
