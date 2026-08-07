import { useTranslation } from "react-i18next";
import { useImageSettingsStore } from "../store/settings-store";
import styles from "./ContextPage.module.css";

const QUALITY_OPTIONS = [
  { value: 0.7, labelKey: "system.qualityLow" },
  { value: 0.82, labelKey: "system.qualityStandard" },
  { value: 0.9, labelKey: "system.qualityHigh" },
];

const SIDE_OPTIONS = [1280, 1600, 2048];

/**
 * "系统设置" — image input knobs. Lives inside the Settings page (wired from
 * SettingsPage's `system` nav item). All values persist via useImageSettingsStore
 * (localStorage) the moment they change.
 */
export default function SystemSettings() {
  const { t } = useTranslation();
  const image = useImageSettingsStore((s) => s.image);
  const setImage = useImageSettingsStore((s) => s.setImage);

  return (
    <div className={styles.page}>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{t("system.imageTitle")}</h2>
        <p className={styles.sectionDesc}>{t("system.imageDesc")}</p>

        {/* Master compression switch */}
        <label className={styles.toggleRow}>
          <input
            type="checkbox"
            checked={image.compressionEnabled}
            onChange={(e) => setImage({ compressionEnabled: e.target.checked })}
          />
          <span>
            <span className={styles.toggleLabel}>{t("system.imageCompression")}</span>
            <span className={styles.sectionDesc}>{t("system.imageCompressionHint")}</span>
          </span>
        </label>

        {/* Compression quality (only meaningful when enabled) */}
        <div className={styles.field}>
          <span className={styles.toggleLabel}>{t("system.imageQuality")}</span>
          <select
            className={styles.input}
            value={image.compressionQuality}
            disabled={!image.compressionEnabled}
            onChange={(e) => setImage({ compressionQuality: parseFloat(e.target.value) })}
          >
            {QUALITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {t(o.labelKey)}
              </option>
            ))}
          </select>
        </div>

        {/* Longest-side downscale target */}
        <div className={styles.field}>
          <span className={styles.toggleLabel}>{t("system.imageMaxSide")}</span>
          <select
            className={styles.input}
            value={image.compressionMaxSide}
            disabled={!image.compressionEnabled}
            onChange={(e) => setImage({ compressionMaxSide: parseInt(e.target.value, 10) })}
          >
            {SIDE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s} px
              </option>
            ))}
          </select>
        </div>

        {/* Per-message count cap */}
        <div className={styles.field}>
          <span className={styles.toggleLabel}>{t("system.imageMaxCount")}</span>
          <input
            className={styles.input}
            type="number"
            min={1}
            max={20}
            value={image.maxCount}
            onChange={(e) => {
              const v = Math.min(20, Math.max(1, parseInt(e.target.value || "1", 10) || 1));
              setImage({ maxCount: v });
            }}
          />
          <span className={styles.unit}>{t("system.unitImages")}</span>
        </div>

        {/* Per-image size cap (MB) */}
        <div className={styles.field}>
          <span className={styles.toggleLabel}>{t("system.imageMaxSize")}</span>
          <input
            className={styles.input}
            type="number"
            min={1}
            max={50}
            value={Math.round(image.maxBytes / 1024 / 1024)}
            onChange={(e) => {
              const mb = Math.min(50, Math.max(1, parseInt(e.target.value || "1", 10) || 1));
              setImage({ maxBytes: mb * 1024 * 1024 });
            }}
          />
          <span className={styles.unit}>{t("system.unitMB")}</span>
        </div>

        <p className={styles.hint}>{t("system.imageHint")}</p>
      </section>
    </div>
  );
}
