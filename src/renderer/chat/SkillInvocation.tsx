import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronRight, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import styles from "./SkillInvocation.module.css";

interface Props {
  name: string;
  /** The skill's SKILL.md body (frontmatter already stripped by the SDK). */
  body: string;
  /** The user's actual request, typed after "/skill:name". Empty if none. */
  args: string;
}

/**
 * Renders a `/skill:name` invocation the way PI's interactive TUI does: a compact
 * collapsible "[skill] name" block instead of dumping the entire SKILL.md into
 * the chat. The skill content is still in the message (sent to the model as the
 * skill's instructions) — it's just hidden behind a toggle.
 */
export default function SkillInvocation({ name, body, args }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={styles.head}
        onClick={() => setExpanded((e) => !e)}
        title={expanded ? t("skillInvoke.collapse") : t("skillInvoke.expand")}
      >
        <ChevronRight
          size={12}
          className={`${styles.chevron} ${expanded ? styles.chevronOpen : ""}`}
        />
        <Sparkles size={12} className={styles.icon} />
        <span className={styles.label}>[skill] {name}</span>
        <span className={styles.hint}>
          {expanded ? t("skillInvoke.collapse") : t("skillInvoke.expand")}
        </span>
      </button>

      {expanded && (
        <div className={styles.body}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
        </div>
      )}

      {args.trim() && <div className={styles.args}>{args.trim()}</div>}
    </div>
  );
}
