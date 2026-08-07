import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { X, RefreshCw, Loader2 } from "lucide-react";
import { usePackageStore } from "../store/package-store";
import styles from "./PackagesPage.module.css";

/** 更新确认弹窗：列出可更新扩展，由用户逐个或全部决定是否更新。 */
export default function UpdateModal() {
  const { t } = useTranslation();
  const open = usePackageStore((s) => s.updateModalOpen);
  const updates = usePackageStore((s) => s.pendingUpdates);
  const installPending = usePackageStore((s) => s.installPending);
  const closeUpdates = usePackageStore((s) => s.closeUpdates);
  const updateOne = usePackageStore((s) => s.updateOne);
  const updateAll = usePackageStore((s) => s.updateAll);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeUpdates();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeUpdates]);

  if (!open) return null;

  return (
    <div className={styles.detailOverlay} onClick={closeUpdates}>
      <div className={styles.updateModal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.detailHeader}>
          <div className={styles.detailTitleBlock}>
            <h2 className={styles.detailTitle}>{t("packages.updatesTitle")}</h2>
          </div>
          <button
            type="button"
            className={styles.detailClose}
            onClick={closeUpdates}
            title={t("close")}
          >
            <X size={16} />
          </button>
        </div>

        <div className={styles.updateBody}>
          <p className={styles.updateDesc}>{t("packages.updatesDesc")}</p>
          {updates.map((u) => {
            const pending = installPending[u.source] ?? false;
            return (
              <div key={u.source} className={styles.updateRow}>
                <div className={styles.updateInfo}>
                  <div className={styles.updateName}>{u.name}</div>
                  <div className={styles.cardSource}>{u.source}</div>
                </div>
                <button
                  type="button"
                  className={styles.installBtn}
                  onClick={() => updateOne(u.source)}
                  disabled={pending}
                >
                  {pending ? <Loader2 size={14} className={styles.spin} /> : <RefreshCw size={14} />}
                  <span>{t("packages.update")}</span>
                </button>
              </div>
            );
          })}
        </div>

        <div className={styles.updateFooter}>
          <button type="button" className={styles.updateCancelBtn} onClick={closeUpdates}>
            {t("rules.cancel")}
          </button>
          <button type="button" className={styles.updateAllBtn} onClick={updateAll}>
            <RefreshCw size={13} />
            {t("packages.updateAll")}
          </button>
        </div>
      </div>
    </div>
  );
}
