import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PersonaEntry } from "../../preload/api";
import styles from "./SoulSettings.module.css";

/**
 * 助手设置 —— 人设（Soul）+ 开场白（Preamble）。
 *
 * 两者数据模型完全同构（见 PersonaSection）：条目库落
 * `~/.pi/agent/souls|preambles/<name>.md`，生效文件落 `~/.pi/agent/soul.md` /
 * `preamble.md`（注入钩子每回合重读）。「应用为生效」把当前编辑内容写进
 * 生效文件；「生效中」标记 = 生效内容与条目内容精确匹配（无需状态文件）。
 */

/** 人设条目在 UI 里的展示状态（生效中徽标用）。 */
function activeEntryOf(entries: PersonaEntry[], active: string): PersonaEntry | undefined {
  return entries.find((e) => e.content === active);
}

/** 单个区块（Soul 或 Preamble）—— 条目库 + 编辑器 + 应用。 */
function PersonaSection({ kind }: { kind: "soul" | "preamble" }) {
  const { t } = useTranslation();
  const isSoul = kind === "soul";

  const api = isSoul
    ? {
        list: () => window.piDesk.listSoulEntries(),
        get: () => window.piDesk.getSoul(),
        apply: (text: string) => window.piDesk.saveSoul(text),
        saveEntry: (name: string, text: string) => window.piDesk.saveSoulEntry(name, text),
        deleteEntry: (name: string) => window.piDesk.deleteSoulEntry(name),
      }
    : {
        list: () => window.piDesk.listPreambleEntries(),
        get: () => window.piDesk.getPreamble(),
        apply: (text: string) => window.piDesk.savePreamble(text),
        saveEntry: (name: string, text: string) => window.piDesk.savePreambleEntry(name, text),
        deleteEntry: (name: string) => window.piDesk.deletePreambleEntry(name),
      };

  const [entries, setEntries] = useState<PersonaEntry[]>([]);
  const [active, setActive] = useState(""); // 生效文件原文（soul.md / preamble.md）
  const [selected, setSelected] = useState<string | null>(null); // 正在编辑的条目；null = 未入库草稿
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [nameInput, setNameInput] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [list, activeText] = await Promise.all([api.list(), api.get()]);
        if (cancelled) return;
        setEntries(list);
        setActive(activeText);
        // 默认选中"当前生效"的条目（内容匹配）；未入库内容（手改/模型改过）原样进编辑器。
        const matched = list.find((e) => e.content === activeText);
        setSelected(matched ? matched.name : null);
        setText(matched ? matched.content : activeText);
      } catch {
        if (!cancelled) setError(t("soul.loading"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // 仅挂载时加载一次；api 是按 kind 固定的纯函数对象。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flash = useCallback(
    (msg: string) => {
      setNotice(msg);
      setTimeout(() => setNotice(""), 2000);
    },
    [],
  );

  /** 应用：把当前编辑内容写进生效文件（选中条目时同步写回条目，保持库与生效一致）。 */
  const handleApply = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      if (selected) await api.saveEntry(selected, text);
      await api.apply(text);
      setActive(text);
      if (selected) {
        setEntries((prev) => prev.map((e) => (e.name === selected ? { name: e.name, content: text } : e)));
      }
      flash(t("soul.applied"));
    } catch {
      setError(t("soul.applyFailed"));
    } finally {
      setBusy(false);
    }
  }, [api, flash, selected, t, text]);

  /** 新建条目：把当前编辑内容存为 `<name>.md`（不动生效文件）。 */
  const handleCreate = useCallback(async () => {
    const safe = nameInput.trim().replace(/\s+/g, " ").slice(0, 60);
    if (!safe || safe === "." || safe === ".." || safe.startsWith(".") || /[\\/:*?<>|"]/.test(safe)) {
      setError(t("soul.nameInvalid"));
      return;
    }
    if (!text.trim()) {
      setError(t("soul.textEmpty"));
      return;
    }
    if (entries.some((e) => e.name === safe) && !window.confirm(t("soul.overwriteConfirm", { name: safe }))) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.saveEntry(safe, text);
      setEntries((prev) =>
        [...prev.filter((e) => e.name !== safe), { name: safe, content: text }].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      );
      setSelected(safe);
      setCreating(false);
      flash(t("soul.entrySaved"));
    } catch {
      setError(t("soul.opFailed"));
    } finally {
      setBusy(false);
    }
  }, [api, entries, flash, nameInput, t, text]);

  /** 保存条目：只写选中条目文件，不碰生效文件。 */
  const handleSaveEntry = useCallback(async () => {
    if (!selected) return;
    if (!text.trim()) {
      setError(t("soul.textEmpty"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.saveEntry(selected, text);
      setEntries((prev) => prev.map((e) => (e.name === selected ? { name: e.name, content: text } : e)));
      flash(t("soul.entrySaved"));
    } catch {
      setError(t("soul.opFailed"));
    } finally {
      setBusy(false);
    }
  }, [api, flash, selected, t, text]);

  /** 删除条目：只删库文件；生效文件保持原样（删除后状态自然变为"自定义"）。 */
  const handleDelete = useCallback(async () => {
    if (!selected) return;
    if (!window.confirm(t("soul.deleteConfirm", { name: selected }))) return;
    setBusy(true);
    setError("");
    try {
      await api.deleteEntry(selected);
      setEntries((prev) => prev.filter((e) => e.name !== selected));
      setSelected(null);
      flash(t("soul.entryDeleted"));
    } catch {
      setError(t("soul.opFailed"));
    } finally {
      setBusy(false);
    }
  }, [api, entries, flash, selected, t]);

  /** 清空生效：Soul = 未启用人设；Preamble = 恢复 SDK 默认开场白。条目库不动。 */
  const handleClearActive = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      await api.apply("");
      setActive("");
      if (!selected) setText("");
      flash(t(isSoul ? "soul.activeNone" : "preamble.activeDefault"));
    } catch {
      setError(t("soul.applyFailed"));
    } finally {
      setBusy(false);
    }
  }, [api, flash, isSoul, selected, t]);

  if (loading) {
    return (
      <section className={styles.section}>
        <p className={styles.loading}>{t("soul.loading")}</p>
      </section>
    );
  }

  const activeEntry = activeEntryOf(entries, active);
  const statusText = activeEntry
    ? t("soul.activeEntry", { name: activeEntry.name })
    : active.trim()
      ? t("soul.activeCustom")
      : t(isSoul ? "soul.activeNone" : "preamble.activeDefault");

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>{t(isSoul ? "soul.editorTitle" : "preamble.editorTitle")}</h2>
      <p className={styles.sectionDesc}>{t(isSoul ? "soul.desc" : "preamble.desc")}</p>

      {/* 条目库：chip = 条目，徽标 = 生效中；＋ = 新建 */}
      <div className={styles.entryBar}>
        <span className={styles.entriesLabel}>
          {t(isSoul ? "soul.entriesTitle" : "preamble.entriesTitle")}
        </span>
        {entries.map((e) => {
          const isActive = e.content === active;
          return (
            <button
              key={e.name}
              type="button"
              className={`${styles.chip}${e.name === selected ? ` ${styles.chipSelected}` : ""}`}
              onClick={() => {
                setSelected(e.name);
                setText(e.content);
                setError("");
              }}
            >
              {e.name}
              {isActive && <span className={styles.chipBadge}>{t("soul.applied")}</span>}
            </button>
          );
        })}
        {!creating && (
          <button
            type="button"
            className={styles.ghostBtn}
            disabled={busy}
            onClick={() => {
              setCreating(true);
              setNameInput("");
            }}
          >
            ＋ {t("soul.newEntry")}
          </button>
        )}
      </div>

      {creating && (
        <div className={styles.newRow}>
          <input
            className={styles.newInput}
            value={nameInput}
            placeholder={t("soul.entryNamePlaceholder")}
            autoFocus
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreate();
              if (e.key === "Escape") setCreating(false);
            }}
          />
          <button type="button" className={styles.ghostBtn} disabled={busy} onClick={() => void handleCreate()}>
            {t("soul.createEntry")}
          </button>
          <button type="button" className={styles.ghostBtn} onClick={() => setCreating(false)}>
            {t("soul.cancel")}
          </button>
        </div>
      )}

      <textarea
        className={isSoul ? styles.textarea : `${styles.textarea} ${styles.textareaPreamble}`}
        rows={isSoul ? 14 : 10}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t(isSoul ? "soul.placeholder" : "preamble.placeholder")}
      />
      <p className={styles.hint}>{t(isSoul ? "soul.hint" : "preamble.hint")}</p>

      <div className={styles.actions}>
        <button className={styles.saveBtn} disabled={busy} onClick={() => void handleApply()}>
          {t("soul.apply")}
        </button>
        <button
          type="button"
          className={styles.ghostBtn}
          disabled={busy || !selected || !text.trim()}
          onClick={() => void handleSaveEntry()}
        >
          {t("soul.saveEntry")}
        </button>
        <button type="button" className={styles.ghostBtn} disabled={busy || !selected} onClick={() => void handleDelete()}>
          {t("soul.deleteEntry")}
        </button>
        <button
          type="button"
          className={styles.ghostBtn}
          disabled={busy}
          onClick={() => void handleClearActive()}
        >
          {t(isSoul ? "soul.clear" : "preamble.restoreDefault")}
        </button>
        {notice && <span className={styles.notice}>{notice}</span>}
      </div>

      <p className={styles.statusLine}>{statusText}</p>
      {error && <p className={styles.error}>{error}</p>}
    </section>
  );
}

export default function SoulSettings() {
  return (
    <div className={styles.page}>
      <PersonaSection kind="soul" />
      <PersonaSection kind="preamble" />
    </div>
  );
}
