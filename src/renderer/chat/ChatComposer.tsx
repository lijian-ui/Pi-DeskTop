import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import {
  Send,
  Square,
  Pencil,
  X,
  Plus,
  ChevronDown,
  Shield,
  Mic,
  Check,
  Sparkles,
  FolderOpen,
  FolderPlus,
  Folder,
  AlertCircle,
  Code2,
  SquareTerminal,
} from "lucide-react";
import { useAgentStore } from "../store/agent-store";
import { useUIStore } from "../store/ui-store";
import type { CodeAttachment } from "../store/ui-store";
import { useSkillStore } from "../store/skill-store";
import { useWorkspaceStore } from "../store/workspace-store";
import { useSessionStore } from "../store/session-store";
import { useTranslation } from "react-i18next";
import type { SkillInfo } from "../../preload/api";
import { useBashGuardStore, type BashMode } from "../store/bashGuard-store";
import BashApprovalModal from "./BashApprovalModal";
import AtFilePicker, { toRelative } from "./AtFilePicker";
import { preloadDir } from "./atFileCache";
import styles from "./ChatComposer.module.css";

interface ModelItem {
  id: string;
  provider: string;
  name?: string;
}

/** Show a cwd as its last 1–2 path segments so long paths fit in the pill. */
function displayWorkspaceName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return cwd;
  if (parts.length <= 2) return parts.join("/");
  return ".../" + parts.slice(-2).join("/");
}

