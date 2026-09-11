import { memo, useState } from "react";
import { ChevronRight, Check, AlertTriangle, Loader2 } from "lucide-react";
import type { ToolExecution as ToolExecutionType } from "../store/agent-store";
import { useTranslation } from "react-i18next";
import styles from "./ToolExecution.module.css";

/** Tool outputs longer than this are collapsed with a "Show full output" button. */
const OUTPUT_TRUNCATE_LENGTH = 5000;

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
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(false);
  const argsSummary = summarizeArgs(execution.toolName, execution.input);

  // Truncate very long tool outputs (e.g. build logs) to avoid rendering
  // megabytes of text. The full output is still stored in execution.output;
  // clicking "Show full output" renders the complete text.
  const outputTruncated =
    !outputExpanded &&
    typeof execution.output === "string" &&
    execution.output.length > OUTPUT_TRUNCATE_LENGTH;

  const status = execution.isRunning
    ? "running"
    : execution.isError
      ? "error"
      : "done";

  return (
    <div className={styles.toolExecution} data-status={status}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className={`${styles.chevron} ${expanded ? styles.chevronOpen : ""}`}>
          <ChevronRight size={14} />
        </span>
        <span className={`${styles.label} ${execution.isRunning ? styles.labelRunning : ""}`}>
          {execution.toolName}
        </span>
        {argsSummary && (
          <span className={styles.queryChip} title={argsSummary}>
            {argsSummary}
          </span>
        )}
        <span className={styles.status}>
          {execution.isRunning ? (
            <Loader2 size={12} className={styles.spinner} />
          ) : execution.isError ? (
            <AlertTriangle size={12} className={styles.statusIconError} />
          ) : (
            <Check size={12} className={styles.statusIconDone} />
          )}
        </span>
      </button>
      {/* 平滑高度动画：grid-rows 0fr↔1fr，配合 collapseInner 的 overflow:hidden。
          内容始终挂载，开合不跳动（对齐 assistant-ui tool-call 的 disclosure 行为）。 */}
      <div className={`${styles.collapsePanel} ${expanded ? styles.collapseOpen : ""}`}>
        <div className={styles.collapseInner}>
          <div className={styles.body}>
            <div className={styles.section}>
              <div className={styles.sectionLabel}>{t("chat.toolRequest")}</div>
              <div className={styles.code}>
                {JSON.stringify(execution.input, null, 2)}
              </div>
            </div>
            {execution.output && (
              <div className={styles.section}>
                <div className={styles.sectionLabel}>{t("chat.toolResult")}</div>
                <div className={styles.code}>
                  {outputTruncated
                    ? execution.output!.slice(0, OUTPUT_TRUNCATE_LENGTH)
                    : execution.output}
                  {outputTruncated && (
                    <button
                      className={styles.expandOutput}
                      onClick={(e) => {
                        e.stopPropagation();
                        setOutputExpanded(true);
                      }}
                    >
                      {t("chat.showFullOutput", {
                        size: (execution.output!.length / 1024).toFixed(0),
                      })}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Tool results only change when the SDK emits tool_execution_start/end for
// THIS execution; the object reference stays identical otherwise.
export default memo(ToolExecution, (prev, next) => prev.execution === next.execution);
