import { useEffect, useMemo, useState } from "react";
import { X, ChevronDown, ChevronRight, ListChecks, Check } from "lucide-react";
import type { TodoStatus } from "../../shared/todo-types";
import { useTodoStore } from "../store/todo-store";
import { useUIStore } from "../store/ui-store";
import { useSessionStore } from "../store/session-store";
import styles from "./TodoPanel.module.css";

/**
 * 布局约束（Trae 式）：Todo 面板在场时调高窗口 minWidth，让窗口本身拒绝
 * 拖到「装不下所有区域」的宽度——侧栏 260 + 聊天区 600 + Todo 栏 320 = 1180。
 * 面板关闭/会话无清单时恢复基线 900。CSS 里各区域的 min-width 与此对齐。
 */
const BASE_WINDOW_MIN_WIDTH = 900;
const WINDOW_MIN_WIDTH_WITH_TODO = 1180;

/**
 * Right-side Todo checklist panel (read-only projection of the model's todo
 * tool state). Rendered only while the focused session has a live checklist
 * AND the panel is open. Closing it hides the column entirely — reopening is
 * done via the Todo toggle button in the titlebar (which stays visible as
 * long as the session has a checklist), so no inline rail is needed here.
 */
export default function TodoPanel() {
  const currentPath = useSessionStore((s) => s.currentPath);
  const open = useUIStore((s) => s.todoPanelOpen);
  const snapshot = useTodoStore((s) =>
    currentPath ? s.snapshots[currentPath] : undefined,
  );
  const fetchTodo = useTodoStore((s) => s.fetchTodo);
  const [showCompleted, setShowCompleted] = useState(false);

  // Switching / (re)loading a session always re-reads its checklist from disk —
  // the panel then shows the correct list for whatever the user focuses.
  useEffect(() => {
    if (currentPath) void fetchTodo(currentPath);
  }, [currentPath, fetchTodo]);

  const live = useMemo(
    () => (snapshot?.tasks ?? []).filter((t) => t.status !== "deleted"),
    [snapshot],
  );
  const active = useMemo(
    () => live.filter((t) => t.status !== "completed"),
    [live],
  );
  const done = useMemo(
    () => live.filter((t) => t.status === "completed"),
    [live],
  );
  const pct = live.length === 0 ? 0 : Math.round((done.length / live.length) * 100);

  // 面板在场（打开且有清单）→ 调高窗口最小宽；不在场 → 恢复基线。
  const panelActive = open && live.length > 0;
  useEffect(() => {
    if (!panelActive) return;
    void window.piDesk.setWindowMinWidth(WINDOW_MIN_WIDTH_WITH_TODO);
    return () => {
      void window.piDesk.setWindowMinWidth(BASE_WINDOW_MIN_WIDTH);
    };
  }, [panelActive]);

  // No live checklist on the focused session → nothing to show. Hidden while
  // the user closes the panel as well — reopening goes through the Todo
  // toggle in the titlebar.
  if (!open || live.length === 0) return null;

  const rows = showCompleted ? live : active;

  return (
    <div className={styles.panel} data-todo-panel="">
      <div className={styles.header}>
        <span className={styles.headerIcon}>
          <ListChecks size={15} />
        </span>
        <span className={styles.headerTitle}>任务清单</span>
        <span className={styles.headerBadge}>
          {done.length}/{live.length} 完成
        </span>
        <span className={styles.spacer} />
        <button
          className={styles.iconBtn}
          onClick={() => {
            if (currentPath) {
              useTodoStore.getState().setDismissed(currentPath, true);
            }
            useUIStore.getState().setTodoPanelOpen(false);
          }}
          title="关闭任务清单"
        >
          <X size={14} />
        </button>
      </div>

      <div className={styles.progressBlock}>
        <div className={styles.progressLabels}>
          <span className={styles.progressLabel}>进度</span>
          <span className={styles.progressPct}>{pct}%</span>
        </div>
        <div className={styles.progressTrack}>
          <div className={styles.progressFill} style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className={styles.list}>
        {rows.map((t) => (
          <div
            key={t.id}
            className={`${styles.card} ${t.status === "in_progress" ? styles.cardActive : ""}`}
          >
            <span className={checkboxClass(t.status)}>
              {t.status === "completed" && <Check size={12} strokeWidth={3} />}
              {t.status === "in_progress" && <span className={styles.checkDot} />}
            </span>
            <span className={styles.cardBody}>
              <span className={t.status === "completed" ? styles.doneText : styles.cardText}>
                {t.content}
              </span>
              {t.blockedBy && t.blockedBy.length > 0 && (
                <span className={styles.dep}>依赖 #{t.blockedBy.join(" #")}</span>
              )}
            </span>
          </div>
        ))}
        {rows.length === 0 && (
          <div className={styles.emptyHint}>已完成全部任务</div>
        )}
      </div>

      {done.length > 0 && (
        <button
          className={styles.doneToggle}
          onClick={() => setShowCompleted((v) => !v)}
        >
          {showCompleted ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          {showCompleted ? "收起已完成" : `已完成 ${done.length}`}
        </button>
      )}
    </div>
  );
}

function checkboxClass(status: TodoStatus): string {
  switch (status) {
    case "in_progress":
      return `${styles.checkbox} ${styles.checkboxInProgress}`;
    case "completed":
      return `${styles.checkbox} ${styles.checkboxCompleted}`;
    default:
      return styles.checkbox;
  }
}
