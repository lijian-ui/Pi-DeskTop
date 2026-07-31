import { useEffect } from "react";
import { useBashGuardStore } from "../store/bashGuard-store";
import styles from "./BashApprovalModal.module.css";

/**
 * Popup shown when the main process intercepts a bash command that needs the
 * user's approval (mode "ask" + not whitelisted/blacklisted). Rendered inside
 * ChatComposer (above the input area) — no full-page overlay.
 */
export default function BashApprovalModal() {
  const pending = useBashGuardStore((s) => s.pending);
  const setPending = useBashGuardStore((s) => s.setPending);

  useEffect(() => {
    window.piDesk.setBashGuardMode(useBashGuardStore.getState().mode);
    const off = window.piDesk.onBashApprovalRequest((data) => {
      setPending({
        requestId: data.requestId,
        command: data.command,
        cwd: data.cwd,
        sessionPath: data.sessionPath ?? null,
      });
    });
    return off;
  }, [setPending]);

  if (!pending) return null;

  const respond = (decision: "allow" | "deny" | "allow-session") => {
    window.piDesk.respondBashApproval({ requestId: pending.requestId, decision });
    setPending(null);
  };

  // Folder name of the owning workspace, so the user knows WHICH cwd this
  // approval belongs to during concurrent multi-cwd runs.
  const cwdDir = pending.cwd
    ? pending.cwd.split(/[\\/]/).filter(Boolean).pop() ?? pending.cwd
    : null;

  return (
    <div className={styles.popup}>
      <div className={styles.header}>
        <span className={styles.title}>确认执行命令</span>
        {cwdDir && <span className={styles.cwdTag} title={pending.cwd}>{cwdDir}</span>}
      </div>
      <div className={styles.hint}>模型请求执行以下 bash 命令，是否允许？（仅对本工作目录生效）</div>
      <pre className={styles.command}>{pending.command}</pre>
      <div className={styles.actions}>
        <button className={styles.deny} onClick={() => respond("deny")}>
          拒绝
        </button>
        <button className={styles.allow} onClick={() => respond("allow")}>
          允许
        </button>
        <button
          className={styles.allowSession}
          onClick={() => respond("allow-session")}
        >
          允许本次会话
        </button>
      </div>
    </div>
  );
}
