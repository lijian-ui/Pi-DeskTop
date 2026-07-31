import { X, Upload, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUIStore } from "../store/ui-store";
import { useSkillStore } from "../store/skill-store";
import SkillsPanel from "./SkillsPanel";
import styles from "./SkillsPage.module.css";

export default function SkillsPage() {
  const setMainView = useUIStore((s) => s.setMainView);
  const skills = useSkillStore((s) => s.skills);
  const importing = useSkillStore((s) => s.importing);
  const importSkill = useSkillStore((s) => s.importSkill);
  const { t } = useTranslation();

  const handleClose = () => setMainView("chat");

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <Sparkles size={18} className={styles.titleIcon} />
          <h1 className={styles.title}>{t("skills.title")}</h1>
          <span className={styles.count}>({skills.length})</span>
        </div>
        <div className={styles.headerActions}>
          <button
            className={styles.importBtn}
            onClick={() => importSkill()}
            disabled={importing}
            title={t("skills.import")}
          >
            <Upload size={14} />
            <span>{importing ? t("skills.importing") : t("skills.import")}</span>
          </button>
          <button
            className={styles.closeBtn}
            onClick={handleClose}
            title={t("close")}
          >
            <X size={16} />
          </button>
        </div>
      </header>

      <div className={styles.contentBody}>
        <div className={styles.pageBody}>
          <SkillsPanel />
        </div>
      </div>
    </div>
  );
}
