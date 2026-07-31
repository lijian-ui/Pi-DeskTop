import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import styles from "./SoulSettings.module.css";

/**
 * Assistant Settings → "助手设置" (Soul / persona editor).
 *
 * Lets the user write free-form markdown that is injected into every
 * conversation's system prompt (appended after Pi's default instructions).
 * Saving persists to ~/.pi/agent/soul.md and the main process makes it take
 * effect immediately for the current session and globally for new sessions.
 */
export default function SoulSettings() {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    loadSoul();
  }, []);

  async function loadSoul() {
    try {
      const soul = await window.piDesk.getSoul();
      setText(soul);
    } catch {
      setText("");
    }
    setLoading(false);
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    try {
      await window.piDesk.saveSoul(text);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } finally {
      setSaving(false);
    }
  }

  function handleClear() {
    setText("");
  }

  if (loading) return <div className={styles.loading}>{t("soul.loading")}</div>;

  return (
    <div className={styles.page}>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{t("soul.editorTitle")}</h2>
        <p className={styles.sectionDesc}>{t("soul.desc")}</p>
        <textarea
          className={styles.textarea}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("soul.placeholder")}
          rows={18}
          spellCheck={false}
        />
        <p className={styles.hint}>{t("soul.hint")}</p>
      </section>

      <div className={styles.actions}>
        <button
          className={`${styles.saveBtn} ${saved ? styles.saveBtnSuccess : ""}`}
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? t("soul.saving") : saved ? t("soul.saved") : t("save")}
        </button>
        <button
          className={styles.clearBtn}
          onClick={handleClear}
          disabled={saving || text.length === 0}
        >
          {t("soul.clear")}
        </button>
      </div>
    </div>
  );
}
