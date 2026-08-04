import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { FAQ_ITEMS } from "../helpData";
import styles from "../HelpFeedbackPage.module.css";

/** Accordion of frequently asked questions. Content is bilingual and picked
 *  by the active UI language, so no i18n key explosion is needed. */
export default function HelpFaq() {
  const { t, i18n } = useTranslation();
  const [openId, setOpenId] = useState<string | null>(FAQ_ITEMS[0]?.id ?? null);
  const lang = i18n.language?.toLowerCase().startsWith("zh") ? "zh" : "en";

  return (
    <div className={styles.section}>
      <h2 className={styles.sectionTitle}>{t("help.faq.title")}</h2>
      <div className={styles.faqList}>
        {FAQ_ITEMS.map((item) => {
          const isOpen = openId === item.id;
          return (
            <div key={item.id} className={styles.faqItem}>
              <button
                type="button"
                className={styles.faqQ}
                onClick={() => setOpenId(isOpen ? null : item.id)}
                aria-expanded={isOpen}
              >
                <span>{item.q[lang]}</span>
                <ChevronDown
                  size={16}
                  className={isOpen ? styles.faqChevronOpen : styles.faqChevron}
                />
              </button>
              {isOpen && <p className={styles.faqA}>{item.a[lang]}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
