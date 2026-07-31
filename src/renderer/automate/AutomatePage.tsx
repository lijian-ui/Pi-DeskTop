import { X, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUIStore } from "../store/ui-store";
import styles from "./AutomatePage.module.css";

export default function AutomatePage() {
  const setMainView = useUIStore((s) => s.setMainView);
  const { t } = useTranslation();

  const handleClose = () => setMainView("chat");

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <Wrench size={18} className={styles.titleIcon} />
          <h1 className={styles.title}>{t("nav.automate")}</h1>
        </div>
        <button
          className={styles.closeBtn}
          onClick={handleClose}
          title={t("close")}
        >
          <X size={16} />
        </button>
      </header>
      <div className={styles.body}>
        <span className={styles.placeholder}>{t("automate.placeholder")}</span>
      </div>
    </div>
  );
}
