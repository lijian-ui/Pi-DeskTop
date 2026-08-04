import { MessageSquarePlus, Lightbulb, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { FEEDBACK_LINKS } from "../helpData";
import ExternalLink from "../ExternalLink";
import styles from "../HelpFeedbackPage.module.css";

const ICONS: Record<string, typeof MessageSquarePlus> = {
  bug: MessageSquarePlus,
  feature: Lightbulb,
};

/** Feedback entry points — all routed to the GitHub repo (issues / PRs). */
export default function HelpFeedback() {
  const { t } = useTranslation();

  return (
    <div className={styles.section}>
      <h2 className={styles.sectionTitle}>{t("help.feedback.title")}</h2>
      <div className={styles.linkList}>
        {FEEDBACK_LINKS.map((link) => (
          <ExternalLink
            key={link.id}
            url={link.url}
            labelKey={link.labelKey}
            descKey={link.descKey}
            icon={ICONS[link.id] ?? MessageSquarePlus}
          />
        ))}
        <ExternalLink
          url="https://github.com/lijian-ui/Pi-DeskTop/discussions"
          labelKey="help.feedback.community"
          descKey="help.feedback.community.desc"
          icon={Users}
        />
      </div>
    </div>
  );
}
