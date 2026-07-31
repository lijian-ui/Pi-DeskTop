import { memo, useState, useEffect } from "react";
import { ChevronDown, ChevronRight, Brain, Copy, Check } from "lucide-react";
import type { Message } from "../store/agent-store";
import Markdown from "./Markdown";
import ToolExecution from "./ToolExecution";
import { useTranslation } from "react-i18next";
import styles from "./AssistantMessage.module.css";

interface Props {
  message: Message;
  highlight?: boolean;
}

function AssistantMessage({ message, highlight }: Props) {
  const { t } = useTranslation();
  // Streaming: auto-expand thinking; once finished, collapse it.
  const [thinkingExpanded, setThinkingExpanded] = useState(!!message.isStreaming);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!message.isStreaming) setThinkingExpanded(false);
  }, [message.isStreaming]);

  const copy = () => {
    navigator.clipboard
      ?.writeText(message.content)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div
      id={`msg-${message.id}`}
      className={`${styles.assistantMessage} ${highlight ? styles.highlight : ""}`}
    >
      <div className={styles.avatarRow}>
        <div className={styles.avatar}>Pi</div>
        {message.isStreaming && !message.content.trim() && !message.thinking?.trim() && (
          <span className={styles.typing} role="status" aria-label={t("chat.requesting")}>
            <span className={styles.typingText}>{t("chat.requesting")}</span>
            <span className={styles.typingDots}>
              <span></span>
              <span></span>
              <span></span>
            </span>
          </span>
        )}
      </div>
      <div className={styles.body}>
        {message.thinking && (
          <div
            className={styles.thinkingBlock}
            onClick={() => setThinkingExpanded((e) => !e)}
          >
            <div className={styles.thinkingHeader}>
              <Brain size={12} />
              <span>{t("chat.thinking")}</span>
              {thinkingExpanded ? (
                <ChevronDown size={12} />
              ) : (
                <ChevronRight size={12} />
              )}
            </div>
            {thinkingExpanded && (
              <div className={styles.thinkingContent}>{message.thinking}</div>
            )}
          </div>
        )}
        <div className={styles.content}>
          <Markdown content={message.content} />
        </div>
        {message.toolExecutions?.map((tool) => (
          <ToolExecution key={tool.id} execution={tool} />
        ))}
        {/* Only show time / copy / stopped-badge on messages that have
            actual text content. Intermediate assistant messages that only
            contain tool calls (e.g. bash, file read) are scaffolding — they
            should not look like a "final reply". */}
        {message.content.trim() && (
          <div className={styles.meta}>
            <span className={styles.time}>{time}</span>
            {message.stoppedByUser && (
              <span className={styles.stoppedBadge}>{t("chat.stoppedByUser")}</span>
            )}
            <button
              className={styles.copyBtn}
              onClick={copy}
              title={t("chat.copy")}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              <span className={styles.copyLabel}>
                {copied ? t("chat.copied") : t("chat.copy")}
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Only re-render when a field this component actually renders changes. During
 * streaming, `reduceMessageEvent` rebuilds the message array on every token but
 * leaves the unchanged messages' content/thinking/toolExecutions references
 * intact — this comparator lets `memo` skip every message except the one that
 * is actively streaming (plus tool-call updates and search highlight changes).
 */
function areEqual(prev: Props, next: Props): boolean {
  const a = prev.message;
  const b = next.message;
  return (
    a.content === b.content &&
    a.thinking === b.thinking &&
    a.isStreaming === b.isStreaming &&
    a.stoppedByUser === b.stoppedByUser &&
    a.timestamp === b.timestamp &&
    a.toolExecutions === b.toolExecutions &&
    prev.highlight === next.highlight
  );
}

export default memo(AssistantMessage, areEqual);
