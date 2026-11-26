import { useEffect } from "react";
import MessageList from "./MessageList";
import ChatComposer from "./ChatComposer";
import TodoPanel from "./TodoPanel";
import SubagentProgress from "../components/SubagentProgress";
import { useAgentStore } from "../store/agent-store";
import { useUIStore } from "../store/ui-store";
import { useTodoStore } from "../store/todo-store";
import { useSessionStore } from "../store/session-store";
import { useSubagentStore } from "../store/subagent-store";
import { useTranslation } from "react-i18next";
import styles from "./ChatPanel.module.css";

/** 右栏任一面板在场时的窗口最小宽（侧栏 260 + 聊天 600 + 栏 320）。
 *  与 ChatPanel.module.css 的区域 min-width 对齐，集中管理避免两个面板
 *  各自 set/restore 互相打架（Todo 清理时子代理可能仍开着）。 */
const BASE_WINDOW_MIN_WIDTH = 900;
const RAIL_WINDOW_MIN_WIDTH = 1180;

export default function ChatPanel() {
  const messages = useAgentStore((s) => s.messages);
  const setComposerText = useUIStore((s) => s.setComposerText);
  const { t } = useTranslation();

  // 右栏动态窗口下限：Todo 或子代理面板任一在场 → 1180；都关 → 900。
  const currentPath = useSessionStore((s) => s.currentPath);
  const todoOpen = useUIStore((s) => s.todoPanelOpen);
  const todoSnapshot = useTodoStore((s) =>
    currentPath ? s.snapshots[currentPath] : undefined,
  );
  const todoActive =
    todoOpen && (todoSnapshot?.tasks ?? []).some((t) => t.status !== "deleted");
  const subRuns = useSubagentStore((s) => s.runs);
  const subDismissed = useSubagentStore((s) => s.dismissed);
  const subActive = subRuns.some(
    (r) =>
      !subDismissed.includes(r.runId) &&
      (!r.sessionPath || r.sessionPath === currentPath),
  );

  useEffect(() => {
    void window.piDesk.setWindowMinWidth(
      todoActive || subActive ? RAIL_WINDOW_MIN_WIDTH : BASE_WINDOW_MIN_WIDTH,
    );
  }, [todoActive, subActive]);

  const suggestions = [
    t("chat.suggestion.explain"),
    t("chat.suggestion.refactor"),
    t("chat.suggestion.test"),
    t("chat.suggestion.bug"),
  ];

  return (
    <div className={styles.chatPanel}>
      <div className={styles.chatBody}>
        <div className={styles.chatMain}>
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
        {/* Right rail — each block renders nothing while idle, so an empty
            rail collapses to zero width (CSS :empty) and the chat stays full
            width. Subagent progress sits above the Todo checklist. */}
        <div className={styles.rightRail}>
          <SubagentProgress />
          <TodoPanel />
        </div>
      </div>
    </div>
  );
}
