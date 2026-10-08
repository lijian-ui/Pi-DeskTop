import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./BashApprovalModal.module.css";

/**
 * MCP 授权弹窗：交互式会话里模型调用 MCP 工具时，主进程按服务器粒度请求用户确认。
 * 与 BashApprovalModal 一样渲染在 ChatComposer 内（输入框上方），本地维护请求队列。
 */
interface McpRequest {
  requestId: number;
  server: string;
  cwd?: string;
  sessionPath?: string | null;
}

export default function McpApprovalModal() {
  const [current, setCurrent] = useState<McpRequest | null>(null);
  const [queue, setQueue] = useState<McpRequest[]>([]);
  const currentRef = useRef<McpRequest | null>(null);

  const advance = useCallback(() => {
    setQueue((q) => {
      const [next, ...rest] = q;
      currentRef.current = next ?? null;
      setCurrent(next ?? null);
      return rest;
    });
  }, []);

  useEffect(() => {
    const off = window.piDesk.onMcpApprovalRequest((data) => {
      const req: McpRequest = {
        requestId: data.requestId,
        server: data.server,
        cwd: data.cwd,
        sessionPath: data.sessionPath ?? null,
      };
      setQueue((q) => {
        if (currentRef.current) return [...q, req];
        currentRef.current = req;
        setCurrent(req);
        return q;
      });
    });
    return off;
  }, []);

  if (!current) return null;

  const respond = (decision: "allow" | "deny" | "allow-session") => {
    void window.piDesk.respondMcpApproval({ requestId: current.requestId, decision });
    advance();
  };

  const cwdDir = current.cwd
    ? current.cwd.split(/[\\/]/).filter(Boolean).pop() ?? current.cwd
    : null;

  return (
    <div className={styles.popup}>
      <div className={styles.header}>
        <span className={styles.title}>确认调用 MCP 服务器</span>
        {cwdDir && (
          <span className={styles.cwdTag} title={current.cwd}>
            {cwdDir}
          </span>
        )}
      </div>
      <div className={styles.hint}>
        模型请求调用 MCP 服务器「{current.server}」提供的工具，是否允许？
      </div>
      {queue.length > 0 && (
        <div className={styles.queueHint}>还有 {queue.length} 个待确认请求在排队</div>
      )}
      <pre className={styles.command}>{current.server}</pre>
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
          title="本次会话内该服务器的后续调用不再询问"
        >
          允许本次会话
        </button>
      </div>
    </div>
  );
}
