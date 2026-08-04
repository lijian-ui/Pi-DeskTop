import { useState } from "react";
import {
  X, Settings as SystemIcon, Palette, Brain, Cpu,
  Bot as AssistantIcon, Database, Keyboard, Shield, Languages,
  Layers, Wrench,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUIStore } from "../store/ui-store";
import ModelsPage from "./ModelsPage";
import ThemeSettings from "./ThemeSettings";
import SecurityPage from "./SecurityPage";
import ContextPage from "./ContextPage";
import SoulSettings from "./SoulSettings";
import ToolsSettings from "./ToolsSettings";
import { saveLang } from "../../shared/i18n/index";
import styles from "./SettingsPage.module.css";

type SettingsSection =
  | "system"
  | "personalization"
  | "memory"
  | "models"
  | "assistant"
  | "tools"
  | "data"
  | "shortcuts"
  | "security"
  | "context"
  | "language";

interface NavItem {
  key: SettingsSection;
  icon: typeof SystemIcon;
  labelKey: string;
}

const NAV_ITEMS: NavItem[] = [
  { key: "system", icon: SystemIcon, labelKey: "settings.system" },
  { key: "models", icon: Cpu, labelKey: "settings.models" },
  { key: "memory", icon: Brain, labelKey: "settings.memory" },
  { key: "assistant", icon: AssistantIcon, labelKey: "settings.assistant" },
  { key: "tools", icon: Wrench, labelKey: "settings.tools" },
  { key: "security", icon: Shield, labelKey: "settings.security" },
  { key: "context", icon: Layers, labelKey: "settings.context" },
  { key: "language", icon: Languages, labelKey: "lang.switch" },
  { key: "personalization", icon: Palette, labelKey: "settings.personalization" },
  { key: "shortcuts", icon: Keyboard, labelKey: "settings.shortcuts" },
  { key: "data", icon: Database, labelKey: "settings.data" },
];

export default function SettingsPage() {
  const [activeSection, setActiveSection] = useState<SettingsSection>("models");
  const setMainView = useUIStore((s) => s.setMainView);
  const { t, i18n } = useTranslation();

  const handleClose = () => setMainView("chat");

  const switchLang = (lng: string) => {
    i18n.changeLanguage(lng);
    saveLang(lng);
  };

  const activeItem = NAV_ITEMS.find((i) => i.key === activeSection);

  return (
    <div className={styles.page}>
      <aside className={styles.sidebar}>
        <nav className={styles.nav}>
          {NAV_ITEMS.map(({ key, icon: Icon, labelKey }) => (
            <button
              key={key}
              className={`${styles.navItem} ${activeSection === key ? styles.navItemActive : ""}`}
              onClick={() => setActiveSection(key)}
            >
              <Icon size={16} />
              <span>{t(labelKey)}</span>
            </button>
          ))}
        </nav>
      </aside>

      <div className={styles.content}>
        <header className={styles.contentHeader}>
          <h1 className={styles.contentTitle}>{activeItem ? t(activeItem.labelKey) : ""}</h1>
          <button className={styles.closeBtn} onClick={handleClose} title={t("close")}>
            <X size={16} />
          </button>
        </header>

        <div className={styles.contentBody}>
          {activeSection === "models" ? (
            <ModelsPage />
          ) : activeSection === "personalization" ? (
            <ThemeSettings />
          ) : activeSection === "security" ? (
            <SecurityPage />
          ) : activeSection === "context" ? (
            <ContextPage />
          ) : activeSection === "assistant" ? (
            <SoulSettings />
          ) : activeSection === "tools" ? (
            <ToolsSettings />
          ) : activeSection === "language" ? (
            <div className={styles.langPage}>
              <h2 className={styles.langTitle}>{t("lang.switch")}</h2>
              <div className={styles.langOptions}>
                <button
                  className={`${styles.langOption} ${i18n.language === "zh" ? styles.langOptionActive : ""}`}
                  onClick={() => switchLang("zh")}
                >
                  <span className={styles.langOptionText}>{t("lang.zh")}</span>
                  <span className={styles.langOptionDesc}>{t("lang.zhDesc")}</span>
                </button>
                <button
                  className={`${styles.langOption} ${i18n.language === "en" ? styles.langOptionActive : ""}`}
                  onClick={() => switchLang("en")}
                >
                  <span className={styles.langOptionText}>{t("lang.en")}</span>
                  <span className={styles.langOptionDesc}>{t("lang.enDesc")}</span>
                </button>
              </div>
            </div>
          ) : (
            <div className={styles.placeholder}>
              <div className={styles.placeholderIcon}>
                {activeItem && <activeItem.icon size={20} />}
              </div>
              <h2 className={styles.placeholderTitle}>{activeItem ? t(activeItem.labelKey) : ""}</h2>
              <p className={styles.placeholderDesc}>{t("settings.notImplemented")}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
