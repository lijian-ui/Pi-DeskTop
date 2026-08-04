import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import styles from "./HelpFeedbackPage.module.css";

/**
 * A button that opens an external http(s) URL in the OS default browser via
 * the main process (shell.openExternal). Used everywhere a help link points
 * off-app so we never rely on window.open inside Electron.
 */
export default function ExternalLink({
  url,
  labelKey,
  descKey,
  icon: Icon,
}: {
  url: string;
  labelKey: string;
  descKey?: string;
  icon?: LucideIcon;
}) {
  const { t } = useTranslation();
  const open = () => {
    window.piDesk.openExternal(url).catch(() => {});
  };
  return (
    <button className={styles.linkCard} onClick={open} type="button">
      {Icon && (
        <span className={styles.linkIcon}>
          <Icon size={18} />
        </span>
      )}
      <span className={styles.linkBody}>
        <span className={styles.linkLabel}>{t(labelKey)}</span>
        {descKey && <span className={styles.linkDesc}>{t(descKey)}</span>}
      </span>
      <span className={styles.linkArrow} aria-hidden>
        ↗
      </span>
    </button>
  );
}
