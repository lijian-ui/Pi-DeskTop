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
  const queue = useBashGuardStore((s) => s.queue);
  const enqueuePending = useBashGuardStore((s) => s.enqueuePending);
  const respondAndAdvance = useBashGuardStore((s) => s.respondAndAdvance);

  useEffect(() => {
    window.piDesk.setBashGuardMode(useBashGuardStore.getState().mode);
    const off = window.piDesk.onBashApprovalRequest((data) => {
      enqueuePending({
        requestId: data.requestId,
        command: data.command,
        cwd: data.cwd,
        sessionPath: data.sessionPath ?? null,
      });
    });
    return off;
  }, [enqueuePending]);

  if (!pending) return null;

  const respond = (
    decision: "allow" | "deny" | "allow-session" | "allow-whitelist",
  ) => {
    respondAndAdvance(pending.requestId, decision);
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
      {queue.length > 0 && (
        <div className={styles.queueHint}>还有 {queue.length} 个待审批命令在排队</div>
      )}
      <pre className={styles.command}>{pending.command}</pre>
      <div className={styles.actions}>
        <button className={styles.deny} onClick={() => respond("deny")}>
          拒绝
        </button>
        <button className={styles.allow} onClick={() => respond("allow")}>
          允许
        </button>
        <button
          className={styles.allowWhitelist}
          onClick={() => respond("allow-whitelist")}
          title="放行本条命令，并将命令动词加入全局白名单（以后该命令全渠道免审批）"
        >
          允许并加入白名单
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
