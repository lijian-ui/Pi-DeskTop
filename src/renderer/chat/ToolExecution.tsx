import { memo, useState } from "react";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react";
import type { ToolExecution as ToolExecutionType } from "../store/agent-store";
import styles from "./ToolExecution.module.css";

/**
 * 从工具参数中提炼一行摘要，直接在 header 显示（不用展开就能看到参数）。
 *
 * 规则：
 *  - arguments 可能是 JSON 字符串或对象，先归一化成对象
 *  - 按工具名优先取关键字段（bash→command、read/write→filePath、grep→pattern…）
 *  - 单字段对象直接显示值；多字段回退紧凑 JSON
 */
function summarizeArgs(toolName: string, input: any): string {
  if (input == null) return "";
  let obj: any = input;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return obj; // 不是 JSON，原样显示
    }
  }
  if (typeof obj === "string") return obj;
  if (typeof obj === "number" || typeof obj === "boolean") return String(obj);
  if (Array.isArray(obj)) return JSON.stringify(obj);
  if (typeof obj !== "object") return "";

  // Pi SDK 内置工具（docs/sdk.md:492）：read / bash / edit / write / grep / find / ls
  const byTool: Record<string, string[]> = {
    bash: ["command"],
    read: ["filePath", "path", "file"],
    write: ["filePath", "path", "file"],
    edit: ["filePath", "path", "file"],
    grep: ["pattern", "query"],
    find: ["path", "dir", "name"],
    ls: ["path", "dir"],
  };
  const preferred = byTool[toolName] ?? [];
  for (const k of preferred) {
    const v = obj[k];
    if (v != null) {
      return typeof v === "string" ? v : JSON.stringify(v);
    }
  }

  const keys = Object.keys(obj);
  if (keys.length === 1) {
    const v = obj[keys[0]];
    return typeof v === "string" ? v : JSON.stringify(v);
  }
  try {
    return JSON.stringify(obj);
  } catch {
    return "";
  }
}

function ToolExecution({ execution }: { execution: ToolExecutionType }) {
  const [expanded, setExpanded] = useState(false);
  const argsSummary = summarizeArgs(execution.toolName, execution.input);

  return (
    <div className={styles.toolExecution}>
      <div className={styles.header} onClick={() => setExpanded(!expanded)}>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Wrench size={12} />
        <span className={styles.toolName}>{execution.toolName}</span>
        {argsSummary && (
          <span className={styles.argsSummary} title={argsSummary}>
            {argsSummary}
          </span>
        )}
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

// Tool results only change when the SDK emits tool_execution_start/end for
// THIS execution; the object reference stays identical otherwise.
export default memo(ToolExecution, (prev, next) => prev.execution === next.execution);
