import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown } from "lucide-react";
import type { ToolMode } from "../../preload/api";
import styles from "./ToolModePicker.module.css";

/**
 * Chat-composer tool-mode selector (极简 / 标准 / 办公), a compact pill that
 * sits in the composer toolbar next to the image-attach button. Switching a
 * mode narrows/widens the tool set of THIS workspace only (main process
 * setSessionToolMode) — global settings.activeTools / *-config files are
 * untouched, other workspaces and scheduled sessions keep their own selection.
 * A mode change takes effect on the session's next turn (same mechanism as
 * the 可用工具 page save).
 */
const MODE_ORDER: ToolMode[] = ["minimal", "standard", "office"];

interface ToolModePickerProps {
  /** Focused workspace cwd (the session whose tool set this picker edits). */
  cwd: string;
}

export default function ToolModePicker({ cwd }: ToolModePickerProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<ToolMode | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Load the mode of the focused workspace. Null cwd (edge) → standard.
  useEffect(() => {
    let alive = true;
    setMode(null);
    if (!cwd) return;
    window.piDesk
      .getSessionToolMode(cwd)
      .then((m) => {
        if (alive) setMode(m);
      })
      .catch(() => {
        if (alive) setMode("standard");
      });
    return () => {
      alive = false;
    };
  }, [cwd]);

  // Outside click closes the menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = async (m: ToolMode) => {
    if (m === mode || busy || !cwd) return;
    setBusy(true);
    try {
      await window.piDesk.setSessionToolMode(cwd, m);
      setMode(m);
    } catch {
      // Keep the previous mode on failure; the next reload will re-sync.
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  const modeLabel = mode ? t(`tools.mode.${mode}`) : "…";

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={styles.modePill}
        onClick={() => setOpen((v) => !v)}
        disabled={!cwd || busy}
        title={t("tools.mode.hint")}
      >
        <span>{modeLabel}</span>
        <ChevronDown size={11} className={open ? styles.chevronOpen : ""} />
      </button>
      {open && (
        <div className={styles.modeMenu} role="menu">
          {MODE_ORDER.map((m) => {
            const active = mode === m;
            return (
              <button
                key={m}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={styles.modeItem}
                onClick={() => void pick(m)}
              >
                <span className={styles.modeItemMain}>
                  <span className={styles.modeItemName}>
                    {t(`tools.mode.${m}`)}
                  </span>
                  {active && (
                    <Check size={12} className={styles.modeItemCheck} />
                  )}
                </span>
                <span className={styles.modeItemDesc}>
                  {t(`tools.mode.${m}Desc`)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
