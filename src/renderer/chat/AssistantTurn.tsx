import { memo, useState } from "react";
import { Copy, Check } from "lucide-react";
import type { Message } from "../store/agent-store";
import { useTranslation } from "react-i18next";
import Markdown from "./Markdown";
import ThinkingTools from "./ThinkingTools";
import styles from "./AssistantTurn.module.css";

interface Props {
  /** 同一回合的全部 assistant 消息（中间过程 + 最终回复）。 */
  messages: Message[];
  highlight?: boolean;
}

/**
 * 单个 LLM 回合的气泡：
 *
 *  - 始终只显示**一个** Pi 头像；
 *  - 思考过程 / 工具调用 / 中间回复内容折叠在「思考与工具」面板内
 *    （流式时自动展开、完成时自动折叠）；
 *  - 最终回复正文始终独立显示在面板下方。
 *
 * 这样流式和完成态都只有一个 Pi 图标，中间过程不再拆成多个气泡。
 */
function AssistantTurn({ messages, highlight }: Props) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  // 最终回复 = 有正文内容（content 非空）的最后一条 assistant 消息；
  // 如果都在流式中还没有正文，则取最后一条消息（用于显示打字指示）。
  let finalIdx = messages.length - 1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].content?.trim()) {
      finalIdx = i;
      break;
    }
  }
  const finalMsg = messages[finalIdx];
  const finalContent = finalMsg?.content ?? "";

  // 面板消息：所有消息都展示思考/工具/中间内容；最终回复消息的 content
  // 置空，避免与下方独立渲染的正文重复。
  const panelMessages: Message[] = messages.map((m, i) =>
    i === finalIdx && m.content?.trim() ? { ...m, content: "" } : m
  );

  const isStreaming = messages.some((m) => m.isStreaming);
  const hasTemporalContent = messages.some(
    (m) => !!m.thinking?.trim() || m.toolExecutions?.length
  );

  const copy = () => {
    navigator.clipboard
      ?.writeText(finalContent)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  const time = finalMsg?.timestamp
    ? new Date(finalMsg.timestamp).toLocaleString([], {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "";

  return (
    <div
      id={`msg-${messages[0]?.id}`}
      className={`${styles.assistantTurn} ${highlight ? styles.highlight : ""}`}
    >
      <div className={styles.avatarRow}>
        <div className={styles.avatar}>Pi</div>
        {isStreaming && !finalContent.trim() && !hasTemporalContent && (
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
        {/* 思考 / 工具 / 中间回复：聚合折叠面板（流式展开、完成折叠） */}
        <ThinkingTools messages={panelMessages} />
        {/* 最终回复正文：始终独立展示 */}
        {finalContent.trim() && (
          <div id={`msg-${finalMsg.id}`} className={styles.content}>
            <Markdown content={finalContent} />
          </div>
        )}
        {finalContent.trim() && (
          <div className={styles.meta}>
            <span className={styles.time}>{time}</span>
            {finalMsg?.stoppedByUser && (
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
 * Only re-render when fields this component renders change. The messages array
 * is rebuilt on every stream token, so we compare by content/thinking/
 * toolExecutions references + isStreaming to skip identical turns.
 */
function areEqual(prev: Props, next: Props): boolean {
  const a = prev.messages;
  const b = next.messages;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.content !== y.content ||
      x.thinking !== y.thinking ||
      x.isStreaming !== y.isStreaming ||
      x.timestamp !== y.timestamp ||
      x.toolExecutions !== y.toolExecutions ||
      x.id !== y.id
    ) {
      return false;
    }
  }
  return prev.highlight === next.highlight;
}

export default memo(AssistantTurn, areEqual);