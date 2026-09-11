import { useEffect, useMemo, useState } from "react";
import { X, ChevronDown, ChevronRight } from "lucide-react";
import type { TodoStatus } from "../../shared/todo-types";
import { useTodoStore } from "../store/todo-store";
import { useUIStore } from "../store/ui-store";
import { useSessionStore } from "../store/session-store";
import styles from "./TodoPanel.module.css";

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

  // No live checklist on the focused session → nothing to show. Hidden while
  // the user closes the panel as well — reopening goes through the Todo
  // toggle in the titlebar.
  if (!open || live.length === 0) return null;

  const rows = showCompleted ? live : active;

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>任务清单</span>
        <span className={styles.progress}>
          {done.length}/{live.length}
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

      <div className={styles.list}>
        {rows.map((t) => (
          <div key={t.id} className={styles.row}>
            <span className={statusDot(t.status)} />
            <span className={styles.rowBody}>
              <span className={t.status === "completed" ? styles.doneText : styles.rowText}>
                {t.content}
              </span>
              {t.blockedBy && t.blockedBy.length > 0 && (
                <span className={styles.dep}>
                  依赖 #{t.blockedBy.join(" #")}
                </span>
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
          {showCompleted ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {showCompleted ? "收起已完成" : `已完成 ${done.length}`}
        </button>
      )}
    </div>
  );
}

function statusDot(status: TodoStatus): string {
  switch (status) {
    case "in_progress":
      return styles.dotInProgress;
    case "completed":
      return styles.dotCompleted;
    default:
      return styles.dotPending;
  }
}
