import { useAgentStore } from "../store/agent-store";
import styles from "./StatusBar.module.css";

export default function StatusBar() {
  const isStreaming = useAgentStore((s) => s.isStreaming);
  const model = useAgentStore((s) => s.model);
  const thinkingLevel = useAgentStore((s) => s.thinkingLevel);

  return (
    <div className={styles.statusBar}>
      <div className={styles.left}>
        <div className={styles.item}>
          <div className={`${styles.dot} ${isStreaming ? styles.dotStreaming : ""}`} />
          <span>{isStreaming ? "Thinking..." : "Ready"}</span>
        </div>
        {model && <span>{model.name ?? `${model.provider}/${model.id}`}</span>}
        {thinkingLevel && thinkingLevel !== "off" && <span>Think: {thinkingLevel}</span>}
      </div>
      <div className={styles.right}>
        <span>Pi Desktop</span>
      </div>
    </div>
  );
}