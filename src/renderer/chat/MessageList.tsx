import { useEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { useAgentStore } from "../store/agent-store";
import { useUIStore } from "../store/ui-store";
import { useTranslation } from "react-i18next";
import UserMessage from "./UserMessage";
import AssistantMessage from "./AssistantMessage";
import styles from "./MessageList.module.css";

/** How close (px) to the bottom still counts as "at the bottom". */
const BOTTOM_THRESHOLD = 80;
/** How close (px) to the top triggers loading earlier messages. */
const TOP_THRESHOLD = 80;
/** How many messages to reveal per auto-load batch. */
const BATCH_SIZE = 50;

export default function MessageList() {
  const messages = useAgentStore((s) => s.messages);
  const isStreaming = useAgentStore((s) => s.isStreaming);
  const { t } = useTranslation();

  // In-session content search: Titlebar search box → this locator.
  const searchOpen = useUIStore((s) => s.searchOpen);
  const searchQuery = useUIStore((s) => s.searchQuery);
  const searchTrigger = useUIStore((s) => s.searchTrigger);
  const searchMatchIds = useUIStore((s) => s.searchMatchIds);
  const searchIndex = useUIStore((s) => s.searchIndex);
  const setMatchIds = useUIStore((s) => s.setMatchIds);
  const setSearchIndex = useUIStore((s) => s.setSearchIndex);
  const listRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const prevLen = useRef(messages.length);
  // Tracks whether the user is currently at (or near) the bottom. Gates the
  // auto-follow logic so we never yank a user who scrolled up back to bottom.
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  // How many of the latest messages are currently rendered. Older history is
  // lazily revealed as the user scrolls up — avoids rendering hundreds of
  // heavy Markdown/code/Mermaid components for long sessions at once.
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE);
  // When set, the next render should restore scrollTop so the viewport doesn't
  // jump after we prepend earlier messages above the current position.
  const pendingRestoreRef = useRef(0);
  const loadingMoreRef = useRef(false);

  // Reset the visible window whenever a different session is loaded
  // (detected by the first message's id changing), or when search closes
  // (to restore virtual scrolling after search expanded all messages).
  const firstId = messages[0]?.id;
  const firstIdRef = useRef(firstId);
  useEffect(() => {
    if (firstId !== firstIdRef.current) {
      firstIdRef.current = firstId;
      setVisibleCount(BATCH_SIZE);
    }
  }, [firstId]);

  useEffect(() => {
    if (!searchOpen && visibleCount > BATCH_SIZE) {
      setVisibleCount(BATCH_SIZE);
    }
  }, [searchOpen]);

  const isNearBottom = () => {
    const list = listRef.current;
    if (!list) return true;
    return list.scrollHeight - list.scrollTop - list.clientHeight < BOTTOM_THRESHOLD;
  };

  const handleScroll = () => {
    const list = listRef.current;
    if (!list) return;
    const atBottom = isNearBottom();
    atBottomRef.current = atBottom;
    setShowJump(!atBottom);

    // Auto-load earlier messages when the user scrolls near the top, and keep
    // their reading position anchored (no jump) by recording the current
    // scrollHeight and restoring the delta after the batch is prepended.
    if (
      list.scrollTop < TOP_THRESHOLD &&
      visibleCount < messages.length &&
      !loadingMoreRef.current
    ) {
      loadingMoreRef.current = true;
      pendingRestoreRef.current = list.scrollHeight;
      setVisibleCount((c) => Math.min(messages.length, c + BATCH_SIZE));
    }
  };

  const scrollToBottom = () => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
    atBottomRef.current = true;
    setShowJump(false);
  };

  // After prepending earlier messages, restore the scroll position so the
  // viewport stays anchored on the same content.
  useEffect(() => {
    const list = listRef.current;
    if (!list || !pendingRestoreRef.current) return;
    list.scrollTop = list.scrollHeight - pendingRestoreRef.current;
    pendingRestoreRef.current = 0;
    loadingMoreRef.current = false;
  }, [visibleCount]);

  // Auto-follow: new message → smooth scroll if already at bottom; streaming
  // token append → jump to bottom instantly, but only if the user hasn't
  // scrolled up (respect their reading position).
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (messages.length > prevLen.current) {
      if (atBottomRef.current) {
        anchorRef.current?.scrollIntoView({ behavior: "smooth" });
      }
    } else if (isStreaming && atBottomRef.current) {
      list.scrollTop = list.scrollHeight;
    }
    prevLen.current = messages.length;
  }, [messages, isStreaming]);

  // On (re)mount, start at the latest message and hide the jump button.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
    atBottomRef.current = true;
    setShowJump(false);
  }, []);

  // Run a content search whenever the user presses Enter in the Titlebar
  // search box (searchTrigger increments). Matches against message content
  // and thinking. Older (lazily-hidden) messages are expanded into the
  // rendered window so the locator can scroll to them.
  useEffect(() => {
    if (!searchOpen) {
      setMatchIds([]);
      return;
    }
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      setMatchIds([]);
      return;
    }
    const ids = messages
      .filter(
        (m) =>
          (m.content && m.content.toLowerCase().includes(q)) ||
          (m.thinking && m.thinking.toLowerCase().includes(q))
      )
      .map((m) => m.id);
    setMatchIds(ids);
    setSearchIndex(0);
    if (ids.length) setVisibleCount(messages.length);
    // searchQuery/searchOpen are read at submit time; we only recompute on
    // a new search trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTrigger]);

  // Scroll the active match into view whenever the match set or the current
  // index changes.
  useEffect(() => {
    if (!searchMatchIds.length) return;
    const id = searchMatchIds[searchIndex];
    if (!id) return;
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(`msg-${id}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(raf);
  }, [searchTrigger, searchIndex, searchMatchIds]);

  // Inline text highlighting for search matches via the CSS Custom Highlight
  // API. This decorates the *actual matched substrings* (like browser Ctrl+F)
  // without mutating the React-rendered DOM — ranges are registered with the
  // engine and painted through ::highlight() CSS rules. Every match gets a
  // soft background; the active match (searchIndex) gets a stronger one. When
  // the API is unavailable we fall back to the per-message outline (highlight
  // prop), which also covers matches inside the collapsed thinking block.
  useEffect(() => {
    const winAny = window as unknown as {
      CSS?: { highlights?: { delete: (n: string) => void; set: (n: string, h: unknown) => void } };
      Highlight?: new () => { add: (r: Range) => void };
    };
    const highlights = winAny.CSS?.highlights;
    const HighlightCtor = winAny.Highlight;
    const supported = !!highlights && !!HighlightCtor;
    if (supported) {
      highlights.delete("search-mark");
      highlights.delete("search-mark-active");
    }
    if (!searchOpen || !supported) return;

    const q = searchQuery.trim().toLowerCase();
    if (!q) return;

    const markRanges: Range[] = [];
    const activeRanges: Range[] = [];
    const activeId = searchMatchIds[searchIndex];

    for (const id of searchMatchIds) {
      const el = document.getElementById(`msg-${id}`);
      if (!el) continue;
      // Skip elements that are not in the visible viewport to avoid
      // expensive TreeWalker scans on off-screen (lazily hidden) messages.
      if (!el.offsetParent) continue;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const textNode = node as Text;
        const text = textNode.textContent ?? "";
        const lower = text.toLowerCase();
        let idx = lower.indexOf(q);
        while (idx !== -1) {
          const range = document.createRange();
          range.setStart(textNode, idx);
          range.setEnd(textNode, idx + q.length);
          if (id === activeId) activeRanges.push(range);
          else markRanges.push(range);
          idx = lower.indexOf(q, idx + q.length);
        }
      }
    }

    try {
      const mark = new HighlightCtor!();
      markRanges.forEach((r) => mark.add(r));
      const active = new HighlightCtor!();
      activeRanges.forEach((r) => active.add(r));
      highlights.set("search-mark", mark);
      highlights.set("search-mark-active", active);
    } catch {
      /* Highlight unsupported at runtime — per-message outline stays visible */
    }

    return () => {
      if (supported) {
        highlights.delete("search-mark");
        highlights.delete("search-mark-active");
      }
    };
    // searchQuery is deliberately NOT a dependency: the highlights only need to
    // be (re)built when a new search is SUBMITTED (searchTrigger bumps on
    // Enter/debounce). Depending on it would re-run the full TreeWalker scan on
    // every keystroke while typing in the search box.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen, searchTrigger, searchIndex, searchMatchIds, visibleCount]);

  // Only render the most recent `visibleCount` messages; older ones are
  // revealed on demand as the user scrolls up.
  const startIdx = Math.max(0, messages.length - visibleCount);
  const visibleMessages = messages.slice(startIdx);
  const activeId = searchMatchIds[searchIndex] ?? "";

  return (
    <div className={styles.messageListWrapper}>
      <div className={styles.messageList} ref={listRef} onScroll={handleScroll}>
        <div className={styles.listInner}>
          {visibleCount < messages.length && (
            <div className={styles.historyHint}>
              {t("chat.historyOlder")}
            </div>
          )}
          {visibleMessages
            // Filter out ghost assistant messages: empty content + no thinking +
            // not currently streaming. These are leftover placeholders from
            // duplicate message_start events that were never filled with content.
            .filter(
              (msg) =>
                msg.role === "user" ||
                !!(
                  msg.content?.trim() ||
                  msg.thinking?.trim() ||
                  msg.isStreaming ||
                  msg.toolExecutions?.length
                )
            )
            .map((msg) => {
              const highlight = msg.id === activeId;
              if (msg.role === "user") {
                return <UserMessage key={msg.id} message={msg} highlight={highlight} />;
              }
              return <AssistantMessage key={msg.id} message={msg} highlight={highlight} />;
            })}
          <div className={styles.scrollAnchor} ref={anchorRef} />
        </div>
      </div>
      {showJump && (
        <button
          className={styles.jumpButton}
          onClick={scrollToBottom}
          title={t("chat.scrollToBottom")}
          aria-label={t("chat.scrollToBottom")}
        >
          <ArrowDown size={18} />
        </button>
      )}
    </div>
  );
}
