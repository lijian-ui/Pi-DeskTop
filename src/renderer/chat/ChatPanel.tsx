import MessageList from "./MessageList";
import ChatComposer from "./ChatComposer";
import { useAgentStore } from "../store/agent-store";
import { useUIStore } from "../store/ui-store";
import { useTranslation } from "react-i18next";
import styles from "./ChatPanel.module.css";

export default function ChatPanel() {
  const messages = useAgentStore((s) => s.messages);
  const setComposerText = useUIStore((s) => s.setComposerText);
  const { t } = useTranslation();

  const suggestions = [
    t("chat.suggestion.explain"),
    t("chat.suggestion.refactor"),
    t("chat.suggestion.test"),
    t("chat.suggestion.bug"),
  ];

  return (
    <div className={styles.chatPanel}>
      {messages.length === 0 ? (
        <div className={styles.emptyState}>
          <h1 className={styles.heroTitle}>
            Hello, <span className={styles.brand}>Pi</span>
          </h1>
          <p className={styles.heroSub}>{t("chat.heroSub")}</p>
          <div className={styles.suggestions}>
            <span className={styles.suggestionsLabel}>{t("chat.tryThese")}</span>
            <div className={styles.chips}>
              {suggestions.map((s) => (
                <button
                  key={s}
                  className={styles.chip}
                  onClick={() => setComposerText(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <MessageList />
      )}
      <ChatComposer />
    </div>
  );
}
