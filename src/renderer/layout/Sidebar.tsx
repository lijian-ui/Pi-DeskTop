import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Plus,
  SquarePen,
  Search,
  Filter,
  Settings,
  Folder,
  Wrench,
  Sparkles,
  Download,
  Trash2,
  Pencil,
  MoreVertical,
  PanelLeftClose,
  ChevronDown,
  ChevronRight,
  ListTree,
  Loader2,
} from "lucide-react";
import { useUIStore } from "../store/ui-store";
import { useTranslation } from "react-i18next";
import { useSessionStore, type SessionInfo } from "../store/session-store";
import FileManagerPanel from "./FileManagerPanel";
import ConfirmDialog from "../sidebar/ConfirmDialog";
import styles from "./Sidebar.module.css";

type NavKey = "chat" | "agents" | "projects" | "skills" | "automate" | "settings";

interface NavItem {
  key: NavKey;
  icon: LucideIcon;
  labelKey: string;
}

const NAV_ITEMS: NavItem[] = [
  { key: "skills", icon: Sparkles, labelKey: "nav.skills" },
  { key: "automate", icon: Wrench, labelKey: "nav.automate" },
  { key: "settings", icon: Settings, labelKey: "nav.settings" },
];

function formatTime(value: string | Date | undefined): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString([], {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function sessionTitle(s: SessionInfo): string {
  if (s.name) return s.name;
  const first = (s.firstMessage || "").trim();
  if (first) return first.length > 40 ? first.slice(0, 40) + "…" : first;
  return s.id;
}

/** Last path segment of a cwd, used as the folder display name. */
function folderName(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const seg = trimmed.split(/[\\/]/).pop();
  return seg || trimmed || "";
}

/**
 * Normalize a filesystem path for use as a grouping key.
 * Ensures that `E:\Project\pi-desktop`, `E:/Project/pi-desktop`,
 * and `E:\Project\pi-desktop\` all map to the same string.
 */
function normalizeCwd(raw: string): string {
  return (raw || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

interface SessionGroup {
  key: string; // raw cwd ("" = ungrouped)
  label: string;
  sessions: SessionInfo[];
}

/**
 * Group sessions by their working directory (cwd). Each distinct cwd becomes
 * a collapsible "folder"; sessions with no cwd fall into an "ungrouped"
 * bucket rendered last. Groups are ordered by their most recently modified
 * session (input list is already modified-desc from the SDK).
 */
function groupSessions(sessions: SessionInfo[], ungroupedLabel: string): SessionGroup[] {
  const map = new Map<string, SessionGroup>();
  for (const s of sessions) {
    const key = normalizeCwd(s.cwd);
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        label: key ? folderName(key) : ungroupedLabel,
        sessions: [],
      };
      map.set(key, g);
    }
    g.sessions.push(s);
  }
  // Map preserves insertion order = order of first (most recent) appearance,
  // so groups are naturally sorted by recency. Push the ungrouped bucket last.
  const groups = [...map.values()];
  const idx = groups.findIndex((g) => g.key === "");
  if (idx >= 0) groups.push(...groups.splice(idx, 1));
  return groups;
}

export default function Sidebar() {
  const [activeNav, setActiveNav] = useState<NavKey>("chat");
  const setMainView = useUIStore((s) => s.setMainView);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const { t } = useTranslation();
  const loadSessions = useSessionStore((s) => s.load);
  const createNewChat = useSessionStore((s) => s.createNew);
  const fileManagerCwd = useUIStore((s) => s.fileManagerCwd);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const goToChat = () => {
    setActiveNav("chat");
    setMainView("chat");
  };

  // Entry ①: nav-level "新建任务" — a plain chat that lives in the chat-only
  // fallback dir, so it lands under「任务」. The user is never forced to pick a
  // folder; the composer still offers the workspace selector until the first
  // message, and picking one re-homes just this session into「空间」.
  // Entry ② is the per-folder + button (handleNewInFolder), which creates
  // directly inside an existing workspace.
  const handleNewChat = () => {
    createNewChat();
    goToChat();
  };

  const handleNavClick = (key: NavKey) => {
    setActiveNav(key);
    if (key === "settings") {
      setMainView("settings");
    } else if (key === "skills") {
      setMainView("skills");
    } else if (key === "automate") {
      setMainView("automate");
    } else {
      setMainView("chat");
    }
  };

  return (
    <div className={styles.sidebar}>
      {/* ── Header: icons ── */}
      <div className={styles.header}>
        <button
          className={styles.headerIcon}
          onClick={toggleSidebar}
          title={t("sidebar.collapse")}
        >
          <PanelLeftClose size={14} />
        </button>
        <div className={styles.headerIcons}>
          <button className={styles.headerIcon} title={t("sidebar.search")}>
            <Search size={14} />
          </button>
          <button className={styles.headerIcon} title={t("sidebar.filter")}>
            <Filter size={14} />
          </button>
        </div>
      </div>

      {/* ── Action buttons list ── */}
      <div className={styles.navList}>
        <button
          className={styles.newChatBtn}
          onClick={handleNewChat}
          title={t("sessions.new")}
        >
          <SquarePen size={16} />
          <span>{t("sessions.new")}</span>
        </button>
        {NAV_ITEMS.map(({ key, icon: Icon, labelKey }) => (
          <button
            key={key}
            className={`${styles.navItem} ${activeNav === key ? styles.navItemActive : ""}`}
            onClick={() => handleNavClick(key)}
          >
            <Icon size={16} />
            <span>{t(labelKey)}</span>
          </button>
        ))}
      </div>

      {/* ── Content area: session list, or the file manager panel when a
          folder's file-manager icon was clicked (replaces the whole list) ── */}
      <div className={styles.content}>
        {fileManagerCwd ? (
          <FileManagerPanel cwd={fileManagerCwd} onReturnToChat={goToChat} />
        ) : (
          <SessionsSection onReturnToChat={goToChat} />
        )}
      </div>
    </div>
  );
}

function SessionsSection({
  onReturnToChat,
}: {
  onReturnToChat: () => void;
}) {
  const { t } = useTranslation();
  const sessions = useSessionStore((s) => s.sessions);
  const chatOnlyCwd = useSessionStore((s) => s.chatOnlyCwd);
  const currentPath = useSessionStore((s) => s.currentPath);
  const runningPaths = useSessionStore((s) => s.runningPaths);
  const loading = useSessionStore((s) => s.loading);
  const selectSession = useSessionStore((s) => s.selectSession);
  const createNew = useSessionStore((s) => s.createNew);
  const removeSession = useSessionStore((s) => s.removeSession);
  const exportSession = useSessionStore((s) => s.exportSession);
  const renameSession = useSessionStore((s) => s.renameSession);
  const openFileManager = useUIStore((s) => s.openFileManager);

  // A session is a "task" (no workspace) when it has no cwd or its cwd is the
  // chat-only fallback directory. Precompute the normalized chat-only cwd so
  // we don't re-normalize it once per session on every filter pass.
  const normalizedChatOnlyCwd = useMemo(
    () => normalizeCwd(chatOnlyCwd),
    [chatOnlyCwd],
  );
  const isTask = useCallback(
    (s: SessionInfo): boolean =>
      !s.cwd || normalizeCwd(s.cwd) === normalizedChatOnlyCwd,
    [normalizedChatOnlyCwd],
  );
  const taskSessions = useMemo(
    () => sessions.filter(isTask),
    [sessions, isTask],
  );
  const spaceSessions = useMemo(
    () => sessions.filter((s) => !isTask(s)),
    [sessions, isTask],
  );
  const spaceGroups = useMemo(
    () => groupSessions(spaceSessions, t("sessions.ungrouped")),
    [spaceSessions, t],
  );

  // Folder-tree state: which cwd groups are collapsed (default: all expanded),
  // and whether the「任务」/「空间」sections are collapsed.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const [taskCollapsed, setTaskCollapsed] = useState(false);
  const [spaceCollapsed, setSpaceCollapsed] = useState(false);
  // Which session's "⋯" menu is open (at most one). null = none.
  const [menuOpenPath, setMenuOpenPath] = useState<string | null>(null);
  // Which session is currently in inline-rename mode. null = none.
  const [editingPath, setEditingPath] = useState<string | null>(null);
  // Which session is pending delete confirmation. null = none.
  const [pendingDeletePath, setPendingDeletePath] = useState<string | null>(null);

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleExport = async (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    setMenuOpenPath(null);
    try {
      const out = await exportSession(path);
      if (out) {
        // brief confirmation
        console.log(t("sessions.exported"), out);
      }
    } catch {
      console.error(t("sessions.exportFailed"));
    }
  };

  const handleDelete = (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    setMenuOpenPath(null);
    setPendingDeletePath(path);
  };

  const confirmDelete = () => {
    if (pendingDeletePath) {
      removeSession(pendingDeletePath);
      setPendingDeletePath(null);
    }
  };

  const startRename = (path: string) => {
    setMenuOpenPath(null);
    setEditingPath(path);
  };

  const submitRename = async (path: string, name: string) => {
    setEditingPath(null);
    await renameSession(path, name);
  };

  // Create a new session inside a specific folder (= cwd group).
  const handleNewInFolder = async (e: React.MouseEvent, group: SessionGroup) => {
    e.stopPropagation();
    // Create the new session directly inside the workspace folder (per-session
    // binding; no global workspace state is touched).
    await createNew(group.key);
    onReturnToChat();
  };

  // Render a single session row (shared by the 任务 list and 空间 folders).
  const renderRow = (session: SessionInfo) => {
    const isActive = currentPath === session.path;
    const isEditing = editingPath === session.path;
    const isMenuOpen = menuOpenPath === session.path;
    return (
      <div
        className={`${styles.sessionItem} ${isActive ? styles.sessionItemActive : ""}`}
        role="button"
        tabIndex={0}
        onClick={() => {
          selectSession(session.path);
          onReturnToChat();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            selectSession(session.path);
            onReturnToChat();
          }
        }}
        title={sessionTitle(session)}
      >
        {isEditing ? (
          <RenameInput
            initialValue={session.name ?? ""}
            onSave={(val) => submitRename(session.path, val)}
            onCancel={() => setEditingPath(null)}
          />
        ) : (
          <span
            className={styles.sessionTitle}
            onDoubleClick={(e) => {
              e.stopPropagation();
              startRename(session.path);
            }}
          >
            {sessionTitle(session)}
          </span>
        )}
        <span className={styles.sessionTime}>
          {formatTime(session.created)}
        </span>
        {runningPaths.has(session.path) && (
          <Loader2 size={13} className={styles.sessionSpinner} />
        )}
        <button
          className={`${styles.sessionMenuBtn} ${isMenuOpen ? styles.sessionMenuBtnOpen : ""}`}
          title={t("sessions.more")}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpenPath(isMenuOpen ? null : session.path);
          }}
        >
          <MoreVertical size={14} />
        </button>
        {isMenuOpen && (
          <>
            <div
              className={styles.menuOverlay}
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpenPath(null);
              }}
            />
            <div
              className={styles.sessionMenu}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                className={styles.sessionMenuItem}
                onClick={(e) => {
                  e.stopPropagation();
                  startRename(session.path);
                }}
              >
                <Pencil size={13} />
                <span>{t("sessions.rename")}</span>
              </button>
              <button
                className={styles.sessionMenuItem}
                onClick={(e) => handleExport(e, session.path)}
              >
                <Download size={13} />
                <span>{t("sessions.export")}</span>
              </button>
              <button
                className={`${styles.sessionMenuItem} ${styles.sessionMenuItemDanger}`}
                onClick={(e) => handleDelete(e, session.path)}
              >
                <Trash2 size={13} />
                <span>{t("sessions.delete")}</span>
              </button>
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <div className={styles.spacesSection}>
      <div className={styles.spacesHeader}>
        <button
          className={styles.spacesTitleBtn}
          onClick={() => setTaskCollapsed((v) => !v)}
          title={t("sessions.tasks")}
        >
          <span className={styles.spacesTitle}>
            {t("sessions.tasks")} ({taskSessions.length})
          </span>
          {taskCollapsed ? (
            <ChevronRight size={14} className={styles.spaceChevron} />
          ) : (
            <ChevronDown size={14} className={styles.spaceChevron} />
          )}
        </button>
      </div>

      {!loading && sessions.length === 0 && (
        <div className={styles.emptyState}>{t("sessions.empty")}</div>
      )}

      {!taskCollapsed && (
        <div className={styles.spacesList}>
          {taskSessions.map((s) => (
            <div key={s.path}>{renderRow(s)}</div>
          ))}
        </div>
      )}

      {/* 空间 —已选择工作空间的会话，按目录二级分组 */}
      <div className={styles.spacesHeader}>
        <button
          className={styles.spacesTitleBtn}
          onClick={() => setSpaceCollapsed((v) => !v)}
          title={t("sessions.spaces")}
        >
          <span className={styles.spacesTitle}>
            {t("sessions.spaces")} ({spaceSessions.length})
          </span>
          {spaceCollapsed ? (
            <ChevronRight size={14} className={styles.spaceChevron} />
          ) : (
            <ChevronDown size={14} className={styles.spaceChevron} />
          )}
        </button>
      </div>

      {!spaceCollapsed && (
        <div className={styles.spacesList}>
          {spaceGroups.map((group) => {
            const isCollapsed = collapsedGroups.has(group.key);
            return (
              <div key={group.key || "__ungrouped__"} className={styles.spaceItem}>
                <button
                  className={styles.spaceHeader}
                  onClick={() => toggleGroup(group.key)}
                  title={group.key || group.label}
                >
                  <Folder size={16} className={styles.spaceFolderIcon} />
                  <span className={styles.spaceName}>{group.label}</span>
                  {isCollapsed ? (
                    <ChevronRight size={16} className={styles.spaceChevron} />
                  ) : (
                    <ChevronDown size={16} className={styles.spaceChevron} />
                  )}
                  <span className={styles.spaceCount}>{group.sessions.length}</span>
                  {group.key && (
                    <>
                      <span
                        role="button"
                        tabIndex={0}
                        className={styles.spaceAddBtn}
                        title={t("files.open")}
                        onClick={(e) => {
                          e.stopPropagation();
                          openFileManager(group.key);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.stopPropagation();
                            openFileManager(group.key);
                          }
                        }}
                      >
                        <ListTree size={13} />
                      </span>
                      <span
                        role="button"
                        tabIndex={0}
                        className={styles.spaceAddBtn}
                        title={t("sessions.newInFolder")}
                        onClick={(e) => handleNewInFolder(e, group)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.stopPropagation();
                            handleNewInFolder(e as unknown as React.MouseEvent, group);
                          }
                        }}
                      >
                        <Plus size={13} />
                      </span>
                    </>
                  )}
                </button>
                {!isCollapsed && (
                  <div className={styles.spaceSessions}>
                    {group.sessions.map((session) => renderRow(session))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={pendingDeletePath !== null}
        title={t("sessions.confirmDeleteTitle")}
        message={t("sessions.confirmDelete")}
        confirmLabel={t("sessions.confirmDeleteYes")}
        cancelLabel={t("close")}
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDeletePath(null)}
      />
    </div>
  );
}

/**
 * Inline rename editor for a session. Autofocuses and selects the current
 * text. Enter commits, Escape / blur cancels. Saving an empty string clears
 * the custom name (the list then falls back to the first message).
 */
function RenameInput({
  initialValue,
  onSave,
  onCancel,
}: {
  initialValue: string;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  return (
    <input
      ref={ref}
      className={styles.renameInput}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          onSave(value.trim());
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => onCancel()}
    />
  );
}
