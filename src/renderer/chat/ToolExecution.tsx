import { memo, useState } from "react";
import { ChevronRight, Search, FileText, Terminal, Pencil, Code2, Sparkles, Globe, type LucideIcon } from "lucide-react";
import type { ToolExecution as ToolExecutionType } from "../store/agent-store";
import { useTranslation } from "react-i18next";
import ToolCard from "./ToolCard";
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

/**
 * 按工具名映射一个 DSH 风格的图标，让工具行一眼可辨类型
 * （browser/web / search / read / bash / write-edit / code / 其它）。
 */
function toolIcon(name: string): LucideIcon {
  const n = name.toLowerCase();
  // 浏览器 / 联网类工具统一走地球图标（与设置页 websearch 的图标语义一致）
  if (/browser|chrome|playwright|puppeteer|web|fetch|http|scrape|curl/.test(n)) return Globe;
  if (/search|grep|find/.test(n)) return Search;
  if (/read/.test(n)) return FileText;
  if (/bash|shell|exec|terminal/.test(n)) return Terminal;
  if (/write|edit|create|patch/.test(n)) return Pencil;
  if (/code|diff/.test(n)) return Code2;
  return Sparkles;
}

function ToolExecution({ execution }: { execution: ToolExecutionType }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const argsSummary = summarizeArgs(execution.toolName, execution.input);

  const status = execution.isRunning
    ? "running"
    : execution.isError
      ? "error"
      : "done";
  // cordis_ 前缀的扩展工具走品牌色（对齐 DSH 的 state-business 语义）。
  const isCordis = execution.toolName.startsWith("cordis_");
  const statusText = execution.isRunning
    ? t("chat.statusRunning")
    : execution.isError
      ? t("chat.statusError")
      : t("chat.statusDone");
  const ToolIcon = toolIcon(execution.toolName);

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
        <ToolIcon size={15} className={`${styles.toolIcon} ${isCordis ? styles.toolIconBrand : ""}`} />
        <span
          className={`${styles.label} ${isCordis ? styles.labelBrand : ""} ${
            execution.isRunning ? styles.labelRunning : ""
          }`}
        >
          {execution.toolName}
        </span>
        {argsSummary && (
          <span className={styles.queryChip} title={argsSummary}>
            {argsSummary}
          </span>
        )}
        <span className={styles.status}>
          <span className={styles.statusDot} data-state={status} aria-hidden="true" />
          <span className={styles.srOnly}>{statusText}</span>
        </span>
      </button>
      {/* 平滑高度动画：grid-rows 0fr↔1fr，配合 collapseInner 的 overflow:hidden。
          内容始终挂载，开合不跳动（对齐 assistant-ui tool-call 的 disclosure 行为）。 */}
      <div className={`${styles.collapsePanel} ${expanded ? styles.collapseOpen : ""}`}>
        <div className={styles.collapseInner}>
          <div className={styles.body}>
            <ToolCard execution={execution} />
          </div>
        </div>
      </div>
    </div>
  );
}

// Tool results only change when the SDK emits tool_execution_start/end for
// THIS execution; the object reference stays identical otherwise.
export default memo(ToolExecution, (prev, next) => prev.execution === next.execution);
