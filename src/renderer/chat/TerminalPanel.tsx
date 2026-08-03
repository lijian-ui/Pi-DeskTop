import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { Plus } from "lucide-react";
import { useUIStore } from "../store/ui-store";
import { useWorkspaceStore } from "../store/workspace-store";
import { useTranslation } from "react-i18next";
import styles from "./TerminalPanel.module.css";

type Shell = "gitbash" | "powershell" | "cmd";

const SHELL_OPTIONS: { value: Shell; label: string }[] = [
  { value: "gitbash", label: "Git Bash" },
  { value: "powershell", label: "PowerShell" },
  { value: "cmd", label: "Command Prompt" },
];

// 16-color ANSI palettes so `ls --color` / git diff render with contrast in
// both themes. Tuned for a dark and a light background respectively.
const DARK_PALETTE = {
  black: "#282c34",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#abb2bf",
  brightBlack: "#5c6370",
  brightRed: "#ef6e7e",
  brightGreen: "#a3d978",
  brightYellow: "#f0c674",
  brightBlue: "#7ab8f5",
  brightMagenta: "#d68adf",
  brightCyan: "#6fd0dc",
  brightWhite: "#d7dae0",
};

const LIGHT_PALETTE = {
  black: "#3b4252",
  red: "#bf616a",
  green: "#a3be8c",
  yellow: "#ebcb8b",
  blue: "#81a1c1",
  magenta: "#b48ead",
  cyan: "#8fbcbb",
  white: "#4c566a",
  brightBlack: "#4c566a",
  brightRed: "#bf616a",
  brightGreen: "#a3be8c",
  brightYellow: "#ebcb8b",
  brightBlue: "#81a1c1",
  brightMagenta: "#b48ead",
  brightCyan: "#8fbcbb",
  brightWhite: "#2e3440",
};

function buildTheme(): ITheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  const dark = document.documentElement.getAttribute("data-theme") !== "light";
  const background = v("--bg-base-default") || (dark ? "#1a1b1d" : "#ffffff");
  const foreground = v("--text-default") || (dark ? "#e6e6e6" : "#1a1a1a");
  return {
    background,
    foreground,
    cursor: v("--text-default") || foreground,
    cursorAccent: background,
    selectionBackground: v("--bg-brand-subtle") || "rgba(120,120,255,0.30)",
    ...(dark ? DARK_PALETTE : LIGHT_PALETTE),
  };
}

