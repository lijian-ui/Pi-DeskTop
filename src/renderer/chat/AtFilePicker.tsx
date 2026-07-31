import { useState, useRef, useEffect, useCallback } from "react";
import {
  Folder,
  FolderOpen,
  File as FileIcon,
  ChevronRight,
  ChevronDown,
  Search,
  X,
  Check,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DirEntry } from "../../preload/api";
import { getCachedDir, setCachedDir } from "./atFileCache";
import styles from "./AtFilePicker.module.css";

/** Convert an absolute target path to a posix-style path relative to base. */
export function toRelative(base: string, target: string): string {
  const norm = (p: string) => p.split(/[\\/]+/).filter(Boolean);
  const b = norm(base);
  const t = norm(target);
  let i = 0;
  while (i < b.length && i < t.length && b[i].toLowerCase() === t[i].toLowerCase()) i++;
  const up = b.length - i;
  const rel = [...Array(up).fill(".."), ...t.slice(i)];
  return rel.length ? rel.join("/") : ".";
}

interface AtFilePickerProps {
  cwd: string;
  onConfirm: (paths: string[]) => void;
  onClose: () => void;
}

interface SearchResult {
  name: string;
  path: string;
  isDirectory: boolean;
}

export default function AtFilePicker({ cwd, onConfirm, onClose }: AtFilePickerProps) {
  const { t } = useTranslation();
  const ROOT = cwd;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [cache, setCache] = useState<Record<string, DirEntry[]>>({});
  const [loadingDirs, setLoadingDirs] = useState<Record<string, boolean>>({});
  const [truncated, setTruncated] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  /** Guards against out-of-order search replies (see the search effect). */
  const searchSeqRef = useRef(0);

  const loadDir = useCallback(async (dir: string) => {
    setLoadingDirs((l) => ({ ...l, [dir]: true }));
    setError(null);
    try {
      const res = await window.piDesk.listDirectory(dir);
      setCache((c) => ({ ...c, [dir]: res.entries }));
      // Mirror into the shared cache so later opens (even during streaming)
      // read instantly instead of blocking on a main-process IPC call.
      setCachedDir(dir, res.entries);
      setTruncated((tr) => ({ ...tr, [dir]: res.truncated }));
      if (res.error) setError(res.error);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setCache((c) => ({ ...c, [dir]: [] }));
    } finally {
      setLoadingDirs((l) => ({ ...l, [dir]: false }));
    }
  }, []);

  // Load the root directory when the picker opens. Prefer the warm shared
  // cache (populated while idle) so we don't show "加载中" — and don't even
  // hit the main process — while the model is streaming.
  useEffect(() => {
    if (!ROOT) return;
    const cached = getCachedDir(ROOT);
    if (cached) {
      setCache((c) => ({ ...c, [ROOT]: cached }));
    } else {
      loadDir(ROOT);
    }
  }, [ROOT, loadDir]);

  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  // Debounced, bounded search across the workspace. A sequence number guards
  // against out-of-order results: clearing the debounce timer only cancels the
  // *pending* request — an already in-flight IPC reply could otherwise arrive
  // after a newer query and clobber its results. Each query bumps the counter,
  // and stale replies are discarded.
  useEffect(() => {
    const q = search.trim();
    if (!q) {
      searchSeqRef.current++;
      setResults(null);
      setSearching(false);
      return;
    }
    const seq = ++searchSeqRef.current;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await window.piDesk.searchWorkspace(q, 200);
        if (searchSeqRef.current !== seq) return; // stale reply
        setResults(res.results);
      } catch {
        if (searchSeqRef.current !== seq) return;
        setResults([]);
      } finally {
        if (searchSeqRef.current === seq) setSearching(false);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [search]);

  const toggleExpand = useCallback(
    (dir: string) => {
      setExpanded((ex) => {
        const next = !ex[dir];
        if (next && !cache[dir] && !loadingDirs[dir]) {
          loadDir(dir);
        }
        return { ...ex, [dir]: next };
      });
    },
    [cache, loadingDirs, loadDir]
  );

  const toggleSelect = useCallback((path: string) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  }, []);

  function renderNode(entry: DirEntry, depth: number) {
    const isDir = entry.isDirectory && !entry.isSymlink;
    const isOpen = !!expanded[entry.path];
    const isSel = selected.has(entry.path);
    const children = cache[entry.path] || [];
    const isLoading = !!loadingDirs[entry.path];
    const isTrunc = !!truncated[entry.path];
    return (
      <div key={entry.path}>
        <div
          className={`${styles.row} ${isSel ? styles.rowSelected : ""}`}
          style={{ paddingLeft: 8 + depth * 16 }}
          onClick={() => toggleSelect(entry.path)}
        >
          <span
            className={styles.chev}
            onClick={(e) => {
              if (!isDir) return;
              e.stopPropagation();
              toggleExpand(entry.path);
            }}
          >
            {isDir ? (
              isOpen ? (
                <ChevronDown size={14} />
              ) : (
                <ChevronRight size={14} />
              )
            ) : (
              <span className={styles.chevSpacer} />
            )}
          </span>
          <span className={styles.icon}>
            {isDir ? (
              isOpen ? (
                <FolderOpen size={15} />
              ) : (
                <Folder size={15} />
              )
            ) : (
              <FileIcon size={15} />
            )}
          </span>
          <span className={styles.name} title={entry.path}>
            {entry.name}
          </span>
          <span
            className={`${styles.check} ${isSel ? styles.checkOn : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              toggleSelect(entry.path);
            }}
          >
            {isSel ? <Check size={12} /> : null}
          </span>
        </div>
        {isDir && isOpen && (
          <div>
            {isLoading ? (
              <div className={styles.note} style={{ paddingLeft: 8 + (depth + 1) * 16 }}>
                {t("filePicker.loading")}
              </div>
            ) : children.length === 0 ? (
              <div className={styles.note} style={{ paddingLeft: 8 + (depth + 1) * 16 }}>
                {t("filePicker.emptyDir")}
              </div>
            ) : (
              children.map((c) => renderNode(c, depth + 1))
            )}
            {isTrunc && (
              <div className={styles.note} style={{ paddingLeft: 8 + (depth + 1) * 16 }}>
                {t("filePicker.truncated")}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  const rootChildren = cache[ROOT] || [];
  const rootLoading = !!loadingDirs[ROOT];
  const selectedList = Array.from(selected);

  const handleInsert = () => onConfirm(selectedList);
  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter" && selectedList.length > 0) {
      e.preventDefault();
      handleInsert();
    }
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <div className={styles.header}>
          <div className={styles.titleRow}>
            <span className={styles.title}>{t("filePicker.title")}</span>
            <button className={styles.closeBtn} onClick={onClose} title={t("filePicker.cancel")}>
              <X size={16} />
            </button>
          </div>
          <div className={styles.searchWrap}>
            <Search size={14} className={styles.searchIcon} />
            <input
              ref={searchInputRef}
              className={styles.searchInput}
              placeholder={t("filePicker.searchPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
            {search && (
              <button className={styles.searchClear} onClick={() => setSearch("")}>
                <X size={13} />
              </button>
            )}
          </div>
          <div className={styles.rootPath} title={ROOT}>
            {ROOT}
          </div>
        </div>

        <div className={styles.body}>
          {error && <div className={styles.error}>{error}</div>}
          {results !== null ? (
            searching ? (
              <div className={styles.note}>{t("filePicker.searching")}</div>
            ) : results.length === 0 ? (
              <div className={styles.note}>{t("filePicker.searchEmpty")}</div>
            ) : (
              results.map((r) => {
                const isSel = selected.has(r.path);
                return (
                  <div
                    key={r.path}
                    className={`${styles.row} ${isSel ? styles.rowSelected : ""}`}
                    onClick={() => toggleSelect(r.path)}
                  >
                    <span className={styles.chevSpacer} />
                    <span className={styles.icon}>
                      {r.isDirectory ? <Folder size={15} /> : <FileIcon size={15} />}
                    </span>
                    <span className={styles.name} title={r.path}>
                      <span>{r.name}</span>
                      <span className={styles.subpath}>{toRelative(ROOT, r.path)}</span>
                    </span>
                    <span
                      className={`${styles.check} ${isSel ? styles.checkOn : ""}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSelect(r.path);
                      }}
                    >
                      {isSel ? <Check size={12} /> : null}
                    </span>
                  </div>
                );
              })
            )
          ) : rootLoading ? (
            <div className={styles.note}>{t("filePicker.loading")}</div>
          ) : rootChildren.length === 0 ? (
            <div className={styles.note}>{t("filePicker.emptyDir")}</div>
          ) : (
            rootChildren.map((c) => renderNode(c, 0))
          )}
        </div>

        <div className={styles.footer}>
          <div className={styles.chips}>
            {selectedList.length === 0 ? (
              <span className={styles.chipsEmpty}>{t("filePicker.searchHint")}</span>
            ) : (
              selectedList.map((p) => (
                <span key={p} className={styles.chip}>
                  <span>{toRelative(ROOT, p)}</span>
                  <button
                    className={styles.chipX}
                    onClick={() => toggleSelect(p)}
                    title={t("filePicker.clear")}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))
            )}
          </div>
          <div className={styles.footerActions}>
            <button className={styles.cancelBtn} onClick={onClose}>
              {t("filePicker.cancel")}
            </button>
            <button
              className={styles.insertBtn}
              onClick={handleInsert}
              disabled={selectedList.length === 0}
            >
              {t("filePicker.insert", { count: selectedList.length })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
