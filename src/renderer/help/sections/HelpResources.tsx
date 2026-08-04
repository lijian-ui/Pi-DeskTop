import { BookOpen, Package, Tag } from "lucide-react";
import { useTranslation } from "react-i18next";
import { RESOURCE_LINKS } from "../helpData";
import ExternalLink from "../ExternalLink";
import styles from "../HelpFeedbackPage.module.css";

const ICONS: Record<string, typeof BookOpen> = {
  pi: BookOpen,
  packages: Package,
  releases: Tag,
};

/** External documentation / resources. */
export default function HelpResources() {
  const { t } = useTranslation();

  return (
    <div className={styles.section}>
      <h2 className={styles.sectionTitle}>{t("help.resources.title")}</h2>
      <div className={styles.linkList}>
        {RESOURCE_LINKS.map((link) => (
          <ExternalLink
            key={link.id}
            url={link.url}
            labelKey={link.labelKey}
            descKey={link.descKey}
            icon={ICONS[link.id] ?? BookOpen}
          />
        ))}
      </div>
    </div>
  );
}
