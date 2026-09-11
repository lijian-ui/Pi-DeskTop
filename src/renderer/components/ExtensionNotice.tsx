import { useEffect, useState } from "react";
import { X, Copy, Check, Info, AlertTriangle, CircleX } from "lucide-react";
import styles from "./ExtensionNotice.module.css";

/**
 * Renders `ctx.ui.notify()` messages coming from extensions.
 *
 * Extensions surface user-visible results exclusively through notify — for
 * pi-hermes-memory that is the background review ("Memory auto-reviewed and
 * updated") and the correction detector ("Correction detected — memory
 * updated"). Before the main process bound a UI context those notices were
 * dropped by the SDK's no-op fallback, so the memory system looked completely
 * inert even while it was working.
 *
 * Deliberately not an auto-dismissing toast: these messages are worth reading
 * and often multi-line, so they are dismissible cards with a scrollable body.
 */

interface Notice {
  id: number;
  message: string;
  type: "info" | "warning" | "error";
}

/** Oldest cards are dropped first once the stack grows past this. */
const MAX_NOTICES = 4;

let noticeSeq = 0;

function TypeIcon({ type }: { type: Notice["type"] }) {
  if (type === "error") return <CircleX size={13} />;
  if (type === "warning") return <AlertTriangle size={13} />;
  return <Info size={13} />;
}

export default function ExtensionNotice() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  useEffect(() => {
    const offNotice = window.piDesk.onExtensionNotice((info) => {
      setNotices((prev) => {
        const next = [
          ...prev,
          { id: ++noticeSeq, message: info.message, type: info.type ?? "info" },
        ];
        return next.length > MAX_NOTICES ? next.slice(next.length - MAX_NOTICES) : next;
      });
    });
    return offNotice;
  }, []);

  if (notices.length === 0) return null;

  const dismiss = (id: number) => {
    setNotices((prev) => prev.filter((n) => n.id !== id));
    setCopiedId((cur) => (cur === id ? null : cur));
  };

  const copy = async (n: Notice) => {
    try {
      await navigator.clipboard.writeText(n.message);
      setCopiedId(n.id);
      window.setTimeout(() => {
        setCopiedId((cur) => (cur === n.id ? null : cur));
      }, 1500);
    } catch {
      // Clipboard blocked (no focus / permission); the text stays selectable.
    }
  };

  return (
    <div className={styles.stack}>
      {notices.map((n) => (
        <div key={n.id} className={`${styles.card} ${styles[n.type]}`}>
          <div className={styles.header}>
            <span className={styles.icon}>
              <TypeIcon type={n.type} />
            </span>
            <span className={styles.title}>命令输出</span>
            <span className={styles.spacer} />
            <button
              type="button"
              className={styles.action}
              title="复制"
              onClick={() => void copy(n)}
            >
              {copiedId === n.id ? <Check size={12} /> : <Copy size={12} />}
            </button>
            <button
              type="button"
              className={styles.action}
              title="关闭"
              onClick={() => dismiss(n.id)}
            >
              <X size={12} />
            </button>
          </div>
          <pre className={styles.body}>{n.message}</pre>
        </div>
      ))}
    </div>
  );
}
