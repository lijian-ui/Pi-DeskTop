import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "./ContextPage.module.css";

/** Pi SDK built-in tools (docs/sdk.md:492). The SDK activates only the first
 * four by default; the rest are opt-in via settings.json `activeTools`. */
const ALL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export default function ToolsSettings() {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string[]>(ALL_TOOLS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const tools = await window.piDesk.getActiveTools();
      setSelected(tools.length ? tools : ALL_TOOLS);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = (name: string) => {
    setSelected((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    );
  };

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      await window.piDesk.saveActiveTools(selected);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className={styles.loading}>{t("tools.loading")}</div>;

  return (
    <div className={styles.page}>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{t("tools.title")}</h2>
        <p className={styles.sectionDesc}>{t("tools.desc")}</p>
        <div className={styles.section}>
          {ALL_TOOLS.map((name) => (
            <label key={name} className={styles.toggleRow}>
              <input
                type="checkbox"
                checked={selected.includes(name)}
                onChange={() => toggle(name)}
              />
              <span>
                <span className={styles.toggleLabel}>{name}</span>
                <span className={styles.sectionDesc}>{t(`tools.${name}`)}</span>
              </span>
            </label>
          ))}
        </div>
        <p className={styles.hint}>{t("tools.hint")}</p>
        {error && <p className={styles.error}>{error}</p>}
        <div className={styles.actions}>
          <button
            className={`${styles.saveBtn} ${saved ? styles.saveBtnSuccess : ""}`}
            onClick={handleSave}
            disabled={saving}
          >
            {saving
              ? t("tools.saving")
              : saved
                ? t("tools.saved")
                : t("tools.save")}
          </button>
        </div>
      </section>
    </div>
  );
}
