import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  ScheduledTask,
  ScheduleType,
  TaskSchedule,
} from "../../preload/api";
import { LAST_DAY_OF_MONTH } from "../../shared/schedule";
import styles from "./ScheduledTasks.module.css";

interface Props {
  task: ScheduledTask;
  isNew: boolean;
  onSave: (task: ScheduledTask) => void;
  onCancel: () => void;
}

const SCHEDULE_TYPES: ScheduleType[] = [
  "interval",
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "once",
];

/** Types that fire at a wall-clock time of day. */
const TIME_BASED: ScheduleType[] = ["daily", "weekly", "monthly", "yearly"];

/** Largest possible day count per month — February allows 29 so a leap-day
 *  schedule stays selectable (it simply fires only in leap years). */
const MONTH_MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Shape of a model as returned by window.piDesk.getAvailableModels(). */
interface ModelItem {
  id: string;
  name?: string;
  provider: string;
}

const modelKeyOf = (m: { provider: string; id?: string; modelId?: string }): string =>
  `${m.provider}::${m.id ?? m.modelId ?? ""}`;
const parseModelKey = (key: string): { provider: string; modelId: string } | null => {
  const idx = key.indexOf("::");
  if (idx < 0) return null;
  return { provider: key.slice(0, idx), modelId: key.slice(idx + 2) };
};

