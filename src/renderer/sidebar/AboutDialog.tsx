import { useEffect } from "react";
import { Info, RefreshCw, Download, RotateCw } from "lucide-react";
import { useUpdateStore } from "../store/update-store";
import { useTranslation } from "react-i18next";
import styles from "./AboutDialog.module.css";

export default function AboutDialog({
  open,
  appName,
  version,
  onClose,
}: {
  open: boolean;
  appName: string;
  version: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const updateState = useUpdateStore((s) => s.state);
  const check = useUpdateStore((s) => s.check);
  const quitAndInstall = useUpdateStore((s) => s.quitAndInstall);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const renderUpdateArea = () => {
    switch (updateState.status) {
      case "idle":
      case "not-available":
        return (
          <button className={styles.checkBtn} onClick={check}>
            <RefreshCw size={14} />
            {t("update.check")}
          </button>
        );
      case "checking":
        return (
          <span className={styles.updateStatus}>
            <RotateCw size={14} className={styles.spin} />
            {t("update.checking")}
          </span>
        );
      case "available":
        return (
          <span className={styles.updateStatus}>
            {t("update.available", { version: updateState.version ?? "" })}
          </span>
        );
      case "downloading":
        return (
          <span className={styles.updateStatus}>
            <Download size={14} />
            {t("update.downloading", {
              percent: Math.round(updateState.progress ?? 0),
            })}
          </span>
        );
      case "downloaded":
        return (
          <button className={styles.restartBtn} onClick={quitAndInstall}>
            <RotateCw size={14} />
            {t("update.restartInstall")}
          </button>
        );
      case "error":
        return (
          <div className={styles.updateError}>
            <span>{t("update.failed")}</span>
            <button className={styles.checkBtn} onClick={check}>
              <RefreshCw size={14} />
              {t("update.retry")}
            </button>
          </div>
        );
    }
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.icon}>
          <Info size={22} />
        </div>
        <h3 className={styles.title}>{appName}</h3>
        <p className={styles.version}>版本 {version}</p>
        <div className={styles.updateArea}>{renderUpdateArea()}</div>
        <div className={styles.footer}>
          <button className={styles.btnPrimary} onClick={onClose} autoFocus>
            {t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
