import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  File,
  FileText,
  FileCode,
  FileJson,
  Image as ImageIcon,
  Search,
  Loader2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUIStore } from "../store/ui-store";
import styles from "./FileManagerPanel.module.css";

interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
}

interface DirState {
  entries: DirEntry[];
  truncated: boolean;
  error: string | null;
}

const CODE_EXTS = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java",
  "c", "h", "cpp", "hpp", "cs", "php", "swift", "kt", "sh", "bash", "ps1",
  "bat", "cmd", "vue", "svelte", "css", "scss", "less", "html", "htm", "sql",
]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"]);
const TEXT_EXTS = new Set(["md", "txt", "log", "csv", "xml", "ini", "conf", "env"]);

function fileIcon(name: string) {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (ext === "json" || ext === "jsonc") return <FileJson size={14} className={styles.iconJson} />;
  if (IMAGE_EXTS.has(ext)) return <ImageIcon size={14} className={styles.iconImage} />;
  if (CODE_EXTS.has(ext)) return <FileCode size={14} className={styles.iconCode} />;
  if (TEXT_EXTS.has(ext)) return <FileText size={14} className={styles.iconText} />;
  return <File size={14} className={styles.iconFile} />;
}

/**
 * Sidebar file manager panel. Replaces the session list while open.
 *
 * Large-directory safety: the tree is loaded lazily — only ONE directory
 * level is read per expand (via the pi:listDirectory IPC, which itself caps
 * a single level at 1000 entries). `node_modules` never gets read unless
 * the user explicitly expands it, and even then it's just one capped level.
 */
export default function FileManagerPanel({
  cwd,
  onReturnToChat,
}: {
  cwd: string;
  onReturnToChat: () => void;
}) {
  const { t } = useTranslation();
  const closeFileManager = useUIStore((s) => s.closeFileManager);
  const openFilePreview = useUIStore((s) => s.openFilePreview);
  const previewFilePath = useUIStore((s) => s.previewFilePath);

  const [query, setQuery] = useState("");
  // Lazy-loaded children per directory path; missing key = not loaded yet.
  const [dirCache, setDirCache] = useState<Map<string, DirState>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());

  const loadDir = useCallback(async (dirPath: string) => {
    setLoadingDirs((prev) => new Set(prev).add(dirPath));
    try {
      const res = await window.piDesk.listDirectory(dirPath);
      setDirCache((prev) => {
        const next = new Map(prev);
        next.set(dirPath, {
          entries: res.entries,
          truncated: res.truncated,
          error: res.error,
        });
        return next;
      });
    } finally {
      setLoadingDirs((prev) => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    }
  }, []);

  // Load the root level on mount / when the target folder changes.
  useEffect(() => {
    setDirCache(new Map());
    setExpanded(new Set());
    setQuery("");
    loadDir(cwd);
  }, [cwd, loadDir]);

  const toggleDir = (dirPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
        // Lazy load: fetch children only on first expand.
        if (!dirCache.has(dirPath)) loadDir(dirPath);
      }
      return next;
    });
  };

  const handleFileClick = (entry: DirEntry) => {
    openFilePreview(entry.path);
    onReturnToChat();
  };

  const q = query.trim().toLowerCase();

  const renderLevel = (dirPath: string, depth: number): React.ReactNode => {
    const state = dirCache.get(dirPath);
    if (!state) {
      return loadingDirs.has(dirPath) ? (
        <div className={styles.loadingRow} style={{ paddingLeft: 12 + depth * 14 }}>
          <Loader2 size={12} className={styles.spinner} />
          <span>{t("files.loading")}</span>
        </div>
      ) : null;
    }
    if (state.error) {
      return (
        <div className={styles.errorRow} style={{ paddingLeft: 12 + depth * 14 }}>
          {t("files.loadError")}
        </div>
      );
    }
    const entries = q
      ? state.entries.filter(
          (e) => e.isDirectory || e.name.toLowerCase().includes(q),
        )
      : state.entries;
    return (
      <>
        {entries.map((entry) => {
          const isOpen = expanded.has(entry.path);
          if (entry.isDirectory) {
            return (
              <div key={entry.path}>
                <button
                  className={styles.node}
                  style={{ paddingLeft: 4 + depth * 14 }}
                  onClick={() => toggleDir(entry.path)}
                  title={entry.path}
                >
                  {isOpen ? (
                    <ChevronDown size={13} className={styles.chevron} />
                  ) : (
                    <ChevronRight size={13} className={styles.chevron} />
                  )}
                  {isOpen ? (
                    <FolderOpen size={14} className={styles.iconFolder} />
                  ) : (
                    <Folder size={14} className={styles.iconFolder} />
                  )}
                  <span className={styles.nodeName}>{entry.name}</span>
                </button>
                {isOpen && renderLevel(entry.path, depth + 1)}
              </div>
            );
          }
          if (q && !entry.name.toLowerCase().includes(q)) return null;
          const isActive = previewFilePath === entry.path;
          return (
            <button
              key={entry.path}
              className={`${styles.node} ${isActive ? styles.nodeActive : ""}`}
              style={{ paddingLeft: 4 + 13 + depth * 14 }}
              onClick={() => handleFileClick(entry)}
              title={entry.path}
            >
              {fileIcon(entry.name)}
              <span className={styles.nodeName}>{entry.name}</span>
            </button>
          );
        })}
        {state.truncated && (
          <div className={styles.truncatedRow} style={{ paddingLeft: 12 + depth * 14 }}>
            {t("files.truncated")}
          </div>
        )}
      </>
    );
  };

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <button
          className={styles.backBtn}
          onClick={closeFileManager}
          title={t("files.back")}
        >
          <ArrowLeft size={14} />
        </button>
        <span className={styles.title}>{t("files.title")}</span>
      </div>

      <div className={styles.searchBox}>
        <Search size={13} className={styles.searchIcon} />
        <input
          className={styles.searchInput}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("files.searchPlaceholder")}
        />
      </div>

      <div className={styles.pathBar} title={cwd}>
        {cwd}
      </div>

      <div className={styles.tree}>{renderLevel(cwd, 0)}</div>
    </div>
  );
}