/** Normalize a path for comparison (forward slashes, no trailing slash). */
function normalizeCwd(raw: string): string {
  return (raw || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Format a token count compactly, e.g. 12345 -> "12.3k". */
function formatTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

/** Map a file path to a (best-effort) highlight.js language id for the fence. */
function langOf(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() || "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

/** Readable file label: basename, middle-truncated if very long. */
function labelOf(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() || filePath;
  if (base.length <= 30) return base;
  return base.slice(0, 18) + "…" + base.slice(-10);
}

/** Build the real text sent to the LLM from a code attachment (fenced block). */
function attachmentToText(a: CodeAttachment): string {
  if (a.kind === "terminal") {
    // Terminal captures have no real path/lines — label them explicitly so
    // the model knows this is console output (often an error to diagnose).
    return `Terminal output:\n\`\`\`text\n${a.content}\n\`\`\``;
  }
  const lr = a.startLine === a.endLine ? `${a.startLine}` : `${a.startLine}-${a.endLine}`;
  return `${a.filePath}:${lr}\n\`\`\`${langOf(a.filePath)}\n${a.content}\n\`\`\``;
}

interface ContextRingProps {
  usage: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
}

/** Small circular progress ring showing current context-window usage. */
function ContextRing({ usage }: ContextRingProps) {
  const { t } = useTranslation();
  const R = 15.5;
  const C = 2 * Math.PI * R;
  const pct = usage.percent;
  const ratio = pct != null ? Math.max(0, Math.min(1, pct / 100)) : 0;
  const offset = C * (1 - ratio);

  // Colour shifts toward warning/danger as usage climbs.
  let color = "var(--bg-brand)";
  if (pct != null) {
    if (pct >= 90) color = "var(--status-error-default)";
    else if (pct >= 75) color = "#f59e0b";
  }

  const title =
    pct != null
      ? `${pct.toFixed(1)}% · ${formatTokens(usage.tokens ?? 0)} / ${formatTokens(
          usage.contextWindow
        )} ${t("chat.contextUsed")}`
      : `${formatTokens(usage.tokens ?? 0)} / ${formatTokens(
          usage.contextWindow
        )} ${t("chat.contextUsed")}`;

  return (
    <div className={styles.contextRing}>
      <svg className={styles.contextRingSvg} viewBox="0 0 36 36">
        <circle
          className={styles.contextRingTrack}
          cx="18"
          cy="18"
          r={R}
        />
        <circle
          className={styles.contextRingFill}
          cx="18"
          cy="18"
          r={R}
          style={{
            strokeDasharray: C,
            strokeDashoffset: offset,
            stroke: color,
          }}
        />
      </svg>
      <span className={styles.contextRingText}>
        {pct != null ? `${Math.round(pct)}%` : "—"}
      </span>
      <span className={styles.contextRingTooltip} role="tooltip">
        {title}
      </span>
    </div>
  );
}


const PERMISSION_MODES: { value: BashMode; label: string; desc: string }[] = [
  { value: "yolo", label: "YOLO", desc: "自动允许所有 bash 命令" },
  { value: "ask", label: "默认询问", desc: "非白名单命令弹窗确认" },
];

/**
 * Detects an active "@mention" reference at the caret: an `@` preceded by the
 * start of the string or whitespace, followed by a whitespace-free token
 * (the query typed so far). Returns the `@` position and the query, or null.
 */
function getActiveMention(
  text: string,
  caret: number
): { atPos: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  const pre = at === 0 ? "" : before[at - 1];
  if (pre && !/\s/.test(pre)) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { atPos: at, query };
}

export default function ChatComposer() {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isStreaming = useAgentStore((s) => s.isStreaming);
  const model = useAgentStore((s) => s.model);
  const error = useAgentStore((s) => s.error);
  const setError = useAgentStore((s) => s.setError);
  const messageQueue = useAgentStore((s) => s.messageQueue);
  const enqueueMessage = useAgentStore((s) => s.enqueueMessage);
  const updateQueuedMessage = useAgentStore((s) => s.updateQueuedMessage);
  const removeQueuedMessage = useAgentStore((s) => s.removeQueuedMessage);
  const clearQueue = useAgentStore((s) => s.clearQueue);
  const isCompacting = useAgentStore((s) => s.isCompacting);
  // "Compaction finished" confirmation banner: shows briefly after a
  // compaction completes, then auto-clears. Driven by compactDoneAt so it
  // survives the isCompacting -> false transition.
  const compactDoneAt = useAgentStore((s) => s.compactDoneAt);
  const compactTokensBefore = useAgentStore((s) => s.compactTokensBefore);
  const compactTokensAfter = useAgentStore((s) => s.compactTokensAfter);

  // ── Context usage (tokens / contextWindow / percent) ──
  const contextUsage = useAgentStore((s) => s.contextUsage);
  const setContextUsage = useAgentStore((s) => s.setContextUsage);

  /** Fetch current context usage from the SDK and push to store. */
  const refreshContextUsage = useCallback(async () => {
    try {
      const res = await window.piDesk.getContextUsage();
      setContextUsage(res ?? null);
    } catch {
      // Silently ignore — not critical if a fetch fails.
    }
  }, [setContextUsage]);

  // Poll on mount + whenever streaming ends (assistant has replied → fresh usage).
  useEffect(() => {
    refreshContextUsage();
  }, [refreshContextUsage]);

  useEffect(() => {
    if (!isStreaming) {
      // Small delay to let the SDK finalize its internal state.
      const timer = setTimeout(refreshContextUsage, 300);
      return () => clearTimeout(timer);
    }
  }, [isStreaming, refreshContextUsage]);

  // Re-fetch context usage whenever the active session changes (switch /
  // new / fork). contextUsage is global state, so without this the ring would
  // keep showing the previous session's numbers until the next LLM reply.
  const currentPath = useSessionStore((s) => s.currentPath);
  const runningPaths = useSessionStore((s) => s.runningPaths);
  const sessions = useSessionStore((s) => s.sessions);
  const chatOnlyCwd = useSessionStore((s) => s.chatOnlyCwd);
  const workspaceCwd = useWorkspaceStore((s) => s.cwd);
  // The cwd backing the focused session (used to route prompts to the right
  // runtime so DIFFERENT cwds run in parallel).
  // Prefer the persisted session's own cwd; fall back to the store's tracked
  // cwd for sessions that have no file on disk yet (brand-new or just bound to
  // a workspace) — otherwise the prompt would be routed to the wrong unit.
  const trackedCwd = useSessionStore((s) => s.currentCwd);
  const currentCwd =
    sessions.find((s) => s.path === currentPath)?.cwd || trackedCwd || workspaceCwd;
  useEffect(() => {
    if (currentPath) {
      setContextUsage(null);
      refreshContextUsage();
    }
  }, [currentPath, refreshContextUsage, setContextUsage]);
  const [showCompactDone, setShowCompactDone] = useState(false);
  useEffect(() => {
    if (!compactDoneAt) return;
    setShowCompactDone(true);
    const timer = setTimeout(() => {
      setShowCompactDone(false);
      useAgentStore.getState().clearCompactDone();
    }, 3500);
    return () => clearTimeout(timer);
  }, [compactDoneAt]);

  // ── Bash permission guard ──
  const bashMode = useBashGuardStore((s) => s.mode);
  const setBashMode = useBashGuardStore((s) => s.setMode);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const permissionRef = useRef<HTMLDivElement>(null);
  const [showYoloConfirm, setShowYoloConfirm] = useState(false);
  const [yoloChecked, setYoloChecked] = useState(false);

  // Skill store (for slash command suggestions) + composer draft injection
  const skills = useSkillStore((s) => s.skills);
  const loadSkills = useSkillStore((s) => s.load);
  const commandFor = useSkillStore((s) => s.commandFor);
  const composerText = useUIStore((s) => s.composerText);
  const setComposerText = useUIStore((s) => s.setComposerText);
  // Code references captured from the file-preview panel.
  const codeAttachments = useUIStore((s) => s.codeAttachments);
  const removeCodeAttachment = useUIStore((s) => s.removeCodeAttachment);
  const clearCodeAttachments = useUIStore((s) => s.clearCodeAttachments);

  // Workspace store (recents dropdown only — there is no global cwd anymore).
  // Anything that needs "the directory the agent is actually working in" must
  // use the FOCUSED session's cwd, which is what `currentCwd` resolves to
  // (a real workspace, or the chat-only fallback for plain tasks).
  const cwd = currentCwd;
  const recents = useWorkspaceStore((s) => s.recents);
  const workspaceLoading = useWorkspaceStore((s) => s.loading);
  const loadWorkspace = useWorkspaceStore((s) => s.load);
  const bindSession = useWorkspaceStore((s) => s.bindSession);
  const createNewSession = useSessionStore((s) => s.createNew);

  // Pending-task state: when set, the current session hasn't been bound to a
  // workspace folder yet (created via nav-level 新建任务). The workspace
  // selector shows a hint so the user knows to pick one.
  const pendingPath = useSessionStore((s) => s.pendingPath);

  // Load skill list once so / commands can suggest them.
  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  // Load workspace state once so the pill + recents are populated.
  useEffect(() => {
    loadWorkspace();
  }, [loadWorkspace]);

  // ── Prefetch while idle ──
  // The model dropdown and the `@` file picker both fetch from the *main*
  // process. While the model is streaming, the main event loop is saturated by
  // the SDK agent loop, so those IPC calls would queue up and the UI would sit
  // on "加载中". We warm both caches now (startup / cwd change, i.e. while
  // idle) so they read instantly during streaming.
  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    preloadDir(cwd).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const models = await window.piDesk.getAvailableModels();
        if (!cancelled) setAvailableModels(models ?? []);
      } catch (err) {
        console.error("Failed to preload models:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // Apply a skill command / suggestion dropped into the composer from
  // elsewhere (e.g. the Skills panel "click to invoke" action, or an empty-state
  // chip). Guard with a ref so we inject once per value and NEVER re-run on
  // every keystroke (depending on `text` here would clobber typed input).
  const injectedRef = useRef<string | null>(null);
  useEffect(() => {
    if (composerText && composerText !== injectedRef.current) {
      injectedRef.current = composerText;
      setText(composerText);
      setComposerText("");
      textareaRef.current?.focus();
    } else if (!composerText) {
      injectedRef.current = null;
    }
  }, [composerText, setComposerText]);

  // ── Model selector state ──
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [availableModels, setAvailableModels] = useState<ModelItem[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // ── Workspace selector state ──
  const [workspaceDropdownOpen, setWorkspaceDropdownOpen] = useState(false);
  const workspaceDropdownRef = useRef<HTMLDivElement>(null);

  // The focused session, and whether it is a still-empty "task" (chat) session
  // that may be bound to a real workspace. Once a task has messages it is
  // locked as a plain chat and the workspace selector is hidden.
  const focusedSession = useMemo(
    () => sessions.find((s) => s.path === currentPath) ?? null,
    [sessions, currentPath]
  );
  const isTaskSession = !!focusedSession &&
    (!focusedSession.cwd ||
      normalizeCwd(focusedSession.cwd) === normalizeCwd(chatOnlyCwd));
  // Any still-empty session may be (re)bound — including one already bound to
  // a workspace, so switching folders before the first message never has to
  // touch the global cwd.
  const canBindWorkspace =
    !!focusedSession && focusedSession.messageCount === 0;
  // After the first message the workspace choice is locked: hide the selector
  // entirely for chat sessions, or show a static (non-interactive) workspace
  // label for already-bound workspace sessions.
  const showWorkspaceSelector =
    !focusedSession || focusedSession.messageCount === 0;

  // The workspace shown in the pill belongs to the FOCUSED session, not to a
  // global cwd (there is none by design).
  const effectiveWorkspace =
    focusedSession && !isTaskSession ? focusedSession.cwd : "";

  const workspaceLabel = useMemo(() => {
    if (pendingPath) return t("workspace.pending");
    if (!effectiveWorkspace) return t("workspace.placeholder");
    return displayWorkspaceName(effectiveWorkspace);
  }, [effectiveWorkspace, pendingPath, t]);

  // Recents that aren't the currently-active workspace.
  const otherRecents = useMemo(
    () => recents.filter((r) => r !== effectiveWorkspace),
    [recents, effectiveWorkspace]
  );

  // Route a chosen directory: bind the empty session to it (per-session, never
  // a global cwd). With no session focused at all, start a new one there.
  const routeWorkspace = async (picked: string) => {
    if (canBindWorkspace && currentPath) {
      await bindSession(currentPath, picked);
    } else {
      await createNewSession(picked);
    }
  };

  const handleToggleWorkspaceDropdown = () => {
    setWorkspaceDropdownOpen((o) => !o);
  };

  const handlePickWorkspace = async () => {
    setWorkspaceDropdownOpen(false);
    const picked = await window.piDesk.pickWorkspace();
    if (!picked) return;
    await routeWorkspace(picked);
  };

  const handleSelectRecent = async (path: string) => {
    setWorkspaceDropdownOpen(false);
    await routeWorkspace(path);
  };

  // Close workspace dropdown on outside click
  useEffect(() => {
    if (!workspaceDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        workspaceDropdownRef.current &&
        !workspaceDropdownRef.current.contains(e.target as Node)
      ) {
        setWorkspaceDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [workspaceDropdownOpen]);

  // Close permission dropdown on outside click
  useEffect(() => {
    if (!permissionOpen) return;
    const handler = (e: MouseEvent) => {
      if (permissionRef.current && !permissionRef.current.contains(e.target as Node)) {
        setPermissionOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [permissionOpen]);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [text, adjustHeight]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  // ── Slash menu: built-in commands + skills ──
  // Matches "/query" (skills may also be written as "/skill:query") while the
  // user hasn't typed a space yet.
  const slashMatch = text.match(/^\/(?:skill:)?(.*)$/);
  const slashQuery = slashMatch && !text.includes(" ") ? slashMatch[1].toLowerCase() : null;
  const showSlash = slashQuery !== null;

  type CommandEntry = { kind: "command"; name: string; description: string };
  type SkillEntry = { kind: "skill"; info: SkillInfo };
  type SlashEntry = CommandEntry | SkillEntry;

  // Built-in slash commands (e.g. /compact). Extend this list to add commands.
  const COMMANDS: { name: string; description: string }[] = [
    { name: "compact", description: t("slash.compactDesc") },
  ];

  const commandEntries: CommandEntry[] = COMMANDS.filter((c) =>
    c.name.toLowerCase().includes(slashQuery ?? "")
  ).map((c) => ({ kind: "command", name: c.name, description: c.description }));
  const skillEntries: SkillEntry[] = showSlash
    ? skills
        .filter((s) => s.name.toLowerCase().includes(slashQuery!))
        .map((info) => ({ kind: "skill", info }))
    : [];
  const entries: SlashEntry[] = [...commandEntries, ...skillEntries];
  const slashOpen = showSlash && entries.length > 0;

  // ── "@" file / folder reference picker ──
  const [mentionOpen, setMentionOpen] = useState(false);
  const mentionPosRef = useRef(0);
  const mentionEndRef = useRef(0);

  useEffect(() => {
    setActiveIdx(0);
  }, [slashQuery, entries.length]);

  const selectEntry = useCallback(
    (entry: SlashEntry) => {
      if (entry.kind === "skill") {
        setText(commandFor(entry.info));
      } else {
        setText("/" + entry.name);
      }
      setActiveIdx(0);
      textareaRef.current?.focus();
    },
    [commandFor]
  );

  // Insert the picked files/folders as `@relative/path` references at the
  // position of the triggering "@".
  const handleAtConfirm = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) {
        setMentionOpen(false);
        return;
      }
      const refs = paths.map((p) => "@" + toRelative(cwd, p)).join(" ");
      const pos = mentionPosRef.current;
      const end = mentionEndRef.current;
      setText((prev) => {
        const next = prev.slice(0, pos) + refs + (end < prev.length ? prev.slice(end) : "");
        return next;
      });
      setMentionOpen(false);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          const caretPos = pos + refs.length;
          el.focus();
          el.setSelectionRange(caretPos, caretPos);
        }
      });
    },
    [cwd]
  );

  // Cancel: drop the stray "@" we left in the text.
  const handleAtClose = useCallback(() => {
    const pos = mentionPosRef.current;
    setText((prev) => {
      if (pos >= 0 && pos < prev.length && prev[pos] === "@") {
        return prev.slice(0, pos) + prev.slice(pos + 1);
      }
      return prev;
    });
    setMentionOpen(false);
    textareaRef.current?.focus();
  }, []);

  const handleSend = () => {
    if (!text.trim() && codeAttachments.length === 0) return;
    setError(null);
    const body = text.trim();
    // Snapshot attachments, then clear them so the composer resets regardless
    // of which send path we take below.
    const attachments = [...codeAttachments];
    setText("");
    clearCodeAttachments();

    // The real payload sent to the LLM: the user's text plus each code
    // reference expanded into a fenced block. The composer itself only shows
    // the compact pills — the model still receives the literal source.
    const refsText = attachments.map(attachmentToText).join("\n\n");
    const fullBody = [body, refsText].filter(Boolean).join("\n\n");

    // Manual context compaction: `/compact [instructions]`. Handled by the SDK
    // session.compact(), NOT as a normal LLM prompt, and not shown as a user
    // message bubble. Any text after "/compact " becomes custom instructions.
    const compactMatch = body.match(/^\/compact(?:\s+(.*))?$/);
    if (compactMatch) {
      const instructions = (compactMatch[1] ?? "").trim();
      window.piDesk
        .compact(instructions || undefined)
        .then((res) => {
          if (res && !res.ok) {
            if (res.reason === "too_small") {
              setError(t("chat.nothingToCompact"));
            } else if (res.reason === "already_compacted") {
              setError(t("chat.alreadyCompacted"));
            } else {
              setError(t("chat.failedToCompact"));
            }
          }
        })
        .catch((err: any) => setError(err?.message ?? t("chat.failedToCompact")))
        .finally(() => useAgentStore.getState().setCompacting(false));
      return;
    }

    // While a reply is streaming, don't interrupt it — queue the message so it
    // auto-sends in order once the current reply finishes (see useAgentSession).
    // Reflect both the focused session's live streaming flag AND whether this
    // session is currently running in the background (cwd-level concurrency),
    // so a queued send is used even right after focusing a running task.
    if (isStreaming || (currentPath ? runningPaths.has(currentPath) : false)) {
      enqueueMessage(fullBody);
      return;
    }
    window.piDesk.prompt(fullBody, undefined, currentCwd, currentPath ?? undefined).catch((err: any) => {
      setError(err?.message ?? t("chat.failedToSend"));
    });
  };

  const handleStop = () => {
    // A manual stop halts everything: clear the pending queue (otherwise the
    // queued messages would auto-send right after the run settles) and abort.
    clearQueue();
    window.piDesk.abort(currentCwd).catch((err: any) => {
      setError(err?.message ?? t("chat.failedToStop"));
    });
  };

  const startEditQueueItem = (id: string, content: string) => {
    setEditingId(id);
    setEditText(content);
  };

  const commitEditQueueItem = (id: string, fallback: string) => {
    const trimmed = editText.trim();
    updateQueuedMessage(id, trimmed || fallback);
    setEditingId(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, entries.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectEntry(entries[activeIdx]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setText(text.split(" ")[0]);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleToggleDropdown = async () => {
    if (dropdownOpen) {
      setDropdownOpen(false);
      return;
    }
    // The model list is preloaded on mount / cwd change into `availableModels`,
    // so in the common case we open instantly from cache without blocking on a
    // main-process IPC call (which would sit on "加载中" during streaming).
    // Only fetch-and-show-loading if the cache is still empty (rare cold path).
    if (availableModels.length === 0) {
      setLoadingModels(true);
      try {
        const models = await window.piDesk.getAvailableModels();
        setAvailableModels(models ?? []);
      } catch (err) {
        console.error("Failed to load models:", err);
      } finally {
        setLoadingModels(false);
      }
    }
    setDropdownOpen(true);
  };

  const handleSelectModel = async (provider: string, modelId: string) => {
    try {
      await window.piDesk.setModel(provider, modelId);
      setDropdownOpen(false);
      // Refresh store from state
      const state = await window.piDesk.getState();
      if (state?.model) {
        useAgentStore.getState().setModel(state.model);
      }
    } catch (err) {
      console.error("Failed to set model:", err);
      setError(err instanceof Error ? err.message : "Failed to set model");
    }
  };

  // Group models by provider
  const groupedModels: Record<string, ModelItem[]> = {};
  for (const m of availableModels) {
    const key = m.provider || "unknown";
    if (!groupedModels[key]) groupedModels[key] = [];
    groupedModels[key].push(m);
  }

  const currentLabel = model?.name
    ? model.name
    : model
      ? `${model.provider ?? ""}/${model.id ?? ""}`
      : t("chat.selectModel");

  return (
    <div className={styles.composer}>
      <BashApprovalModal />
      {(isCompacting || showCompactDone) && (
        <div className={styles.statusBars}>
          {isCompacting && (
            <div className={styles.compactingBar}>
              <span className={styles.compactDots} aria-hidden>
                <span></span>
                <span></span>
                <span></span>
              </span>
              <span>{t("chat.compacting")}</span>
            </div>
          )}
          {showCompactDone && (
            <div className={styles.compactDoneBar}>
              <Check size={12} />
              <span>
                {t("chat.compacted")}
                {compactTokensBefore != null && (
                  <span className={styles.compactTokens}>
                    {" "}
                    {formatTokens(compactTokensBefore)}
                    {compactTokensAfter != null && <> → {formatTokens(compactTokensAfter)}</>}
                  </span>
                )}
              </span>
            </div>
          )}
        </div>
      )}
      <div className={styles.composerInner}>
        {slashOpen && (
          <div className={styles.slashBox}>
            <div className={styles.slashHint}>
              <Sparkles size={11} />
              <span>{t("skills.suggestionsHint")}</span>
            </div>
            {commandEntries.length > 0 && (
              <>
                <div className={styles.slashGroupLabel}>{t("slash.commands")}</div>
                {commandEntries.map((c, i) => (
                  <button
                    key={"cmd:" + c.name}
                    className={`${styles.slashItem} ${i === activeIdx ? styles.slashItemActive : ""}`}
                    onMouseEnter={() => setActiveIdx(i)}
                    onClick={() => selectEntry(entries[i])}
                  >
                    <span className={styles.slashName}>/{c.name}</span>
                    <span className={styles.slashDesc}>{c.description}</span>
                  </button>
                ))}
              </>
            )}
            {commandEntries.length > 0 && skillEntries.length > 0 && (
              <div className={styles.slashDivider} />
            )}
            {skillEntries.length > 0 && (
              <>
                <div className={styles.slashGroupLabel}>{t("slash.skills")}</div>
                {skillEntries.map((s, j) => {
                  const i = commandEntries.length + j;
                  return (
                    <button
                      key={s.info.name}
                      className={`${styles.slashItem} ${i === activeIdx ? styles.slashItemActive : ""}`}
                      onMouseEnter={() => setActiveIdx(i)}
                      onClick={() => selectEntry(entries[i])}
                    >
                      <span className={styles.slashName}>/skill:{s.info.name}</span>
                      <span className={styles.slashDesc}>{s.info.description}</span>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        )}
        {mentionOpen && (
          <AtFilePicker cwd={cwd} onConfirm={handleAtConfirm} onClose={handleAtClose} />
        )}
        {messageQueue.length > 0 && (
          <div className={styles.queuePanel}>
            <div className={styles.queueHeader}>
              {t("chat.queueTitle", { count: messageQueue.length })}
            </div>
            {messageQueue.map((q) => (
              <div key={q.id} className={styles.queueItem}>
                {editingId === q.id ? (
                  <input
                    className={styles.queueEditInput}
                    value={editText}
                    autoFocus
                    onChange={(e) => setEditText(e.target.value)}
                    onBlur={() => commitEditQueueItem(q.id, q.content)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitEditQueueItem(q.id, q.content);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setEditingId(null);
                      }
                    }}
                  />
                ) : (
                  <span
                    className={styles.queueText}
                    onDoubleClick={() => startEditQueueItem(q.id, q.content)}
                    title={q.content}
                  >
                    {q.content}
                  </span>
                )}
                <button
                  className={styles.queueEdit}
                  title={t("chat.editQueue")}
                  onClick={() => startEditQueueItem(q.id, q.content)}
                >
                  <Pencil size={12} />
                </button>
                <button
                  className={styles.queueDelete}
                  title={t("chat.deleteQueue")}
                  onClick={() => removeQueuedMessage(q.id)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {codeAttachments.length > 0 && (
          <div className={styles.attachments}>
            {codeAttachments.map((att) => (
              <div
                className={styles.attachPill}
                key={att.id}
                title={att.kind === "terminal" ? t("terminal.outputRef") : att.filePath}
              >
                {att.kind === "terminal" ? (
                  <SquareTerminal size={13} className={styles.attachIcon} />
                ) : (
                  <Code2 size={13} className={styles.attachIcon} />
                )}
                <span className={styles.attachName}>
                  {att.kind === "terminal" ? t("terminal.outputRef") : labelOf(att.filePath)}
                </span>
                <span className={styles.attachLines}>
                  {att.kind === "terminal"
                    ? t("terminal.lineCount", { count: att.endLine })
                    : att.startLine === att.endLine
                      ? att.startLine
                      : `${att.startLine}-${att.endLine}`}
                </span>
                <button
                  type="button"
                  className={styles.attachRemove}
                  onClick={() => removeCodeAttachment(att.id)}
                  title={t("code.removeRef")}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          value={text}
          onChange={(e) => {
            const newText = e.target.value;
            const caret = e.target.selectionStart ?? newText.length;
            setText(newText);
            const m = getActiveMention(newText, caret);
            if (m && m.query === "") {
              setMentionOpen(true);
              mentionPosRef.current = m.atPos;
              mentionEndRef.current = m.atPos + 1;
            } else if (!m) {
              setMentionOpen(false);
            }
          }}
          onKeyDown={handleKeyDown}
          placeholder={t("chat.placeholder")}
          rows={1}
        />
        <div className={styles.toolbar}>
          <div className={styles.toolbarLeft}>
            <button className={styles.iconBtn} title={t("chat.attach")}>
              <Plus size={16} />
            </button>
          </div>
          <div className={styles.toolbarRight}>
            {contextUsage && contextUsage.contextWindow > 0 && (
              <ContextRing usage={contextUsage} />
            )}
            <div className={styles.modelSelector} ref={dropdownRef}>
              <button
                className={styles.modelPill}
                onClick={handleToggleDropdown}
              >
                <span>{loadingModels ? t("chat.loadingModels") : currentLabel}</span>
                <ChevronDown size={10} />
              </button>
              {dropdownOpen && (
                <div className={styles.modelDropdown}>
                  {Object.entries(groupedModels).map(([provider, models]) => (
                    <div key={provider}>
                      <div className={styles.modelGroupLabel}>{provider}</div>
                      {models.map((m) => {
                        const isActive =
                          model?.provider === m.provider && model?.id === m.id;
                        return (
                          <button
                            key={`${m.provider}/${m.id}`}
                            className={`${styles.modelItem} ${isActive ? styles.modelItemActive : ""}`}
                            onClick={() => handleSelectModel(m.provider, m.id)}
                          >
                            <span className={styles.modelItemName}>
                              {m.name ?? m.id}
                            </span>
                            {isActive && <Check size={12} />}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                  {availableModels.length === 0 && (
                    <div className={styles.modelEmpty}>
                      {t("chat.noModels")}
                    </div>
                  )}
                </div>
              )}
            </div>
            <button className={styles.iconBtn} title={t("chat.voice")}>
              <Mic size={16} />
            </button>
            {(isStreaming || (currentPath ? runningPaths.has(currentPath) : false)) ? (
              <button
                className={styles.stopBtn}
                onClick={handleStop}
                title={t("chat.stop")}
              >
                <Square size={16} fill="currentColor" />
              </button>
            ) : (
              <button
                className={styles.sendBtn}
                onClick={handleSend}
                disabled={!text.trim() && codeAttachments.length === 0}
                title={t("chat.send")}
              >
                <Send size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
      <div className={styles.metaRow}>
        {showWorkspaceSelector ? (
          <div className={styles.workspaceSelector} ref={workspaceDropdownRef}>
            <button
              className={`${styles.workspacePill}${pendingPath ? ` ${styles.workspacePillPending}` : ""}`}
              onClick={handleToggleWorkspaceDropdown}
              title={pendingPath ? t("workspace.pending") : (effectiveWorkspace || t("workspace.placeholder"))}
            >
              <FolderOpen size={12} />
              <span className={styles.workspaceLabel}>{workspaceLabel}</span>
              <ChevronDown size={10} />
            </button>
            {workspaceDropdownOpen && (
              <div className={styles.workspaceDropdown}>
                <button
                  className={styles.workspaceOption}
                  onClick={handlePickWorkspace}
                  disabled={workspaceLoading}
                >
                  <FolderPlus size={12} className={styles.workspaceOptionIcon} />
                  <span className={styles.workspaceOptionLabel}>
                    {t("workspace.pick")}
                  </span>
                </button>
                {otherRecents.length > 0 && (
                  <div className={styles.workspaceGroupLabel}>
                    {t("workspace.recent")}
                  </div>
                )}
                {otherRecents.map((r) => (
                  <button
                    key={r}
                    className={styles.workspaceOption}
                    onClick={() => handleSelectRecent(r)}
                    disabled={workspaceLoading}
                    title={r}
                  >
                    <Folder size={12} className={styles.workspaceOptionIcon} />
                    <span className={styles.workspaceOptionLabel}>
                      {displayWorkspaceName(r)}
                    </span>
                  </button>
                ))}
                {otherRecents.length === 0 && (
                  <div className={styles.workspaceEmpty}>
                    {t("workspace.noRecent")}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          !isTaskSession &&
          focusedSession && (
            <div className={styles.workspaceSelector}>
              <div
                className={styles.workspacePill}
                title={focusedSession.cwd}
                style={{ cursor: "default" }}
              >
                <FolderOpen size={12} />
                <span className={styles.workspaceLabel}>
                  {displayWorkspaceName(focusedSession.cwd)}
                </span>
              </div>
            </div>
          )
        )}
        <div className={styles.permissionWrap} ref={permissionRef}>
          <button
            className={styles.permissionPill}
            onClick={() => setPermissionOpen((o) => !o)}
            title="bash 执行权限模式"
          >
            <Shield size={12} />
            <span>{PERMISSION_MODES.find((m) => m.value === bashMode)?.label}</span>
            <ChevronDown size={10} />
          </button>
          {permissionOpen && (
            <div className={styles.permissionMenu}>
              {PERMISSION_MODES.map((m) => (
                <button
                  key={m.value}
                  className={`${styles.permissionItem} ${bashMode === m.value ? styles.permissionItemActive : ""}`}
                  onClick={() => {
                    if (m.value === "yolo" && bashMode !== "yolo") {
                      setPermissionOpen(false);
                      setShowYoloConfirm(true);
                      setYoloChecked(false);
                    } else {
                      setBashMode(m.value);
                      setPermissionOpen(false);
                    }
                  }}
                >
                  <span className={styles.permissionItemLabel}>{m.label}</span>
                  <span className={styles.permissionItemDesc}>{m.desc}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {showYoloConfirm && (
          <div className={styles.yoloOverlay} onClick={() => setShowYoloConfirm(false)}>
            <div className={styles.yoloDialog} onClick={(e) => e.stopPropagation()}>
              <div className={styles.yoloHeader}>
                <AlertCircle className={styles.yoloIcon} size={20} />
                <span className={styles.yoloTitle}>确认允许完全访问？</span>
              </div>
              <div className={styles.yoloBody}>
                <p className={styles.yoloDesc}>
                  开启允许完全访问后，AI 将减少确认步骤，并可直接执行更多操作，包括敏感操作、文件修改或外部执行。
                </p>
                <p className={styles.yoloDesc}>仅建议在您信任当前任务时使用。</p>
                <label className={styles.yoloCheckboxLabel}>
                  <input
                    type="checkbox"
                    checked={yoloChecked}
                    onChange={(e) => setYoloChecked(e.target.checked)}
                  />
                  <span>我已了解风险，并愿意继续</span>
                </label>
              </div>
              <div className={styles.yoloActions}>
                <button
                  className={styles.yoloCancel}
                  onClick={() => setShowYoloConfirm(false)}
                >
                  取消
                </button>
                <button
                  className={`${styles.yoloConfirm} ${!yoloChecked ? styles.yoloConfirmDisabled : ""}`}
                  disabled={!yoloChecked}
                  onClick={() => {
                    setBashMode("yolo");
                    setShowYoloConfirm(false);
                    setYoloChecked(false);
                  }}
                >
                  允许完全访问
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      <div className={styles.disclaimer}>
        {t("chat.disclaimer")}
      </div>
      {error && (
        <div className={styles.errorBanner}>
          <span>{error}</span>
          <button className={styles.errorDismiss} onClick={() => setError(null)}>
            &times;
          </button>
        </div>
      )}
    </div>
  );
}
