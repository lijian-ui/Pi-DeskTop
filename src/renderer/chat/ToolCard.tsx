import { memo } from "react";
import type { ToolExecution as ToolExecutionType } from "../store/agent-store";
import { useTranslation } from "react-i18next";
import styles from "./ToolCard.module.css";

/** 工具族：决定展开体用哪种专用卡片（对标 DSH 的 variant 分类）。 */
type Family = "bash" | "read" | "write" | "edit" | "search" | "web" | "other";

function parseInput(input: any): Record<string, any> {
  if (input == null) return {};
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch {
      return {};
    }
  }
  if (typeof input === "object") return input as Record<string, any>;
  return {};
}

/** 按工具名归族（宽松正则，覆盖 Pi SDK 内置工具与常见同义名）。 */
function familyOf(toolName: string): Family {
  const n = toolName.toLowerCase();
  if (/^(bash|sh|shell|pwsh|powershell|exec|terminal|run_command|run-code|run_code|cmd)$/.test(n))
    return "bash";
  if (/^read|^cat$|read_image/.test(n)) return "read";
  if (/^write|^create|^save$/.test(n)) return "write";
  if (/^edit|^patch|^modify|^update$/.test(n)) return "edit";
  if (/grep|search|find|glob|ripgrep|^rg$|ag$/.test(n)) return "search";
  if (/web_fetch|^fetch|web_search|scrape|http_get|curl$/.test(n)) return "web";
  return "other";
}

/** LCS 行级 diff → 统一差异（unified diff，无上下文分组，足够阅读）。 */
type DiffOp = { type: " " | "-" | "+"; text: string };
function diffLines(oldText: string, newText: string): DiffOp[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const m = a.length;
  const n = b.length;
  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ type: " ", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "-", text: a[i] });
      i++;
    } else {
      ops.push({ type: "+", text: b[j] });
      j++;
    }
  }
  while (i < m) ops.push({ type: "-", text: a[i++] });
  while (j < n) ops.push({ type: "+", text: b[j++] });
  return ops;
}

/** 从 write/edit 参数提炼 旧/新 文本（兼容 snake_case / camelCase / edits 数组）。 */
function writeEditTexts(
  family: "write" | "edit",
  input: Record<string, any>,
): { filePath?: string; oldText: string; newText: string } {
  const filePath = input.filePath ?? input.path ?? input.file;
  if (family === "write") {
    return { filePath, oldText: "", newText: typeof input.content === "string" ? input.content : "" };
  }
  const edits = input.edits;
  if (Array.isArray(edits) && edits.length > 0) {
    const oldParts: string[] = [];
    const newParts: string[] = [];
    for (const e of edits) {
      if (e && typeof e === "object") {
        oldParts.push(
          typeof e.old_string === "string"
            ? e.old_string
            : typeof e.oldString === "string"
              ? e.oldString
              : "",
        );
        newParts.push(
          typeof e.new_string === "string"
            ? e.new_string
            : typeof e.newString === "string"
              ? e.newString
              : typeof e.replacement === "string"
                ? e.replacement
                : "",
        );
      }
    }
    return { filePath, oldText: oldParts.join("\n"), newText: newParts.join("\n") };
  }
  const oldStr = input.old_string ?? input.oldString ?? "";
  const newStr = input.new_string ?? input.newString ?? input.replacement ?? "";
  return {
    filePath,
    oldText: typeof oldStr === "string" ? oldStr : "",
    newText: typeof newStr === "string" ? newStr : "",
  };
}

/** 解析 bash 输出里的退出码 / 信号标记（Pi 工具以 `[exit code: N]` / `[killed by signal: X]` 结尾）。 */
function parseBash(
  input: Record<string, any>,
  output?: string,
): { command: string; cwd?: string; cleanOutput: string; exitCode?: number; signal?: string } {
  const command =
    typeof input.command === "string"
      ? input.command
      : typeof input.code === "string"
        ? input.code
        : typeof input.script === "string"
          ? input.script
          : "";
  const cwd = input.cwd ?? input.workdir ?? input.directory;
  let clean = output ?? "";
  let exitCode: number | undefined;
  let signal: string | undefined;
  const exitM = /\[exit code: (\d+)\]\s*$/m.exec(clean);
  if (exitM) {
    exitCode = Number(exitM[1]);
    clean = clean.slice(0, exitM.index).replace(/\n+$/, "");
  }
  const sigM = /\[killed by signal: ([^\]\n]+)\]\s*$/m.exec(clean);
  if (sigM) {
    signal = sigM[1];
    clean = clean.slice(0, sigM.index).replace(/\n+$/, "");
  }
  return { command, cwd, cleanOutput: clean, exitCode, signal };
}

/** 解析 grep/search 输出里的 `path:line:col:match` 行。 */
function parseSearch(output?: string): { path: string; line: string; text: string }[] | null {
  if (!output) return null;
  const re = /^\s*([^:\n]+?):(\d+)(?::(\d+))?[:\s]\s?(.*)$/;
  const out: { path: string; line: string; text: string }[] = [];
  for (const line of output.split("\n")) {
    const m = re.exec(line);
    if (m) out.push({ path: m[1].trim(), line: m[2], text: (m[4] ?? "").trim() });
  }
  return out.length > 0 ? out : null;
}

