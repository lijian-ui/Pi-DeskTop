/**
 * Browser audit — 动作级审计日志（append-only JSONL）。
 *
 * 落点：`<agentDir>/logs/browser-audit-YYYY-MM-DD.jsonl`，一行一个动作。
 * 目的：回答"某个时间点，模型在哪个页面上、以你的身份做了什么"这个事后追责问题。
 * 既有日志通道（`logger.ts` 把主进程 console.* 镜像到 `logs/YYYY-MM-DD.log`）是给排查
 * 用的、无结构；审计需要**结构化 + 可过滤 + 不丢**，故单独成一份 JSONL。
 *
 * 记录原则：
 *  - 保留审计价值：动作名、驱动、是否无人值守、URL、uid/selector、按键与修饰键、
 *    **上传的本机路径**（这是追责的关键）、成败与错误摘要。
 *  - 不记录可回放的内容：`text`（输入正文）只留长度；`expression` 截断（它本身就是
 *    "干了什么"的核心证据，故保留但限长）。
 *  - **被门禁拒绝的尝试也记** —— 拦截事件往往比成功事件更值得看。
 *  - 任何写盘异常都不得影响主流程（全部吞掉）。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface BrowserAuditEntry {
  /** ISO 时间戳。 */
  ts: string;
  unattended: boolean;
  action: string;
  ok: boolean;
  url?: string;
  error?: string;
  detail?: Record<string, unknown>;
}

const MAX_EXPRESSION_CHARS = 200;
const MAX_ERROR_CHARS = 300;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * 脱敏后的动作参数摘要。
 * 只挑"能说明干了什么、但不含可回放内容"的字段。
 */
export function summarizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [
    "uid",
    "selector",
    "targetId",
    "key",
    "fromUid",
    "toUid",
    "submit",
    "pressEnter",
    "format",
    "paths",
    "delta",
  ]) {
    if (params[key] !== undefined) out[key] = params[key];
  }
  const mods = params.modifiers as Record<string, unknown> | undefined;
  if (mods && typeof mods === "object") {
    const active = Object.keys(mods).filter((name) => mods[name] === true);
    if (active.length) out.modifiers = active;
  }
  if (typeof params.url === "string") out.url = params.url;
  // 输入正文不回放，只留长度（否则审计文件本身就成了敏感数据副本）。
  if (typeof params.text === "string") out.textChars = params.text.length;
  // evaluate 的表达式是审计的核心证据，保留但限长。
  if (typeof params.expression === "string") out.expression = truncate(params.expression, MAX_EXPRESSION_CHARS);
  return out;
}

function localDate(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 审计文件路径（供 status / 排查展示）。 */
export function browserAuditFile(): string {
  return join(getAgentDir(), "logs", `browser-audit-${localDate()}.jsonl`);
}

/**
 * 追加一条审计记录。**永不抛错** —— 审计失败不能影响业务动作本身。
 */
export function appendBrowserAudit(entry: Omit<BrowserAuditEntry, "ts"> & { ts?: string }): void {
  try {
    const dir = join(getAgentDir(), "logs");
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      ts: entry.ts ?? new Date().toISOString(),
      unattended: entry.unattended,
      action: entry.action,
      ok: entry.ok,
      ...(entry.url ? { url: entry.url } : {}),
      ...(entry.error ? { error: truncate(entry.error, MAX_ERROR_CHARS) } : {}),
      ...(entry.detail ? { detail: entry.detail } : {}),
    });
    appendFileSync(browserAuditFile(), `${line}\n`, "utf-8");
  } catch {
    // 静默：磁盘满 / 权限不足等都不应打断浏览器操作。
  }
}
