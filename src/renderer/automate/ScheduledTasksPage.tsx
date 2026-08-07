import { useEffect, useState } from "react";
import {
  Plus,
  Play,
  Pencil,
  Trash2,
  Clock,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "../store/session-store";
import type { ScheduledTask } from "../../preload/api";
import {
  latestRunFor,
  taskStatus,
  scheduleText,
  lastRunText,
  nextRunText,
  missedText,
  createBlankTask,
} from "../utils/scheduled";
import { useUIStore } from "../store/ui-store";
import ScheduledTaskEditor from "./ScheduledTaskEditor";
import ConfirmDialog from "../sidebar/ConfirmDialog";
import styles from "./ScheduledTasks.module.css";

export default function ScheduledTasksPage() {
  const { t } = useTranslation();
  const scheduled = useSessionStore((s) => s.scheduledRuns);
  const refresh = useSessionStore((s) => s.refreshScheduledTasks);

  const [editing, setEditing] = useState<{
    task: ScheduledTask;
    isNew: boolean;
  } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ScheduledTask | null>(null);

  // Pull fresh data when the page opens.
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Honor the sidebar "+" deep-link: open the new-task editor straight away,
  // then clear the flag so a later visit opens on the plain list.
  useEffect(() => {
    const { pendingScheduledNew, setPendingScheduledNew } = useUIStore.getState();
    if (pendingScheduledNew) {
      setEditing({ task: createBlankTask(""), isNew: true });
      setPendingScheduledNew(false);
    }
  }, []);

  const openNew = () => {
    // Blank tasks have NO default cwd — an unbound task runs in the cron
    // fallback dir at execution time, so its session never collides with the
    // chat-only cwd (which would double-render it under 任务).
    setEditing({ task: createBlankTask(""), isNew: true });
  };
  const openEdit = (task: ScheduledTask) => {
    setEditing({ task, isNew: false });
  };
  const closeEditor = () => setEditing(null);

  const handleSave = async (task: ScheduledTask) => {
    await window.piDesk.saveScheduledTask(task);
    await refresh();
    setEditing(null);
  };

  const handleDelete = async () => {
    if (pendingDelete) {
      await window.piDesk.deleteScheduledTask(pendingDelete.id);
      await refresh();
      setPendingDelete(null);
    }
  };

  /** Flip enabled straight from the list. The main process invalidates the
   *  persisted nextRunAt on re-enable, so the task resumes from now on. */
  const handleToggleEnabled = async (task: ScheduledTask) => {
    try {
      await window.piDesk.saveScheduledTask({ ...task, enabled: !task.enabled });
      await refresh();
    } catch (err) {
      console.error("Failed to toggle scheduled task:", err);
    }
  };

  const handleRunNow = async (id: string) => {
    try {
      await window.piDesk.runScheduledTaskNow(id);
    } catch (err) {
      console.error("Failed to run scheduled task now:", err);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h2 className={styles.title}>
          <Clock size={18} />
          {t("scheduled.title")}
        </h2>
        <button className={styles.primaryBtn} onClick={openNew}>
          <Plus size={15} />
          {t("scheduled.new")}
        </button>
      </div>

      <p className={styles.desc}>{t("scheduled.desc")}</p>

      <div className={styles.list}>
        {scheduled.tasks.length === 0 && (
          <div className={styles.empty}>{t("scheduled.empty")}</div>
        )}

        {scheduled.tasks.map((task) => {
          const st = taskStatus(scheduled.runs, task.id);
          const latest = latestRunFor(scheduled.runs, task.id);
          const runtime = scheduled.states[task.id];
          const missed = missedText(runtime, t);
          return (
            <div
              key={task.id}
              className={`${styles.card} ${task.enabled ? "" : styles.cardOff}`}
              onClick={() => openEdit(task)}
            >
              <div className={styles.cardBody}>
                <div className={styles.cardTitleRow}>
                  <span
                    className={`${styles.statusDot} ${styles["status_" + st]}`}
                  />
                  <span className={styles.cardName}>{task.name || t("scheduled.untitled")}</span>
                </div>
                <div className={styles.cardSub}>{scheduleText(task, t)}</div>
                {task.prompt && (
                  <div className={styles.cardPrompt}>{task.prompt}</div>
                )}
                <div className={styles.cardMeta}>
                  <span>{lastRunText(latest, t)}</span>
                  <span className={styles.metaSep}>·</span>
                  <span>{nextRunText(task, runtime, t)}</span>
                </div>
                {missed && <div className={styles.cardWarn}>{missed}</div>}
              </div>

              <div className={styles.cardActions} onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className={`${styles.switch} ${task.enabled ? styles.switchOn : ""}`}
                  title={
                    task.enabled ? t("scheduled.clickToDisable") : t("scheduled.clickToEnable")
                  }
                  aria-label={t("scheduled.enabled")}
                  aria-pressed={task.enabled}
                  onClick={() => handleToggleEnabled(task)}
                >
                  <span className={styles.switchKnob} />
                </button>
                <span className={styles.actionSep} />
                <button
                  className={styles.actionBtn}
                  title={t("scheduled.runNow")}
                  onClick={() => handleRunNow(task.id)}
                >
                  <Play size={14} />
                </button>
                <button
                  className={styles.actionBtn}
                  title={t("scheduled.edit")}
                  onClick={() => openEdit(task)}
                >
                  <Pencil size={14} />
                </button>
                <button
                  className={`${styles.actionBtn} ${styles.actionDanger}`}
                  title={t("scheduled.delete")}
                  onClick={() => setPendingDelete(task)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {editing && (
        <ScheduledTaskEditor
          task={editing.task}
          isNew={editing.isNew}
          onSave={handleSave}
          onCancel={closeEditor}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("scheduled.deleteConfirmTitle")}
        message={t("scheduled.deleteConfirm")}
        confirmLabel={t("scheduled.delete")}
        cancelLabel={t("close")}
        danger
        onConfirm={handleDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
