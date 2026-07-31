import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import styles from "./ContextPage.module.css";

interface CompactionConfig {
  keepRecentTokens: number;
  reserveTokens: number;
  enabled: boolean;
}

export default function ContextPage() {
  const { t } = useTranslation();
  const [keepRecent, setKeepRecent] = useState<number>(20000);
  const [reserve, setReserve] = useState<number>(16384);
  const [enabled, setEnabled] = useState<boolean>(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    loadConfig();
  }, []);

  async function loadConfig() {
    try {
      const cfg = await window.piDesk.getCompactionConfig();
      setKeepRecent(cfg.keepRecentTokens);
      setReserve(cfg.reserveTokens);
      setEnabled(cfg.enabled);
    } catch {
      /* fall back to defaults already set */
    }
    setLoading(false);
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    try {
      const clampedKeep = Math.max(1000, Math.min(200000, Math.floor(keepRecent) || 20000));
      const clampedReserve = Math.max(1024, Math.min(200000, Math.floor(reserve) || 16384));
      await window.piDesk.saveCompactionConfig({
        keepRecentTokens: clampedKeep,
        reserveTokens: clampedReserve,
        enabled,
      });
      setKeepRecent(clampedKeep);
      setReserve(clampedReserve);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className={styles.loading}>{t("context.loading")}</div>;

  return (
    <div className={styles.page}>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{t("context.keepTitle")}</h2>
        <p className={styles.sectionDesc}>{t("context.keepDesc")}</p>
        <div className={styles.field}>
          <input
            className={styles.input}
            type="number"
            min={1000}
            max={200000}
            step={500}
            value={keepRecent}
            onChange={(e) => setKeepRecent(Number(e.target.value))}
          />
          <span className={styles.unit}>tokens</span>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{t("context.reserveTitle")}</h2>
        <p className={styles.sectionDesc}>{t("context.reserveDesc")}</p>
        <div className={styles.field}>
          <input
            className={styles.input}
            type="number"
            min={1024}
            max={200000}
            step={500}
            value={reserve}
            onChange={(e) => setReserve(Number(e.target.value))}
          />
          <span className={styles.unit}>tokens</span>
        </div>
      </section>

      <section className={styles.section}>
        <label className={styles.toggleRow}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>
            <span className={styles.toggleLabel}>{t("context.enabledTitle")}</span>
            <span className={styles.sectionDesc}>{t("context.enabledDesc")}</span>
          </span>
        </label>
      </section>

      <p className={styles.hint}>{t("context.restartHint")}</p>

      <div className={styles.actions}>
        <button
          className={`${styles.saveBtn} ${saved ? styles.saveBtnSuccess : ""}`}
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? t("context.saving") : saved ? t("context.saved") : t("save")}
        </button>
      </div>
    </div>
  );
}
