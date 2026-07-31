import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Options as MarkdownOptions } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import mermaid from "mermaid";
import { Copy, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import styles from "./Markdown.module.css";

/**
 * Shared markdown renderer for both assistant and user messages.
 * - GFM markdown (headings, lists, tables, quotes, links, code blocks)
 * - Fenced code blocks get a language label + copy button, with token-level
 *   syntax highlighting via rehype-highlight (highlight.js `github` theme).
 * - ```mermaid code blocks render as real diagrams via mermaid.
 */

let mermaidReady = false;
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
    // debounce: avoid thrashing mermaid.render on every streamed token
    const timer = window.setTimeout(() => {
      const id = `mmd-${Math.random().toString(36).slice(2)}`;
      mermaid
        .render(id, chart)
        .then(({ svg }) => {
          if (!cancelled && ref.current) ref.current.innerHTML = svg;
        })
        .catch(() => {
          if (!cancelled) setError(true);
        });
    }, 200);
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

function Markdown({ content }: { content: string }) {
  return (
    <div className={styles.markdown}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={MD_COMPONENTS}
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

  const raw = String(children ?? "").replace(/\n$/, "");
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
    navigator.clipboard
      ?.writeText(raw)
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
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}