/** Convert an ISO datetime to the value format expected by <input type="datetime-local">. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export default function ScheduledTaskEditor({
  task,
  isNew,
  onSave,
  onCancel,
}: Props) {
  const { t } = useTranslation();
  const now = new Date();

  const [name, setName] = useState(task.name);
  const [cwd, setCwd] = useState(task.cwd);
  const [prompt, setPrompt] = useState(task.prompt);
  const [rules, setRules] = useState(task.rules);
  const [type, setType] = useState<ScheduleType>(task.schedule.type);
  const [time, setTime] = useState(task.schedule.time ?? "09:00");
  const [everyMinutes, setEveryMinutes] = useState(
    task.schedule.everyMinutes ?? 60,
  );
  const [atLocal, setAtLocal] = useState(toLocalInput(task.schedule.at));
  // Calendar defaults follow "today" so the common case needs no adjustment.
  const [weekdays, setWeekdays] = useState<number[]>(
    task.schedule.weekdays?.length ? task.schedule.weekdays : [now.getDay()],
  );
  const [monthDay, setMonthDay] = useState<number>(
    task.schedule.monthDay ?? now.getDate(),
  );
  const [month, setMonth] = useState<number>(
    task.schedule.month ?? now.getMonth() + 1,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // Per-task execution model. Null key ⇒ follow the global default model.
  const [modelKey, setModelKey] = useState<string>(
    task.model ? modelKeyOf(task.model) : "",
  );
  const [permissionMode, setPermissionMode] = useState<"yolo" | "ask">(
    task.permissionMode ?? "yolo",
  );
  const [imPushInstanceId, setImPushInstanceId] = useState(
    task.imPushInstanceId ?? "",
  );
  const [imChannels, setImChannels] = useState<{ id: string; name: string }[]>([]);
  const [availableModels, setAvailableModels] = useState<ModelItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    window.piDesk
      .getAvailableModels()
      .then((list) => {
        if (!cancelled && Array.isArray(list)) {
          setAvailableModels(
            list
              .filter((m: any) => m && m.id && m.provider)
              .map((m: any) => ({
                id: String(m.id),
                name: m.name ? String(m.name) : String(m.id),
                provider: String(m.provider),
              })),
          );
        }
      })
      .catch(() => {
        /* model list unavailable — leave empty, default option still works */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load IM channel instances for the "push result to" selector.
  useEffect(() => {
    let cancelled = false;
    window.piDesk
      .imGetConfig()
      .then((cfg: { channels?: { id: string; name: string; enabled?: boolean }[] }) => {
        if (cancelled || !cfg?.channels) return;
        setImChannels(
          cfg.channels
            .filter((c: any) => c?.enabled && c?.id)
            .map((c: any) => ({ id: String(c.id), name: String(c.name) })),
        );
      })
      .catch(() => {
        /* no IM config — leave selector empty */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Group models by provider for the dropdown. */
  const modelsByProvider = availableModels.reduce<Record<string, ModelItem[]>>(
    (acc, m) => {
      (acc[m.provider] ||= []).push(m);
      return acc;
    },
    {},
  );

  const browse = async () => {
    try {
      const p = await window.piDesk.pickWorkspace();
      if (p) setCwd(p);
    } catch {
      /* picker cancelled or unavailable */
    }
  };

  const toggleWeekday = (d: number) => {
    setWeekdays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort(),
    );
  };

  /** Switching month must not leave an impossible day selected (e.g. Feb 31). */
  const changeMonth = (m: number) => {
    setMonth(m);
    if (monthDay !== LAST_DAY_OF_MONTH && monthDay > MONTH_MAX_DAYS[m - 1]) {
      setMonthDay(MONTH_MAX_DAYS[m - 1]);
    }
  };

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = t("scheduled.nameRequired");
    if (!prompt.trim()) e.prompt = t("scheduled.promptRequired");
    if (TIME_BASED.includes(type) && !time) e.time = t("scheduled.timeRequired");
    if (type === "interval" && (!everyMinutes || everyMinutes <= 0))
      e.everyMinutes = t("scheduled.minutesRequired");
    if (type === "once" && !atLocal) e.at = t("scheduled.atRequired");
    if (type === "weekly" && weekdays.length === 0)
      e.weekdays = t("scheduled.weekdaysRequired");
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;
    setSaving(true);
    const usesTime = TIME_BASED.includes(type);
    const schedule: TaskSchedule = {
      type,
      time: usesTime ? time : null,
      everyMinutes: type === "interval" ? Number(everyMinutes) : null,
      at: type === "once" && atLocal ? new Date(atLocal).toISOString() : null,
      weekdays: type === "weekly" ? [...weekdays].sort((a, b) => a - b) : null,
      monthDay: type === "monthly" || type === "yearly" ? monthDay : null,
      month: type === "yearly" ? month : null,
      // Not exposed in the form yet — carry the existing value through so a
      // plain edit doesn't silently reset the missed-window policy.
      catchUp: task.schedule.catchUp,
    };
    try {
      onSave({
        ...task,
        name: name.trim(),
        cwd: cwd.trim(),
        prompt: prompt.trim(),
        rules: rules.trim(),
        schedule,
        model: modelKey ? parseModelKey(modelKey) : null,
        permissionMode,
        imPushInstanceId: imPushInstanceId || undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const dayOptions = () => {
    const max = type === "yearly" ? MONTH_MAX_DAYS[month - 1] : 31;
    return Array.from({ length: max }, (_, i) => i + 1);
  };

  return (
    <div className={styles.modalOverlay} onClick={onCancel}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <h3>{isNew ? t("scheduled.createTitle") : t("scheduled.editorTitle")}</h3>
          <button className={styles.iconBtn} onClick={onCancel} title={t("close")}>
            <X size={16} />
          </button>
        </div>

        <div className={styles.form}>
          {/* Name */}
          <label className={styles.field}>
            <span className={styles.label}>
              {t("scheduled.name")}
              {errors.name && <em className={styles.err}>{errors.name}</em>}
            </span>
            <input
              className={styles.input}
              value={name}
              placeholder={t("scheduled.namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          {/* Working directory */}
          <label className={styles.field}>
            <span className={styles.label}>{t("scheduled.cwd")}</span>
            <div className={styles.cwdRow}>
              <input
                className={styles.input}
                value={cwd}
                placeholder={t("scheduled.cwdPlaceholder")}
                onChange={(e) => setCwd(e.target.value)}
              />
              <button className={styles.browseBtn} onClick={browse} type="button">
                {t("scheduled.browse")}
              </button>
            </div>
          </label>

          {/* Prompt */}
          <label className={styles.field}>
            <span className={styles.label}>
              {t("scheduled.prompt")}
              {errors.prompt && <em className={styles.err}>{errors.prompt}</em>}
            </span>
            <textarea
              className={styles.textarea}
              rows={3}
              value={prompt}
              placeholder={t("scheduled.promptPlaceholder")}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <div className={styles.promptToolbar}>
              <div className={styles.toolbarGroup}>
                <span className={styles.toolbarLabel}>{t("scheduled.model")}</span>
                <select
                  className={styles.toolbarSelect}
                  value={modelKey}
                  onChange={(e) => setModelKey(e.target.value)}
                >
                  <option value="">{t("scheduled.modelDefault")}</option>
                  {Object.entries(modelsByProvider).map(([provider, models]) => (
                    <optgroup key={provider} label={provider}>
                      {models.map((m) => (
                        <option key={modelKeyOf(m)} value={modelKeyOf(m)}>
                          {m.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
              <div className={styles.toolbarGroup}>
                <span className={styles.toolbarLabel}>
                  {t("scheduled.permission")}
                </span>
                <select
                  className={styles.toolbarSelect}
                  value={permissionMode}
                  onChange={(e) =>
                    setPermissionMode(e.target.value as "yolo" | "ask")
                  }
                >
                  <option value="yolo">{t("scheduled.permissionYolo")}</option>
                  <option value="ask">{t("scheduled.permissionAsk")}</option>
                </select>
              </div>
              <div className={styles.toolbarGroup}>
                <span className={styles.toolbarLabel}>
                  {t("scheduled.imPush")}
                </span>
                <select
                  className={styles.toolbarSelect}
                  value={imPushInstanceId}
                  onChange={(e) => setImPushInstanceId(e.target.value)}
                >
                  <option value="">{t("scheduled.imPushNone")}</option>
                  {imChannels.map((ch) => (
                    <option key={ch.id} value={ch.id}>
                      {ch.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </label>

          {/* Rules */}
          <label className={styles.field}>
            <span className={styles.label}>{t("scheduled.rules")}</span>
            <textarea
              className={styles.textarea}
              rows={3}
              value={rules}
              placeholder={t("scheduled.rulesPlaceholder")}
              onChange={(e) => setRules(e.target.value)}
            />
          </label>

          {/* Schedule type */}
          <label className={styles.field}>
            <span className={styles.label}>{t("scheduled.schedule")}</span>
            <div className={styles.seg}>
              {SCHEDULE_TYPES.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className={`${styles.segBtn} ${type === opt ? styles.segActive : ""}`}
                  onClick={() => setType(opt)}
                >
                  {t(`scheduled.schedule.${opt}`)}
                </button>
              ))}
            </div>
          </label>

          {/* interval: every N minutes */}
          {type === "interval" && (
            <label className={styles.field}>
              <span className={styles.label}>
                {t("scheduled.everyMinutes")}
                {errors.everyMinutes && (
                  <em className={styles.err}>{errors.everyMinutes}</em>
                )}
              </span>
              <div className={styles.cwdRow}>
                <input
                  type="number"
                  min={1}
                  className={styles.input}
                  value={everyMinutes}
                  onChange={(e) => setEveryMinutes(Number(e.target.value))}
                />
                <span className={styles.unit}>{t("scheduled.minutes")}</span>
              </div>
            </label>
          )}

          {/* weekly: which days */}
          {type === "weekly" && (
            <div className={styles.field}>
              <span className={styles.label}>
                {t("scheduled.weekdays")}
                {errors.weekdays && (
                  <em className={styles.err}>{errors.weekdays}</em>
                )}
              </span>
              <div className={styles.chipRow}>
                {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={`${styles.chip} ${
                      weekdays.includes(d) ? styles.chipActive : ""
                    }`}
                    onClick={() => toggleWeekday(d)}
                    aria-pressed={weekdays.includes(d)}
                  >
                    {t(`scheduled.weekdayShort.${d}`)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* yearly: which month */}
          {type === "yearly" && (
            <label className={styles.field}>
              <span className={styles.label}>{t("scheduled.month")}</span>
              <select
                className={styles.input}
                value={month}
                onChange={(e) => changeMonth(Number(e.target.value))}
              >
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <option key={m} value={m}>
                    {t(`scheduled.monthName.${m}`)}
                  </option>
                ))}
              </select>
            </label>
          )}

          {/* monthly / yearly: which day of month */}
          {(type === "monthly" || type === "yearly") && (
            <label className={styles.field}>
              <span className={styles.label}>{t("scheduled.dayOfMonth")}</span>
              <select
                className={styles.input}
                value={monthDay}
                onChange={(e) => setMonthDay(Number(e.target.value))}
              >
                {type === "monthly" && (
                  <option value={LAST_DAY_OF_MONTH}>
                    {t("scheduled.lastDay")}
                  </option>
                )}
                {dayOptions().map((d) => (
                  <option key={d} value={d}>
                    {t("scheduled.dayValue", { n: d })}
                  </option>
                ))}
              </select>
              {type === "monthly" && monthDay > 28 && (
                <span className={styles.hint}>{t("scheduled.shortMonthHint")}</span>
              )}
            </label>
          )}

          {/* Shared time-of-day input */}
          {TIME_BASED.includes(type) && (
            <label className={styles.field}>
              <span className={styles.label}>
                {t("scheduled.time")}
                {errors.time && <em className={styles.err}>{errors.time}</em>}
              </span>
              <input
                type="time"
                className={styles.input}
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </label>
          )}

          {/* once: exact moment */}
          {type === "once" && (
            <label className={styles.field}>
              <span className={styles.label}>
                {t("scheduled.at")}
                {errors.at && <em className={styles.err}>{errors.at}</em>}
              </span>
              <input
                type="datetime-local"
                className={styles.input}
                value={atLocal}
                onChange={(e) => setAtLocal(e.target.value)}
              />
            </label>
          )}
        </div>

        <div className={styles.modalFooter}>
          <button className={styles.btnGhost} onClick={onCancel}>
            {t("cancel")}
          </button>
          <button
            className={styles.primaryBtn}
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? t("scheduled.saving") : t("scheduled.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
