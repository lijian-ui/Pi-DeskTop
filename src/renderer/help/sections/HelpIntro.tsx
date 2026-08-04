import { Github, Star } from "lucide-react";
import { useTranslation } from "react-i18next";
import { GITHUB_REPO } from "../helpData";
import styles from "../HelpFeedbackPage.module.css";

/** Project intro + a prominent GitHub repository card with the project link. */
export default function HelpIntro() {
  const { t } = useTranslation();
  const openRepo = () => window.piDesk.openExternal(GITHUB_REPO).catch(() => {});

  return (
    <div className={styles.section}>
      <div className={styles.introCard}>
        <div className={styles.introIcon}>
          <Github size={28} />
        </div>
        <h2 className={styles.introTitle}>{t("help.intro.title")}</h2>
        <p className={styles.introDesc}>{t("help.intro.desc")}</p>

        <div className={styles.repoCard}>
          <div className={styles.repoMeta}>
            <span className={styles.repoLabel}>{t("help.repo.title")}</span>
            <span className={styles.repoUrl}>{GITHUB_REPO}</span>
          </div>
          <div className={styles.repoActions}>
            <button className={styles.primaryBtn} type="button" onClick={openRepo}>
              <Github size={15} />
              {t("help.repo.open")}
            </button>
          </div>
        </div>

        <p className={styles.repoDesc}>{t("help.repo.desc")}</p>
        <p className={styles.repoStar}>
          <Star size={14} className={styles.starIcon} />
          {t("help.repo.star")}
        </p>
      </div>
    </div>
  );
}
