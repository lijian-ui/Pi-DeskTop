import { useEffect, useMemo, useState } from "react";
import { Sparkles, Search, Wrench, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSkillStore } from "../store/skill-store";
import type { SkillInfo } from "../../preload/api";
import styles from "./SkillsPanel.module.css";
import SkillDetailModal from "./SkillDetailModal";
import ConfirmDialog from "../sidebar/ConfirmDialog";

const SOURCE_KEY: Record<string, string> = {
  user: "skills.source.user",
  project: "skills.source.project",
  path: "skills.source.path",
};

export default function SkillsPanel() {
  const { t } = useTranslation();
  const skills = useSkillStore((s) => s.skills);
  const loading = useSkillStore((s) => s.loading);
  const error = useSkillStore((s) => s.error);
  const togglingPath = useSkillStore((s) => s.togglingPath);
  const deletingPath = useSkillStore((s) => s.deletingPath);
  const load = useSkillStore((s) => s.load);
  const openSkill = useSkillStore((s) => s.openSkill);
  const toggleSkill = useSkillStore((s) => s.toggleSkill);
  const removeSkill = useSkillStore((s) => s.removeSkill);

  const [query, setQuery] = useState("");
  /** Hide disabled (disableModelInvocation) skills — shown by default so the
   *  list never silently empties; disabled ones are marked + dimmed instead. */
  const [hideDisabled, setHideDisabled] = useState(false);
  /** Skill pending delete confirmation (null = dialog closed). */
  const [confirmSkill, setConfirmSkill] = useState<SkillInfo | null>(null);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const visible = skills.filter((s) => !hideDisabled || !s.disableModelInvocation);
    const q = query.trim().toLowerCase();
    if (!q) return visible;
    return visible.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)
    );
  }, [skills, query, hideDisabled]);

  const confirmDelete = () => {
    if (!confirmSkill) return;
    void removeSkill(confirmSkill);
    setConfirmSkill(null);
  };

  return (
    <div className={styles.panel}>
      <div className={styles.searchRow}>
        <Search size={13} />
        <input
          className={styles.search}
          placeholder={t("skills.commandPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          className={`${styles.showDisabled} ${hideDisabled ? styles.showDisabledOn : ""}`}
          onClick={() => setHideDisabled((v) => !v)}
          title={t("skills.showDisabledHint")}
        >
          {t(hideDisabled ? "skills.showDisabled" : "skills.hideDisabled")}
        </button>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {!loading && skills.length === 0 && (
        <div className={styles.empty}>
          <Sparkles size={22} />
          <p>{t("skills.empty")}</p>
          <p className={styles.emptyHint}>{t("skills.import")}</p>
        </div>
      )}

      {!loading && skills.length > 0 && filtered.length === 0 && (
        <div className={styles.empty}>{t("sidebar.filter")}</div>
      )}

      <div className={styles.list}>
        {filtered.map((skill) => (
          <div
            key={skill.filePath}
            className={`${styles.item} ${skill.disableModelInvocation ? styles.itemDisabled : ""}`}
            onClick={() => openSkill(skill)}
            title={t("skills.clickToView")}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                void openSkill(skill);
              }
            }}
          >
            <div className={styles.itemIcon}>
              <Wrench size={18} />
            </div>
            <div className={styles.itemBody}>
              <div className={styles.itemHead}>
                <span className={styles.itemName}>/skill:{skill.name}</span>
                <span className={`${styles.badge} ${styles[`badge_${skill.source}`] ?? ""}`}>
                  {t(SOURCE_KEY[skill.source] ?? "skills.source.path")}
                </span>
                {skill.disableModelInvocation && (
                  <span className={`${styles.badge} ${styles.badgeDisabled}`}>
                    {t("skills.disabled")}
                  </span>
                )}
              </div>
              <div className={styles.itemDesc}>{skill.description}</div>
            </div>
            <div className={styles.itemActions} onClick={(e) => e.stopPropagation()}>
              <button
                className={`${styles.toggle} ${!skill.disableModelInvocation ? styles.toggleOn : ""}`}
                onClick={() => void toggleSkill(skill)}
                disabled={togglingPath === skill.filePath}
                title={
                  skill.disableModelInvocation
                    ? t("skills.enableHint")
                    : t("skills.disableHint")
                }
              >
                <span className={styles.toggleKnob} />
              </button>
              <button
                className={styles.delete}
                onClick={() => setConfirmSkill(skill)}
                disabled={deletingPath === skill.filePath}
                title={t("skills.deleteHint")}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={confirmSkill !== null}
        title={t("skills.deleteTitle")}
        message={
          confirmSkill
            ? t("skills.deleteConfirm", { name: confirmSkill.name })
            : ""
        }
        confirmLabel={t("skills.delete")}
        cancelLabel={t("common.cancel")}
        onConfirm={confirmDelete}
        onCancel={() => setConfirmSkill(null)}
      />

      <SkillDetailModal />
    </div>
  );
}