export default function TerminalPanel({ visible }: { visible: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const idRef = useRef<string | null>(null);

  const [shell, setShell] = useState<Shell>("gitbash");
  const [exited, setExited] = useState<number | null>(null);
  // null = detection not finished yet; array = shells actually installed.
  const [available, setAvailable] = useState<Shell[] | null>(null);
  // Floating "Add to chat" button shown above a terminal text selection.
  // Mirrors the file-preview flow: click hands a CodeAttachment (kind:
  // "terminal") to the composer, so the pill/card/send pipeline is reused.
  const [floatBtn, setFloatBtn] = useState<{
    top: number;
    left: number;
    content: string;
  } | null>(null);
  const floatBtnRef = useRef<HTMLButtonElement>(null);

  const cwd = useWorkspaceStore((s) => s.cwd);
  const setTerminalOpen = useUIStore((s) => s.setTerminalOpen);
  const terminalWidth = useUIStore((s) => s.terminalWidth);
  const setTerminalWidth = useUIStore((s) => s.setTerminalWidth);
  const { t } = useTranslation();

  // Keep the latest cwd accessible inside the (stable) pty-create callback.
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  // Drag the divider between chat and terminal to resize the terminal column.
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = terminalWidth;
    const onMove = (ev: MouseEvent) => {
      // Drag left (startX > ev.clientX) widens the terminal on the right.
      const next = Math.min(820, Math.max(300, startWidth + (startX - ev.clientX)));
      setTerminalWidth(next);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  // Detect which shells are actually installed, and whether a terminal is
  // already running (so we re-attach to the same session on reopen instead of
  // spawning a fresh one). Git Bash is hidden if not installed.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      window.piDesk.terminal.getAvailableShells(),
      window.piDesk.terminal.getActive(),
    ])
      .then(([list, active]) => {
        if (cancelled) return;
        setAvailable(list);
        // Prefer the already-running shell; else default to Git Bash (or the
        // first available option). This makes the panel reopen on the same
        // live terminal the user left running.
        const initial =
          active && list.includes(active)
            ? active
            : list.includes("gitbash")
              ? "gitbash"
              : (list[0] ?? "powershell");
        setShell(initial);
      })
      .catch(() => {
        // Detection failed: fall back to showing every option (old behavior).
        if (!cancelled) setAvailable(["gitbash", "powershell", "cmd"]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 1) Create the xterm instance once; wire input/resize and auto-fit.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: 'monospace, "Cascadia Code", "Fira Code", Consolas, "Courier New"',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: buildTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(container);
    try {
      fit.fit();
    } catch {
      /* container not measured yet */
    }
    // GPU rendering where available; degrade silently otherwise.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      /* WebGL unavailable */
    }

    termRef.current = term;
    fitRef.current = fit;

    term.onData((data) => {
      const id = idRef.current;
      if (id) window.piDesk.terminal.input(id, data);
    });
    term.onResize(({ cols, rows }) => {
      const id = idRef.current;
      if (id) window.piDesk.terminal.resize(id, cols, rows);
    });

    const ro = new ResizeObserver(() => {
      // Skip while hidden (display:none): dimensions are zero and fitting would
      // shrink the PTY to nothing. ResizeObserver fires again once it's shown.
      if (container.offsetParent === null) return;
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    });
    ro.observe(container);

    // Re-apply theme when the app switches light/dark.
    const mo = new MutationObserver(() => {
      term.options.theme = buildTheme();
    });
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => {
      ro.disconnect();
      mo.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // 2) Create (or re-attach to) the backend pty over IPC.
  // The PTY lives in the main process and is intentionally NOT killed when the
  // panel closes — only on an explicit shell switch or when the process exits.
  // That is what keeps a running command (e.g. `npm install`) alive across
  // close/open cycles.
  const attachPty = useCallback(
    (sh: Shell) => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
      let offOut: (() => void) | null = null;
      let offExit: (() => void) | null = null;
      let cancelled = false;

      window.piDesk.terminal
        .create({ shell: sh, cwd: cwdRef.current, cols: term.cols, rows: term.rows })
        .then((res) => {
          if (cancelled) {
            // Panel unmounted/changed before spawn resolved: drop the new pty.
            window.piDesk.terminal.kill(res.id);
            return;
          }
          idRef.current = res.id;
          setExited(null);
          offOut = window.piDesk.onTerminalOutput((id, data) => {
            if (id === idRef.current) term.write(data);
          });
          offExit = window.piDesk.onTerminalExit((id, code) => {
            if (id === idRef.current) setExited(code);
          });
        })
        .catch((err) => {
          term.write(
            `\r\n\x1b[31m${t("terminal.failedToStart")}: ${String(err)}\x1b[0m\r\n`
          );
        });

      // Cleanup on unmount / shell change: only unsubscribe from IPC. We do
      // NOT kill the pty here — closing the panel must leave it running.
      return () => {
        cancelled = true;
        offOut?.();
        offExit?.();
      };
    },
    [t]
  );

  // Switching the shell dropdown is an explicit user action: kill the previous
  // session (the main process will spawn a new one for the chosen shell).
  const handleShellChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value as Shell;
    if (next === shell) return;
    const oldId = idRef.current;
    if (oldId) window.piDesk.terminal.kill(oldId);
    idRef.current = null;
    setShell(next);
  };

  useEffect(() => {
    // Wait until shell detection finishes, and never spawn an unavailable one.
    if (!available || !available.includes(shell)) return;
    return attachPty(shell);
  }, [shell, available, attachPty, cwd]);

  // 3) Selection → floating "Add to chat" button. xterm renders to canvas so
  // there is no DOM selection; we read term.getSelection() on mouseup inside
  // the terminal body and position the button at the pointer. The button
  // hides when the selection is cleared, on scroll, or on outside mousedown.
  useEffect(() => {
    const container = containerRef.current;
    const panel = panelRef.current;
    if (!container || !panel) return;

    const onMouseUp = (e: MouseEvent) => {
      // Ignore the mouseup that ends a click on the floating button itself.
      if (floatBtnRef.current && floatBtnRef.current.contains(e.target as Node)) return;
      // xterm finalizes the selection in its own mouseup handler; read it on
      // the next frame so getSelection() is up to date.
      requestAnimationFrame(() => {
        const term = termRef.current;
        const sel = term?.getSelection() ?? "";
        if (!sel.trim()) {
          setFloatBtn(null);
          return;
        }
        const panelRect = panel.getBoundingClientRect();
        // Clamp inside the panel so the button never hides under the header
        // (32px) or overflows the panel's left/right edge.
        const top = Math.max(e.clientY - panelRect.top, 44);
        const left = Math.min(
          Math.max(e.clientX - panelRect.left, 70),
          panelRect.width - 70
        );
        setFloatBtn({ top, left, content: sel });
      });
    };

    // Hide when clicking anywhere outside the button (keyboard input, another
    // selection start, clicks elsewhere in the app, ...).
    const onDocMouseDown = (e: MouseEvent) => {
      if (floatBtnRef.current && floatBtnRef.current.contains(e.target as Node)) return;
      setFloatBtn(null);
    };

    container.addEventListener("mouseup", onMouseUp);
    document.addEventListener("mousedown", onDocMouseDown);
    return () => {
      container.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("mousedown", onDocMouseDown);
    };
  }, []);

  // Typing or any terminal output scroll should also drop the button: hide it
  // whenever the selection itself is cleared by xterm.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const d = term.onSelectionChange(() => {
      if (!term.hasSelection()) setFloatBtn(null);
    });
    return () => d.dispose();
    // Effects run in declaration order, so the mount effect above has already
    // created the Terminal instance when this runs.
  }, []);

  // When the panel is shown again after being hidden, the container has a real
  // size once more — re-fit so the PTY gets correct dimensions. (While hidden
  // it is display:none, so fitting would compute zero rows/cols.)
  useEffect(() => {
    if (!visible) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    const raf = requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  return (
    <div
      ref={panelRef}
      className={`${styles.terminalPanel} ${visible ? "" : styles.hidden}`}
      style={{ width: terminalWidth }}
    >
      <div
        className={styles.resizeHandle}
        onMouseDown={startResize}
        title={t("terminal.resize")}
      />
      <div className={styles.header}>
        <select
          className={styles.shellSelect}
          value={shell}
          onChange={handleShellChange}
          title={t("terminal.shell")}
          disabled={available === null}
        >
          {(available ? SHELL_OPTIONS.filter((o) => available.includes(o.value)) : SHELL_OPTIONS).map(
            (o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            )
          )}
        </select>
        {exited !== null && (
          <span className={styles.exitBadge}>
            {t("terminal.exited")} {exited}
          </span>
        )}
        <button
          className={styles.closeBtn}
          onClick={() => setTerminalOpen(false)}
          title={t("terminal.close")}
        >
          ×
        </button>
      </div>
      <div className={styles.terminalBody} ref={containerRef} />
      {floatBtn && (
        <button
          ref={floatBtnRef}
          className={styles.addToChatBtn}
          style={{ top: floatBtn.top, left: floatBtn.left }}
          // Keep the xterm selection alive while clicking the button.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const lineCount = floatBtn.content.split("\n").length;
            useUIStore.getState().addCodeAttachment({
              kind: "terminal",
              filePath: "terminal",
              startLine: 1,
              endLine: lineCount,
              content: floatBtn.content.replace(/\s+$/, ""),
            });
            setFloatBtn(null);
            termRef.current?.clearSelection();
          }}
          title={t("terminal.addToChat")}
        >
          <Plus size={12} />
          <span>{t("terminal.addToChat")}</span>
        </button>
      )}
    </div>
  );
}
