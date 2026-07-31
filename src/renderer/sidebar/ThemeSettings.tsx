import { useTheme } from "next-themes";
import { Sun, Moon, Monitor, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import styles from "./ThemeSettings.module.css";

const OPTIONS = [
  { value: "light", icon: Sun, labelKey: "theme.light" },
  { value: "dark", icon: Moon, labelKey: "theme.dark" },
  { value: "system", icon: Monitor, labelKey: "theme.system" },
] as const;

export default function ThemeSettings() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();

  return (
    <div className={styles.page}>
      <h2 className={styles.title}>{t("theme.title")}</h2>
      <p className={styles.desc}>{t("theme.desc")}</p>

      <div className={styles.options}>
        {OPTIONS.map(({ value, icon: Icon, labelKey }) => {
          const active = theme === value;
          return (
            <button
              key={value}
              type="button"
              className={`${styles.option} ${active ? styles.optionActive : ""}`}
              onClick={() => setTheme(value)}
              aria-pressed={active}
            >
              <span className={styles.optionIcon}>
                <Icon size={20} />
              </span>
              <span className={styles.optionLabel}>{t(labelKey)}</span>
              {active && (
                <span className={styles.optionCheck}>
                  <Check size={16} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
