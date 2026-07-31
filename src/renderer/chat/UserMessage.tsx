import { memo } from "react";
import type { Message } from "../store/agent-store";
import type { CodeAttachment } from "../store/ui-store";
import SkillInvocation from "./SkillInvocation";
import Markdown from "./Markdown";
import { Code2, SquareTerminal } from "lucide-react";
import { useTranslation } from "react-i18next";
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
  const isTerminal = att.kind === "terminal";
  const lang = isTerminal ? "text" : langOf(att.filePath);
  const lr = isTerminal
    ? t("terminal.lineCount", { count: att.endLine })
    : att.startLine === att.endLine
      ? `${att.startLine}`
      : `${att.startLine}-${att.endLine}`;
  return (
    <div className={styles.refCard}>
      <div className={styles.refCardHeader}>
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
      </div>
      <div className={styles.refCardBody}>
        <Markdown content={`\`\`\`${lang}\n${att.content}\n\`\`\``} />
      </div>
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
}

function UserMessage({ message, highlight }: Props) {
  const parsed = parseSkillBlock(message.content);
  const attachments = message.attachments;

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
              {message.content.trim() && <Markdown content={message.content} />}
            </>
          )}
        </div>
      </div>
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
    a.timestamp === b.timestamp &&
    prev.highlight === next.highlight
  );
}

export default memo(UserMessage, areEqual);
