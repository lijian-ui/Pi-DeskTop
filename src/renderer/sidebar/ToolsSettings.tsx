import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "./ContextPage.module.css";
import type { ExtensionToolFeature } from "../../shared/tool-catalog-types";

/**
 * 设置 → 可用工具.
 *
 * Two tool families, two enable mechanisms (see docs/pi-tool-extension-guide.md):
 *  - Built-in SDK tools (read/bash/edit/write/grep/find/ls): persisted to
 *    settings.json `activeTools` via pi:saveActiveTools.
 *  - Extension tools (todo / ask_user_question / web_search / web_fetch /
 *    subagent): each feature's enabled flag is persisted to its own
 *    `*-config.json` via pi:saveExtensionTools. Subagent has no switch.
 */
const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export default function ToolsSettings() {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string[]>(BUILTIN_TOOLS);
  const [features, setFeatures] = useState<ExtensionToolFeature[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [tools, exts] = await Promise.all([
        window.piDesk.getActiveTools(),
        window.piDesk.getExtensionTools(),
      ]);
      setSelected(tools.length ? tools : BUILTIN_TOOLS);
      setFeatures(exts);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggleBuiltin = (name: string) => {
    setSelected((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    );
  };

  const toggleExtension = (key: string) => {
    setFeatures((prev) =>
      prev.map((f) => (f.key === key ? { ...f, enabled: !f.enabled } : f)),
    );
  };

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      await window.piDesk.saveActiveTools(selected);
      await window.piDesk.saveExtensionTools(
        features
          .filter((f) => f.switchable)
          .map((f) => ({ key: f.key, enabled: f.enabled })),
      );
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

        {/* ── Built-in SDK tools ── */}
        <h3 className={styles.subTitle}>{t("tools.builtinSection")}</h3>
        <div className={styles.section}>
          {BUILTIN_TOOLS.map((name) => (
            <label key={name} className={styles.toggleRow}>
              <input
                type="checkbox"
                checked={selected.includes(name)}
                onChange={() => toggleBuiltin(name)}
              />
              <span>
                <span className={styles.toggleLabel}>{name}</span>
                <span className={styles.sectionDesc}>{t(`tools.${name}`)}</span>
              </span>
            </label>
          ))}
        </div>

        {/* ── Extension tools ── */}
        <h3 className={styles.subTitle}>{t("tools.extSection")}</h3>
        <div className={styles.section}>
          {features.map((f) => (
            <label
              key={f.key}
              className={`${styles.toggleRow} ${f.switchable ? "" : styles.toggleDisabled}`}
            >
              <input
                type="checkbox"
                disabled={!f.switchable}
                checked={f.enabled}
                onChange={() => toggleExtension(f.key)}
              />
              <span>
                <span className={styles.toggleLabel}>
                  {t(`tools.ext.${f.key}`)}
                </span>
                <span className={styles.sectionDesc}>
                  {t(`tools.ext.${f.key}Desc`)}
                  {!f.switchable && (
                    <span className={styles.extNote}>
                      {" "}
                      {t("tools.extNoSwitch")}
                    </span>
                  )}
                </span>
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
