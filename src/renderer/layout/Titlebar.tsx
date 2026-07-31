import { useEffect } from "react";
import { Search, TerminalSquare, ChevronUp, ChevronDown, X } from "lucide-react";
import { useUIStore } from "../store/ui-store";
import { useTranslation } from "react-i18next";
import styles from "./Titlebar.module.css";

export default function Titlebar() {
  const terminalOpen = useUIStore((s) => s.terminalOpen);
  const toggleTerminal = useUIStore((s) => s.toggleTerminal);
  const searchOpen = useUIStore((s) => s.searchOpen);
  const searchQuery = useUIStore((s) => s.searchQuery);
  const searchMatchIds = useUIStore((s) => s.searchMatchIds);
  const searchIndex = useUIStore((s) => s.searchIndex);
  const openSearch = useUIStore((s) => s.openSearch);
  const closeSearch = useUIStore((s) => s.closeSearch);
  const setSearchQuery = useUIStore((s) => s.setSearchQuery);
  const submitSearch = useUIStore((s) => s.submitSearch);
  const nextMatch = useUIStore((s) => s.nextMatch);
  const prevMatch = useUIStore((s) => s.prevMatch);
  const { t } = useTranslation();

  // Global "find in conversation" shortcut: Ctrl+F on Windows/Linux,
  // Cmd+F on macOS. Opens the in-session search box (the input auto-focuses
  // on mount) and prevents any default browser-style find behavior.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        openSearch();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openSearch]);

  // Live search: automatically re-run the search 200ms after the user stops
  // typing (debounced). MessageList recomputes matches on each trigger and
  // clears them when the query is empty, so no extra handling is needed here.
  useEffect(() => {
    if (!searchOpen) return;
    const timer = window.setTimeout(() => submitSearch(), 200);
    return () => window.clearTimeout(timer);
  }, [searchQuery, searchOpen, submitSearch]);

  const hasQuery = searchQuery.trim().length > 0;
  const matchCount = searchMatchIds.length;
  const countLabel = !hasQuery
    ? ""
    : matchCount > 0
    ? `${searchIndex + 1}/${matchCount}`
    : t("search.noResults");

  return (
    <div className={styles.titlebar}>
      <div className={styles.left}></div>
      <div className={styles.right}>
        {searchOpen && (
          <div className={styles.searchBox}>
            <Search size={14} className={styles.searchIcon} />
            <input
              className={styles.searchInput}
              value={searchQuery}
              placeholder={t("search.placeholder")}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  // Search already runs live while typing; Enter now steps
                  // through matches (Shift+Enter goes backwards), matching
                  // browser find-bar behavior. If matches aren't computed
                  // yet (debounce pending), trigger the search immediately.
                  if (matchCount > 0) {
                    if (e.shiftKey) prevMatch();
                    else nextMatch();
                  } else {
                    submitSearch();
                  }
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  closeSearch();
                }
              }}
              autoFocus
            />
            {countLabel && <span className={styles.searchCount}>{countLabel}</span>}
            <button
              className={styles.searchNav}
              onClick={prevMatch}
              disabled={matchCount === 0}
              title={t("search.prev")}
            >
              <ChevronUp size={14} />
            </button>
            <button
              className={styles.searchNav}
              onClick={nextMatch}
              disabled={matchCount === 0}
              title={t("search.next")}
            >
              <ChevronDown size={14} />
            </button>
            <button
              className={styles.searchNav}
              onClick={closeSearch}
              title={t("search.close")}
            >
              <X size={14} />
            </button>
          </div>
        )}
        <button
          className={`${styles.iconBtn} ${searchOpen ? styles.iconBtnActive : ""}`}
          onClick={() => (searchOpen ? closeSearch() : openSearch())}
          title={t("search.title")}
        >
          <Search size={16} />
        </button>
        <button
          className={`${styles.iconBtn} ${terminalOpen ? styles.iconBtnActive : ""}`}
          onClick={toggleTerminal}
          title={t("terminal.toggle")}
        >
          <TerminalSquare size={16} />
        </button>
      </div>
    </div>
  );
}
