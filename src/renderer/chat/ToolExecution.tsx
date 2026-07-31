import { useState } from "react";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react";
import type { ToolExecution as ToolExecutionType } from "../store/agent-store";
import styles from "./ToolExecution.module.css";

export default function ToolExecution({ execution }: { execution: ToolExecutionType }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={styles.toolExecution}>
      <div className={styles.header} onClick={() => setExpanded(!expanded)}>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Wrench size={12} />
        <span className={styles.toolName}>{execution.toolName}</span>
        {execution.isRunning && <div className={styles.spinner} />}
        {!execution.isRunning && (
          <span className={`${styles.statusTag} ${execution.isError ? styles.statusError : styles.statusSuccess}`}>
            {execution.isError ? "Error" : "Done"}
          </span>
        )}
      </div>
      {expanded && (
        <div className={styles.body}>
          <div className={styles.input}>{JSON.stringify(execution.input, null, 2)}</div>
          {execution.output && <div className={styles.output}>{execution.output}</div>}
        </div>
      )}
    </div>
  );
}