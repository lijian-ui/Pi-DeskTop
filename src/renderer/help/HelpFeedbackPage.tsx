import { useState } from "react";
import { X, Github, HelpCircle, MessageSquare, BookOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUIStore } from "../store/ui-store";
import type { LucideIcon } from "lucide-react";
import HelpIntro from "./sections/HelpIntro";
import HelpFaq from "./sections/HelpFaq";
import HelpFeedback from "./sections/HelpFeedback";
import HelpResources from "./sections/HelpResources";
import styles from "./HelpFeedbackPage.module.css";

type HelpSectionKey = "intro" | "faq" | "feedback" | "resources";

interface SectionDef {
  key: HelpSectionKey;
  icon: LucideIcon;
  labelKey: string;
}

const SECTIONS: SectionDef[] = [
  { key: "intro", icon: Github, labelKey: "help.intro.title" },
  { key: "faq", icon: HelpCircle, labelKey: "help.faq.title" },
  { key: "feedback", icon: MessageSquare, labelKey: "help.feedback.title" },
  { key: "resources", icon: BookOpen, labelKey: "help.resources.title" },
];

/**
 * Modular Help & Feedback page. A left rail switches between four self-contained
 * sections (each in its own file under ./sections). The GitHub project link is
 * surfaced prominently in the intro section.
 */
export default function HelpFeedbackPage() {
  const { t } = useTranslation();
  const setMainView = useUIStore((s) => s.setMainView);
  const [active, setActive] = useState<HelpSectionKey>("intro");

  const handleClose = () => setMainView("chat");

  return (
    <div className={styles.page}>
      <aside className={styles.sidebar}>
        <nav className={styles.nav}>
          {SECTIONS.map(({ key, icon: Icon, labelKey }) => (
            <button
              key={key}
              type="button"
              className={`${styles.navItem} ${active === key ? styles.navItemActive : ""}`}
              onClick={() => setActive(key)}
            >
              <Icon size={16} />
              <span>{t(labelKey)}</span>
            </button>
          ))}
        </nav>
      </aside>

      <div className={styles.content}>
        <header className={styles.contentHeader}>
          <h1 className={styles.contentTitle}>{t("help.title")}</h1>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={handleClose}
            title={t("help.back")}
          >
            <X size={16} />
          </button>
        </header>

        <div className={styles.contentBody}>
          {active === "intro" && <HelpIntro />}
          {active === "faq" && <HelpFaq />}
          {active === "feedback" && <HelpFeedback />}
          {active === "resources" && <HelpResources />}
        </div>
      </div>
    </div>
  );
}