/** 从 web/fetch 输出抽取 URL，做引用列表。 */
function parseWeb(output?: string): string[] | null {
  if (!output) return null;
  const re = /https?:\/\/[^\s)<>"']+/g;
  const set = new Set<string>();
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(output))) set.add(mm[0]);
  return set.size > 0 ? [...set] : null;
}

/**
 * 工具展开体：按工具族渲染专用卡片，替换原来的裸 JSON 输入/输出。
 *  - bash/terminal：命令 + 退出码 + 终端风格输出（滚动在卡内）
 *  - read：文件路径 + 带行号的文件内容
 *  - write/edit：LCS 行差异（+/− 着色）
 *  - search/grep：path:line 匹配列表
 *  - web/fetch：URL 引用列表
 *  - other：JSON 输入 + 结果文本（兜底）
 * 全部颜色走 CSS 变量，暗/亮主题自适应；卡内滚动，不撑爆回复区。
 */
function ToolCard({ execution }: { execution: ToolExecutionType }) {
  const { t } = useTranslation();
  const input = parseInput(execution.input);
  const family = familyOf(execution.toolName);
  const output = typeof execution.output === "string" ? execution.output : undefined;

  if (family === "bash") {
    const { command, cwd, cleanOutput, exitCode, signal } = parseBash(input, output);
    const failed = exitCode !== undefined && exitCode !== 0;
    return (
      <div className={styles.card}>
        <div className={styles.terminalHeader}>
          <span className={styles.prompt}>$</span>
          <code className={styles.command}>{command || execution.toolName}</code>
          {cwd && <span className={styles.cwd}>{cwd}</span>}
          {exitCode !== undefined && (
            <span className={`${styles.exitPill} ${failed ? styles.exitFail : styles.exitOk}`}>
              {t("chat.terminalExitCode")} {exitCode}
              {signal ? ` · ${signal}` : ""}
            </span>
          )}
        </div>
        <pre className={styles.terminal}>{cleanOutput || " "}</pre>
      </div>
    );
  }

  if (family === "read") {
    const filePath = input.filePath ?? input.path ?? input.file ?? execution.filePath;
    const lines = (output ?? "").split("\n");
    return (
      <div className={styles.card}>
        {filePath && <div className={styles.fileHeader}>{filePath}</div>}
        <div className={styles.codeScroll}>
          {lines.map((ln, idx) => (
            <div key={idx} className={styles.codeRow}>
              <span className={styles.lineNo}>{idx + 1}</span>
              <code className={styles.lineText}>{ln || " "}</code>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (family === "write" || family === "edit") {
    const { filePath, oldText, newText } = writeEditTexts(family, input);
    const ops = diffLines(oldText, newText);
    const added = ops.filter((o) => o.type === "+").length;
    const removed = ops.filter((o) => o.type === "-").length;
    return (
      <div className={styles.card}>
        {filePath && <div className={styles.fileHeader}>{filePath}</div>}
        <div className={styles.diffMeta}>{t("chat.diffChanged", { added, removed })}</div>
        <div className={styles.codeScroll}>
          {ops.map((op, idx) => (
            <div
              key={idx}
              className={`${styles.diffLine} ${op.type === "+" ? styles.diffAdd : op.type === "-" ? styles.diffDel : ""}`}
            >
              <span className={styles.diffGutter}>{op.type === " " ? " " : op.type}</span>
              <code className={styles.diffText}>{op.text || " "}</code>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (family === "search") {
    const matches = parseSearch(output);
    if (matches) {
      return (
        <div className={styles.card}>
          <div className={styles.searchMeta}>
            {matches.length} {t("chat.searchMatches")}
          </div>
          <div className={styles.codeScroll}>
            {matches.map((mt, idx) => (
              <div key={idx} className={styles.searchRow}>
                <span className={styles.searchLoc}>
                  {mt.path}:{mt.line}
                </span>
                <code className={styles.searchText}>{mt.text}</code>
              </div>
            ))}
          </div>
        </div>
      );
    }
  }

  if (family === "web") {
    const urls = parseWeb(output);
    if (urls) {
      return (
        <div className={styles.card}>
          <div className={styles.webList}>
            {urls.map((u, idx) => (
              <a key={idx} className={styles.webLink} href={u} target="_blank" rel="noopener noreferrer">
                {u}
              </a>
            ))}
          </div>
          {output && <pre className={styles.terminal}>{output}</pre>}
        </div>
      );
    }
  }

  // 兜底：通用 JSON 输入 + 结果文本
  return (
    <div className={styles.card}>
      <div className={styles.section}>
        <div className={styles.sectionLabel}>{t("chat.toolRequest")}</div>
        <pre className={styles.code}>{JSON.stringify(execution.input, null, 2)}</pre>
      </div>
      {output && (
        <div className={styles.section}>
          <div className={styles.sectionLabel}>{t("chat.toolResult")}</div>
          <pre className={styles.code}>{output}</pre>
        </div>
      )}
    </div>
  );
}

export default memo(ToolCard, (prev, next) => prev.execution === next.execution);
