import { useEffect, useMemo, useState } from "react";
import { Sparkles, Search, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSkillStore } from "../store/skill-store";
import styles from "./SkillsPanel.module.css";
import SkillDetailModal from "./SkillDetailModal";

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
  const load = useSkillStore((s) => s.load);
  const openSkill = useSkillStore((s) => s.openSkill);

  const [query, setQuery] = useState("");

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)
    );
  }, [skills, query]);

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
          <button
            key={skill.filePath}
            className={styles.item}
            onClick={() => openSkill(skill)}
            title={t("skills.clickToView")}
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
                  <span className={`${styles.badge} ${styles.badgeModelOnly}`}>
                    {t("skills.modelOnly")}
                  </span>
                )}
              </div>
              <div className={styles.itemDesc}>{skill.description}</div>
            </div>
          </button>
        ))}
      </div>

      <SkillDetailModal />
    </div>
  );
}
