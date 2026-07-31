import { MessageSquare, Folder, Settings } from "lucide-react";
import { useUIStore } from "../store/ui-store";
import { useTranslation } from "react-i18next";
import styles from "./ActivityBar.module.css";

const ITEMS = [
  { id: "sessions", icon: MessageSquare, labelKey: "activity.sessions" },
  { id: "files", icon: Folder, labelKey: "activity.files" },
  { id: "settings", icon: Settings, labelKey: "activity.settings" },
] as const;

export default function ActivityBar() {
  const activeItem = useUIStore((s) => s.activeItem);
  const setActiveItem = useUIStore((s) => s.setActiveItem);
  const { t } = useTranslation();

  return (
    <div className={styles.activityBar}>
      {ITEMS.map(({ id, icon: Icon, labelKey }) => (
        <button
          key={id}
          className={`${styles.item} ${activeItem === id ? styles.active : ""}`}
          onClick={() => setActiveItem(id)}
          title={t(labelKey)}
        >
          <Icon size={20} />
        </button>
      ))}
      <div className={styles.spacer} />
    </div>
  );
}
