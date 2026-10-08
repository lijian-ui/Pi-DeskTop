import { memo, useState } from "react";
import type { Message } from "../store/agent-store";
import type { CodeAttachment } from "../store/ui-store";
import SkillInvocation from "./SkillInvocation";
import Markdown from "./Markdown";
import { Code2, SquareTerminal, ChevronRight, Copy, Check, ListChecks } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toDataUrl } from "../utils/image";
import styles from "./UserMessage.module.css";

/** Map a file path to a (best-effort) highlight.js language id for the fence. */
function langOf(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() || "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

/** Readable file label: basename, middle-truncated if very long. */
function labelOf(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() || filePath;
  if (base.length <= 30) return base;
  return base.slice(0, 18) + "…" + base.slice(-10);
}

/** One code/terminal-reference card inside a user message bubble. */
function RefCard({ att }: { att: CodeAttachment }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const isTerminal = att.kind === "terminal";
  const lang = isTerminal ? "text" : langOf(att.filePath);
  const lr = isTerminal
    ? t("terminal.lineCount", { count: att.endLine })
    : att.startLine === att.endLine
      ? `${att.startLine}`
      : `${att.startLine}-${att.endLine}`;
  return (
    <div className={styles.refCard}>
      <div
        className={styles.refCardHeader}
        onClick={() => setExpanded((v) => !v)}
        role="button"
        aria-expanded={expanded}
      >
        {isTerminal ? (
          <SquareTerminal size={13} className={styles.refCardIcon} />
        ) : (
          <Code2 size={13} className={styles.refCardIcon} />
        )}
        <span
          className={styles.refCardName}
          title={isTerminal ? t("terminal.outputRef") : att.filePath}
        >
          {isTerminal ? t("terminal.outputRef") : labelOf(att.filePath)}
        </span>
        <span className={styles.refCardLines}>{lr}</span>
        <ChevronRight
          size={13}
          className={`${styles.refCardChevron} ${expanded ? styles.refCardChevronOpen : ""}`}
        />
      </div>
      {expanded && (
        <div className={styles.refCardBody}>
          <Markdown content={`\`\`\`${lang}\n${att.content}\n\`\`\``} />
        </div>
      )}
    </div>
  );
}

/**
 * 「任务详情」展开卡：定时任务的触发消息只是扣扳机，真正的任务提示词在系统
 * 提示词里、聊天看不到。这里把该任务的 prompt 折叠在气泡下方，按需展开。
 */
function TaskDetailsCard({ prompt }: { prompt: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const body = prompt.trim();
  const copy = () => {
    navigator.clipboard
      ?.writeText(prompt)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };
  return (
    <div className={styles.taskCard}>
      <div
        className={styles.taskCardHeader}
        onClick={() => setExpanded((v) => !v)}
        role="button"
        aria-expanded={expanded}
      >
        <ListChecks size={13} className={styles.taskCardIcon} />
        <span className={styles.taskCardTitle}>{t("chat.taskDetails")}</span>
        <ChevronRight
          size={13}
          className={`${styles.taskCardChevron} ${expanded ? styles.taskCardChevronOpen : ""}`}
        />
      </div>
      {expanded && (
        <div className={styles.taskCardBody}>
          {body ? (
            <Markdown content={prompt} linkifyPaths breaks />
          ) : (
            <span className={styles.taskCardEmpty}>{t("chat.taskDetailsEmpty")}</span>
          )}
          {body && (
            <button
              type="button"
              className={styles.taskCardCopy}
              onClick={copy}
              title={t("chat.copy")}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              <span className={styles.copyLabel}>
                {copied ? t("chat.copied") : t("chat.copy")}
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface ParsedSkill {
  name: string;
  location: string;
  body: string;
  args: string;
}

/**
 * Parse a `<skill name="…" location="…">…</skill>` block (PI's skill-command
 * expansion format) out of a user message. Returns null for normal messages.
 */
function parseSkillBlock(text: string): ParsedSkill | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("<skill")) return null;
  const m = trimmed.match(
    /<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?/
  );
  if (!m) return null;
  return {
    name: m[1],
    location: m[2],
    body: m[3],
    args: m[4] ?? "",
  };
}

interface Props {
  message: Message;
  highlight?: boolean;
  /**
   * 定时任务触发消息的「任务详情」提示词。由 MessageList 解析出对应任务后传入；
   * 普通消息不传 → 不渲染展开卡。
   */
  taskPrompt?: string;
}

function UserMessage({ message, highlight, taskPrompt }: Props) {
  const { t } = useTranslation();
  const parsed = parseSkillBlock(message.content);
  const attachments = message.attachments;
  const images = message.images;
  // Full-size preview overlay for a clicked thumbnail (null = closed).
  const [zoomed, setZoomed] = useState<string | null>(null);
  // 气泡下方 meta：发送时间 + 一键复制已发送内容
  const [copied, setCopied] = useState(false);
  const time = message.timestamp
    ? new Date(message.timestamp).toLocaleString([], {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "";
  // 技能消息（渲染为 SkillInvocation 卡片）与纯图片消息没有可复制的正文。
  const canCopy = !parsed && !!message.content.trim();
  const copy = () => {
    navigator.clipboard
      ?.writeText(message.content)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <div
      id={`msg-${message.id}`}
      className={`${styles.userMessage} ${highlight ? styles.highlight : ""}`}
    >
        <div className={styles.bubbleWrap}>
        <div className={styles.bubble}>
          {parsed ? (
            <SkillInvocation
              name={parsed.name}
              body={parsed.body}
              args={parsed.args}
            />
          ) : (
            <>
              {attachments && attachments.length > 0 && (
                <div className={styles.refList}>
                  {attachments.map((a) => (
                    <RefCard key={a.id} att={a} />
                  ))}
                </div>
              )}
              {images && images.length > 0 && (
                <div className={styles.imageList}>
                  {images.map((img) => {
                    const url = toDataUrl(img.mimeType, img.data);
                    return (
                      <img
                        key={img.id}
                        className={styles.messageImage}
                        src={url}
                        alt={img.name ?? t("chat.image")}
                        title={img.name ?? t("chat.image")}
                        onClick={() => setZoomed(url)}
                      />
                    );
                  })}
                </div>
              )}
              {message.content.trim() && (
                <Markdown content={message.content} linkifyPaths breaks />
              )}
            </>
          )}
        </div>
        {/* 定时任务触发消息：气泡下方挂一个可展开的「任务详情」（真正的任务提示词） */}
        {taskPrompt !== undefined && <TaskDetailsCard prompt={taskPrompt} />}
        {/* 发送时间 + 一键复制（气泡右下方） */}
        <div className={styles.meta}>
          <span className={styles.time}>{time}</span>
          {canCopy && (
            <button
              type="button"
              className={styles.copyBtn}
              onClick={copy}
              title={t("chat.copy")}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              <span className={styles.copyLabel}>
                {copied ? t("chat.copied") : t("chat.copy")}
              </span>
            </button>
          )}
        </div>
      </div>
      {zoomed && (
        <div className={styles.lightbox} onClick={() => setZoomed(null)}>
          <img src={zoomed} alt={t("chat.image")} />
        </div>
      )}
    </div>
  );
}

/**
 * User messages never change during an assistant's streaming reply, so skip
 * re-render entirely unless the content, attachments or search highlight
 * actually changed.
 */
function areEqual(prev: Props, next: Props): boolean {
  const a = prev.message;
  const b = next.message;
  return (
    a.content === b.content &&
    a.attachments === b.attachments &&
    a.images === b.images &&
    a.timestamp === b.timestamp &&
    prev.highlight === next.highlight &&
    prev.taskPrompt === next.taskPrompt
  );
}

export default memo(UserMessage, areEqual);
