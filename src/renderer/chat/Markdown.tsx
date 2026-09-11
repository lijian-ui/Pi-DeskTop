import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Options as MarkdownOptions } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import mermaid from "mermaid";
import { Copy, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUIStore } from "../store/ui-store";
import { useSessionStore } from "../store/session-store";
import { resolveAgainstCwd } from "../utils/path-utils";
import { rehypeFilePaths, PATH_LINK_TAG } from "./rehype-file-paths";
import styles from "./Markdown.module.css";

/**
 * Shared markdown renderer for both assistant and user messages.
 * - GFM markdown (headings, lists, tables, quotes, links, code blocks)
 * - Fenced code blocks get a language label + copy button, with token-level
 *   syntax highlighting via rehype-highlight (highlight.js `github` theme).
 * - ```mermaid code blocks render as real diagrams via mermaid.
 */

let mermaidReady = false;
let mermaidIdCounter = 0;
function ensureMermaid() {
  if (!mermaidReady) {
    mermaid.initialize({ startOnLoad: false, theme: "default" });
    mermaidReady = true;
  }
}

function Mermaid({ chart }: { chart: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    ensureMermaid();
    setError(false);
    let cancelled = false;
    // debounce: avoid thrashing mermaid.render on every streamed token.
    // 500ms is long enough to skip most mid-token renders while still
    // feeling responsive once the diagram stabilises.
    const timer = window.setTimeout(() => {
      const id = `mmd-${++mermaidIdCounter}`;
      mermaid
        .render(id, chart)
        .then(({ svg }) => {
          if (!cancelled && ref.current) ref.current.innerHTML = svg;
        })
        .catch(() => {
          if (!cancelled) setError(true);
        });
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [chart]);

  // invalid diagram syntax → fall back to a plain code block
  if (error) {
    return (
      <pre className={styles.codePre}>
        <code>{chart}</code>
      </pre>
    );
  }
  return <div className={styles.mermaid} ref={ref} />;
}

/**
 * Module-level constants for ReactMarkdown's plugins/components. Keeping these
 * references stable is what makes `memo(Markdown)` effective — if they were
 * re-created per render, the shallow prop comparison would always fail and
 * ReactMarkdown would re-run its whole remark/rehype pipeline on every
 * streamed token (the #1 rendering cost in long conversations).
 */
const REMARK_PLUGINS: MarkdownOptions["remarkPlugins"] = [remarkGfm];
const REHYPE_PLUGINS: MarkdownOptions["rehypePlugins"] = [
  [rehypeHighlight, { ignoreMissing: true }],
];
function InlinePre({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}
const MD_COMPONENTS: MarkdownOptions["components"] = {
  pre: InlinePre,
  code: CodeBlock,
};

// Path-link variants. Both stay module-level constants (see the note above)
// so `memo(Markdown)` still works: switching between them is a cheap boolean
// toggle, not a new plugin array on every render.
const REHYPE_PLUGINS_PATHS: MarkdownOptions["rehypePlugins"] = [
  rehypeFilePaths,
  [rehypeHighlight, { ignoreMissing: true }],
];
// The cast is needed because `Components` only knows real HTML tag names —
// `file-path` is our own marker element produced by rehype-file-paths.
const MD_COMPONENTS_PATHS = {
  pre: InlinePre,
  code: CodeBlock,
  [PATH_LINK_TAG]: FilePathLink,
} as MarkdownOptions["components"];

/**
 * A filesystem path mentioned in prose. Renders as plain text until the main
 * process confirms the file really exists (stat), then becomes a button that
 * opens the preview panel. Unverified paths stay text — never a dead link.
 */
function FilePathLink({ path }: { path?: string }) {
  const { t } = useTranslation();
  const openFilePreview = useUIStore((s) => s.openFilePreview);
  const cwd = useSessionStore((s) => s.currentCwd);
  const raw = typeof path === "string" ? path : "";
  const abs = raw ? resolveAgainstCwd(raw, cwd) : "";
  const [exists, setExists] = useState<boolean | null>(null);

  useEffect(() => {
    if (!abs) return;
    let cancelled = false;
    window.piDesk
      .statFile(abs)
      .then((s) => {
        if (!cancelled) setExists(s != null);
      })
      .catch(() => {
        if (!cancelled) setExists(false);
      });
    return () => {
      cancelled = true;
    };
  }, [abs]);

  if (!raw) return null;
  if (exists !== true) return <>{raw}</>;

  return (
    <button
      type="button"
      className={styles.pathLink}
      onClick={() => openFilePreview(abs)}
      title={t("files.previewFile", { file: raw })}
    >
      {raw}
    </button>
  );
}

function Markdown({
  content,
  linkifyPaths = false,
}: {
  content: string;
  /**
   * Turn filesystem paths into clickable preview links. Disabled while a
   * reply is streaming: every streamed token re-runs the markdown pipeline,
   * which would fire a stat() per candidate path per token.
   */
  linkifyPaths?: boolean;
}) {
  return (
    <div className={styles.markdown}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={linkifyPaths ? REHYPE_PLUGINS_PATHS : REHYPE_PLUGINS}
        components={linkifyPaths ? MD_COMPONENTS_PATHS : MD_COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export default memo(Markdown);

function CodeBlock(props: any) {
  const { t } = useTranslation();
  const { className, children } = props;
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLElement>(null);

  const raw = (children ?? "")
    .toString()
    .replace(/^\n+|\n+$/g, "");
  const match = /language-(\w+)/.exec(className || "");
  const isBlock = !!match || raw.includes("\n");

  if (!isBlock) {
    return <code className={styles.inlineCode}>{children}</code>;
  }

  const lang = match ? match[1] : "text";
  // diagrams are rendered as SVG, not as a code block
  if (lang === "mermaid") {
    return <Mermaid chart={raw} />;
  }

  const copy = () => {
    // Extract text from the rendered code element (rehype-highlight may
    // wrap tokens in <span> so React children are not plain strings).
    const node = codeRef.current;
    const text = node ? node.textContent ?? "" : raw;
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHead}>
        <span className={styles.codeLang}>{lang}</span>
        <button
          type="button"
          className={styles.codeCopy}
          onClick={copy}
          title={t("chat.copy")}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? t("chat.copied") : t("chat.copy")}</span>
        </button>
      </div>
      <pre className={styles.codePre}>
        <code ref={codeRef} className={className}>
          {children}
        </code>
      </pre>
    </div>
  );
}
