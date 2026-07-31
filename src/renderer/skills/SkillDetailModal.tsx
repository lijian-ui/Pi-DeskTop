import { useEffect, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSkillStore } from "../store/skill-store";
import styles from "./SkillDetailModal.module.css";

const SOURCE_KEY: Record<string, string> = {
  user: "skills.source.user",
  project: "skills.source.project",
  path: "skills.source.path",
};

interface Frontmatter {
  [key: string]: string;
}

function parseFrontmatter(raw: string): { fm: Frontmatter; body: string } {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/.exec(raw);
  if (!match) return { fm: {}, body: raw };
  const fmBlock = match[1];
  const body = raw.slice(match[0].length);
  const fm: Frontmatter = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (k) fm[k] = v;
    }
  }
  return { fm, body };
}

export default function SkillDetailModal() {
  const { t } = useTranslation();
  const viewing = useSkillStore((s) => s.viewing);
  const closeSkill = useSkillStore((s) => s.closeSkill);

  useEffect(() => {
    if (!viewing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSkill();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewing, closeSkill]);

  const { fm, body } = useMemo(
    () => (viewing ? parseFrontmatter(viewing.content) : { fm: {}, body: "" }),
    [viewing]
  );

  if (!viewing) return null;
  const { info } = viewing;

  return (
    <div className={styles.overlay} onClick={closeSkill}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <header className={styles.header}>
          <div className={styles.titleBlock}>
            <span className={styles.itemName}>/skill:{info.name}</span>
            <span className={`${styles.badge} ${styles[`badge_${info.source}`] ?? ""}`}>
              {t(SOURCE_KEY[info.source] ?? "skills.source.path")}
            </span>
            {info.disableModelInvocation && (
              <span className={`${styles.badge} ${styles.badgeModelOnly}`}>
                {t("skills.modelOnly")}
              </span>
            )}
          </div>
          <button
            className={styles.closeBtn}
            onClick={closeSkill}
            title={t("close")}
            aria-label={t("close")}
          >
            <X size={18} />
          </button>
        </header>

        <div className={styles.body}>
          {info.description && <p className={styles.summary}>{info.description}</p>}

          {Object.keys(fm).length > 0 && (
            <div className={styles.meta}>
              <div className={styles.metaTitle}>{t("skills.frontmatter")}</div>
              <dl className={styles.metaList}>
                {Object.entries(fm).map(([k, v]) => (
                  <div className={styles.metaRow} key={k}>
                    <dt className={styles.metaKey}>{k}</dt>
                    <dd className={styles.metaVal}>{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          <div className={styles.filePath}>
            <span className={styles.filePathLabel}>{t("skills.filePath")}:</span>{" "}
            <code>{info.filePath}</code>
          </div>

          <div className={styles.md}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  );
}
