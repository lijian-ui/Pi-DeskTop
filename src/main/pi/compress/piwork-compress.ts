/**
 * piwork-compress —— 自研上下文压缩扩展（纯 pi API，pi-desktop 与 Pi-Work 双端同源）。
 *
 * 设计出处：仓库根 `COMPRESS_EXTENSION_DEV_PLAN.md`（§2–§5 机制、§7.2 教义定稿）。
 * 机制逐字借鉴处标注 `ref:`，指向 billion-context-pi（BC）源码或 acp-kernel 还原源行号。
 *
 * 一句话形态：接管 pi 的内置压缩（`session_before_compact` → cancel），改为
 * 「模型自己写摘要、按 ref 区间折叠」的 compress 工具：
 *   - 每条 user / tool 消息尾部注入隐形标签 `<wc tokens="2.1K" type="bash">m00175</wc>`；
 *   - 账本 derive-only：压缩块从会话转录里已成功执行的 compress 调用重放得到，零新增落盘；
 *   - 视图管线：ref → 账本 → hide 已消费调用 → 折叠 + 摘要注入 → 标签 → nudge → 应急截断。
 *
 * 关键取舍（详见文档对应小节）：
 *   - ref 用「上下文条目序列下标」确定性重算（AgentMessage 没有 id 字段），序列 append-only
 *     ⇒ 历次分配一致；分支 / rewind 会整体重排，此时旧 compress 调用在重放校验里整条跳过
 *     （宁漏不错，见 §5.6）。
 *   - 摘要角色用 `role:"custom" / customType:"wc-summary"`：转录层它是「非对话 meta」，
 *     LLM 层由 convertToLlm 映射成 user（ref: core/messages.js:75-123），教义里仍称其为
 *     系统元数据 —— 与 BC 同款矛盾，刻意为之（§5.5）。
 *   - 被砍能力（decompress / search_context / 状态旁路文件 / 塔式蒸馏）不在本文件任何文案里出现。
 */
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import {
  defineTool,
  getAgentDir,
  type AgentToolResult,
  type ExtensionAPI,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

// ── 开关配置（~/.pi/agent/compress-config.json）─────────────────────────────
// 风格照 browser-config.ts：工厂加载时同步读一次；关 → 直接 return，不注册工具、
// 不挂任何事件（模型完全看不到本扩展的痕迹）。BOM 必须先剥，否则 Windows 记事本
// 另存的 UTF-8 会让 JSON.parse 抛错并被静默吞掉（enabled 悄悄变回 false）。
export interface CompressConfig {
  /** 总开关，缺省 **关**（灰度实验）。 */
  enabled: boolean;
  /** 整段替换默认教义（§7.3 的最小覆盖语义）。空 / 缺省 = 用内置教义。 */
  doctrineOverride?: string;
}

const COMPRESS_CONFIG_FILE = "compress-config.json";

function compressConfigPath(): string {
  return join(getAgentDir(), COMPRESS_CONFIG_FILE);
}

/** 去掉 UTF-8 BOM（用码位判断，避免源码里嵌不可见字符）。 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readCompressConfigSync(): CompressConfig {
  try {
    const text = stripBom(readFileSync(compressConfigPath(), "utf-8"));
    const raw = JSON.parse(text) as Record<string, unknown>;
    const override = raw.doctrineOverride;
    return {
      enabled: raw.enabled === true,
      doctrineOverride:
        typeof override === "string" && override.trim() !== "" ? override : undefined,
    };
  } catch {
    return { enabled: false };
  }
}

/** 读-改-写整对象：禁止用裸 `{ enabled }` 覆盖，否则会冲掉 doctrineOverride。 */
export async function writeCompressConfig(patch: Partial<CompressConfig>): Promise<void> {
  const current = readCompressConfigSync();
  const next: CompressConfig = { ...current, ...patch };
  if (!next.doctrineOverride) delete next.doctrineOverride;
  const path = compressConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2), "utf-8");
}

// ── 常量（一期不开放配置，一律用 BC 默认值硬编码，见文档 §8）─────────────────
/** ref 形态 mNNNNN（ref: kernel src/refs.ts:31）。 */
const REF_PATTERN = /^m0*(\d{1,5})$/;
/** 账本自身永不压缩（它的 summary 参数就是账本内容）。ref: kernel protected.d.ts:9。 */
const ALWAYS_PROTECTED_TOOLS = ["compress"];
/** 这两类调用不占「最后 5 条」保护名额。ref: kernel NEVER_PRESERVE_RECENT_TOOLS。 */
const NEVER_PRESERVE_RECENT_TOOLS = ["read", "bash"];
const PRESERVE_RECENT_MESSAGES = 5;
const PRESERVE_RECENT_TOKENS = 5000;
/** 图片按固定成本计（ref: BC tokens.ts:17 IMAGE_TOKEN_COST）。 */
const IMAGE_TOKEN_COST = 1600;
/** 区间可压字符下限（ref: kernel minCompressRange 5e3）。 */
const MIN_RANGE_CHARS = 5000;
const MIN_SUMMARY_CHARS = 50;
const MAX_SUMMARY_CHARS = 20000;
/** 增长门（ref: kernel src_config.ts:9-24）。 */
const MIN_CONTEXT_LIMIT_PCT = 0.45;
const MAX_CONTEXT_LIMIT_PCT = 0.75;
const GROWTH_FLOOR = 50000;
const MIN_GROWTH_RATIO = 0.45;
const EMERGENCY_PCT = 0.95;
const EMERGENCY_TARGET_RATIO = 0.9;
const TRUNCATE_MIN_TOKENS = 1000;
const TRUNCATE_KEEP_CHARS = 2000;
const TRUNCATE_MARKER = "[truncated for context space]";
/** 高压带额外要求的最低可回收量之外，还要求的增长（本实现的 C 通路，见 §5.7 注）。 */
const PRESSURE_GROWTH_TOKENS = 5000;
/** 候选区间之间允许被小块保护/覆盖消息打断的合并阈值（本实现自定，非 BC 参数）。 */
const RANGE_GAP_CHARS = 1000;
const DEFAULT_CONTEXT_WINDOW = 200_000;
/** 摘要合成消息的 customType（LLM 层由 convertToLlm 映射为 user 文本）。 */
const SUMMARY_CUSTOM_TYPE = "wc-summary";
const SUMMARY_HEADER = "[Compressed conversation section]";

// ── token 估算 ─────────────────────────────────────────────────────────────
/** CJK 感知：中文按 1 token/字，其余 4 字符/token。ref: kernel src_tokenize.ts:5-13。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[一-鿿぀-ヿ가-힯]/g) ?? []).length;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/** 标签里的体积口径：<1K 原值，<10K 保留一位小数，其余整数 K。 */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)));
  if (n < 10000) return `${(n / 1000).toFixed(1)}K`;
  return `${Math.round(n / 1000)}K`;
}

/** 工具返回值里的体积口径（ref: BC compress-tool.ts:20 formatK）。 */
function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n));
}

// ── 工作集投影 ─────────────────────────────────────────────────────────────
type CoreRole = "user" | "assistant" | "tool" | "meta";

interface CoreToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

/** 管线内部的消息形态（1:1 对应 event.messages 的一项）。 */
export interface CoreMsg {
  idx: number;
  /** AgentMessage 没有 id 字段 ⇒ 用序列下标当稳定 id（序列 append-only）。 */
  id: string;
  role: CoreRole;
  contentType: "text" | "tool-call" | "tool-result";
  toolName?: string;
  toolCallId?: string;
  toolCalls: CoreToolCall[];
  text: string;
  tokens: number;
  hasImages: boolean;
  isError: boolean;
}

function flattenParts(content: unknown): { text: string; images: number } {
  if (typeof content === "string") return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: "", images: 0 };
  let text = "";
  let images = 0;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: string; text?: string };
    if (p.type === "text" && typeof p.text === "string") {
      text += text ? `\n${p.text}` : p.text;
    } else if (p.type === "image") {
      images += 1;
    }
  }
  return { text, images };
}

/**
 * event.messages(AgentMessage[]) → CoreMsg[]。
 * 丢弃未知 role（ref: core/messages.js convertToLlm:75-123 对未知 role 同样丢弃），
 * 自定义 / bashExecution / branchSummary / compactionSummary 归一为 meta 文本。
 */
export function projectMessages(messages: readonly AgentMessage[]): CoreMsg[] {
  const out: CoreMsg[] = [];
  messages.forEach((msg, idx) => {
    const base = { idx, id: `e${idx}`, hasImages: false, isError: false, toolCalls: [] as CoreToolCall[] };
    const role = (msg as { role?: string }).role;
    if (role === "user") {
      const { text, images } = flattenParts((msg as { content?: unknown }).content);
      out.push({
        ...base,
        role: "user",
        contentType: "text",
        text,
        hasImages: images > 0,
        tokens: estimateTokens(text) + images * IMAGE_TOKEN_COST,
      });
      return;
    }
    if (role === "assistant") {
      const blocks = Array.isArray((msg as { content?: unknown }).content)
        ? ((msg as { content: unknown[] }).content as Array<Record<string, unknown>>)
        : [];
      let text = "";
      let thinkingChars = 0;
      let images = 0;
      const calls: CoreToolCall[] = [];
      for (const b of blocks) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text" && typeof b.text === "string") text += text ? `\n${b.text}` : b.text;
        else if (b.type === "thinking" && typeof b.thinking === "string") thinkingChars += b.thinking.length;
        else if (b.type === "image") images += 1;
        else if (b.type === "toolCall" && typeof b.id === "string" && typeof b.name === "string") {
          calls.push({ id: b.id, name: b.name, arguments: b.arguments });
        }
      }
      const callTokens = calls.reduce((n, c) => n + estimateTokens(safeJson(c.arguments)) + estimateTokens(c.name), 0);
      out.push({
        ...base,
        role: "assistant",
        contentType: calls.length > 0 ? "tool-call" : "text",
        toolCalls: calls,
        text,
        hasImages: images > 0,
        tokens: estimateTokens(text) + Math.ceil(thinkingChars / 4) + callTokens + images * IMAGE_TOKEN_COST,
      });
      return;
    }
    if (role === "toolResult") {
      const m = msg as { content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean };
      const { text, images } = flattenParts(m.content);
      out.push({
        ...base,
        role: "tool",
        contentType: "tool-result",
        toolName: typeof m.toolName === "string" ? m.toolName : undefined,
        toolCallId: typeof m.toolCallId === "string" ? m.toolCallId : undefined,
        text,
        hasImages: images > 0,
        isError: m.isError === true,
        tokens: estimateTokens(text) + images * IMAGE_TOKEN_COST,
      });
      return;
    }
    if (role === "custom" || role === "bashExecution" || role === "branchSummary" || role === "compactionSummary") {
      const m = msg as { content?: unknown; summary?: string; command?: string; output?: string };
      let text = "";
      if (typeof m.summary === "string") text = m.summary;
      else if (typeof m.command === "string") text = `$ ${m.command}\n${typeof m.output === "string" ? m.output : ""}`;
      else text = flattenParts(m.content).text;
      out.push({ ...base, role: "meta", contentType: "text", text, tokens: estimateTokens(text) });
      return;
    }
    // 未知 role：与 convertToLlm 一致地丢弃（不进视图，也就不会占 ref）。
  });
  return out;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

// ── ref 分配（derive-only：不落盘，每回合按序列重算）────────────────────────
export interface RefMap {
  /** core.id → "m00031"。 */
  byId: Map<string, string>;
  /** "m00031" → core.idx（区间解析与覆盖判定的唯一坐标）。 */
  indexByRef: Map<string, number>;
  /** 被硬保护、不分配 ref 的消息 id（带图 / compress 调用及其结果）。 */
  blocked: Set<string>;
}

/** 硬保护：带图消息与账本自身不分配 ref ⇒ 模型无从引用 ⇒ 永不可压。
 *  ref: kernel assignRefsNode 的 isProtected（带图 / 受保护工具）。 */
function isHardBlocked(m: CoreMsg): boolean {
  if (m.hasImages) return true;
  if (m.role === "assistant" && m.toolCalls.some((c) => ALWAYS_PROTECTED_TOOLS.includes(c.name))) return true;
  if (m.contentType === "tool-result" && ALWAYS_PROTECTED_TOOLS.includes(m.toolName ?? "")) return true;
  return false;
}

/**
 * 单调递增分配。序列 append-only ⇒ 同一条目历次分配结果一致，无需持久化。
 * 已知边界：分支 / rewind 会重排序列 ⇒ 整段 ref 变化 ⇒ 旧 compress 调用在
 * derive 重放里校验失败而整条跳过（宁漏不错，文档 §3 / §5.6）。
 */
export function assignRefs(core: CoreMsg[]): RefMap {
  const byId = new Map<string, string>();
  const indexByRef = new Map<string, number>();
  const blocked = new Set<string>();
  let i = 0;
  for (const m of core) {
    if (isHardBlocked(m)) {
      blocked.add(m.id);
      continue;
    }
    i += 1;
    const ref = `m${String(i).padStart(5, "0")}`;
    byId.set(m.id, ref);
    indexByRef.set(ref, m.idx);
  }
  return { byId, indexByRef, blocked };
}

/** mNNNNN（允许前导零缺位）→ 序号；非法返回 null。 */
function parseRefOrdinal(raw: string): number | null {
  const m = REF_PATTERN.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

// ── 保护区（尾部软保护区；硬保护区靠 BLOCKED 实现）─────────────────────────
/**
 * ref: kernel computeProtectedRefs（preserveRecentMessages:5 / preserveRecentTokens:5000）。
 * 三层：最后 5 条（read/bash 不占名额）∪ 尾部累计 5000 token ∪ 最近一条真实 user 消息。
 * 返回受保护的 **ref** 集合（BLOCKED 消息本来就没有 ref，不参与）。
 */
export function computeProtectedRefs(core: CoreMsg[], refs: RefMap): Set<string> {
  const protectedRefs = new Set<string>();
  const refAt = (idx: number): string | undefined => refs.byId.get(core[idx].id);

  let quota = 0;
  for (let i = core.length - 1; i >= 0 && quota < PRESERVE_RECENT_MESSAGES; i -= 1) {
    const m = core[i];
    const ownsQuota = !(m.contentType === "tool-result" && NEVER_PRESERVE_RECENT_TOOLS.includes(m.toolName ?? ""));
    const ref = refAt(i);
    if (ref) protectedRefs.add(ref);
    if (ownsQuota) quota += 1;
  }

  let acc = 0;
  for (let i = core.length - 1; i >= 0; i -= 1) {
    acc += core[i].tokens;
    const ref = refAt(i);
    if (ref) protectedRefs.add(ref);
    if (acc >= PRESERVE_RECENT_TOKENS) break;
  }

  for (let i = core.length - 1; i >= 0; i -= 1) {
    if (core[i].role !== "user") continue;
    const ref = refAt(i);
    if (ref) protectedRefs.add(ref);
    break;
  }
  return protectedRefs;
}

// ── 压缩块（账本）──────────────────────────────────────────────────────────
export interface FoldBlock {
  /** b1,b2,… 按重放顺序分配（不持久化：重放序 = 稳定序）。 */
  blockId: string;
  summary: string;
  topic?: string;
  directMessageIds: string[];
  directMessageIdxs: number[];
  compressedTokens: number;
  /** hide 判定 + 账本回链（BC 同款字段）。 */
  compressCallId: string;
  startRef: string;
  endRef: string;
  createdAt: number;
}

/** 校验类错误：一律以 throw 呈现，pi 才会把 toolResult 标成 isError。
 *  ref: BC compress-tool.ts:458-462 注释原文。 */
export class CompressValidationError extends Error {}

interface CompressEntry {
  startId: string;
  endId: string;
  summary: string;
  topic?: string;
}

/** 解析 compress 调用参数（工具执行与 derive 重放共用，保证两处判定一致）。 */
export function parseCompressEntries(args: unknown): CompressEntry[] {
  if (!args || typeof args !== "object") throw new CompressValidationError("compress expects an object with a `content` array.");
  const raw = args as Record<string, unknown>;
  const topTopic = typeof raw.topic === "string" ? raw.topic : undefined;
  const content = raw.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new CompressValidationError("compress expects `content` to be a non-empty array of { startId, endId, summary }.");
  }
  const entries: CompressEntry[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      throw new CompressValidationError("Each `content` entry must be an object with startId, endId and summary.");
    }
    const e = item as Record<string, unknown>;
    if (typeof e.startId !== "string" || typeof e.endId !== "string" || typeof e.summary !== "string") {
      throw new CompressValidationError("Each `content` entry must carry string startId, endId and summary.");
    }
    const topic = typeof e.topic === "string" && e.topic.trim() !== "" ? e.topic : topTopic;
    entries.push({ startId: e.startId, endId: e.endId, summary: e.summary, topic });
  }
  return entries;
}

function coveredIndexMap(blocks: readonly FoldBlock[]): Map<number, string> {
  const covered = new Map<number, string>();
  for (const b of blocks) for (const idx of b.directMessageIdxs) covered.set(idx, b.blockId);
  return covered;
}

interface PairMaps {
  callIdxById: Map<string, number>;
  resultIdxsByCall: Map<string, number[]>;
}

function buildPairMaps(core: CoreMsg[]): PairMaps {
  const callIdxById = new Map<string, number>();
  const resultIdxsByCall = new Map<string, number[]>();
  for (const m of core) {
    for (const c of m.toolCalls) callIdxById.set(c.id, m.idx);
    if (m.contentType === "tool-result" && m.toolCallId) {
      const list = resultIdxsByCall.get(m.toolCallId) ?? [];
      list.push(m.idx);
      resultIdxsByCall.set(m.toolCallId, list);
    }
  }
  return { callIdxById, resultIdxsByCall };
}

/** 一条边界消息是否会把 tool 对 / assistant turn 切开。 */
function breaksPair(idx: number, kept: Set<number>, core: CoreMsg[], pairs: PairMaps): boolean {
  const m = core[idx];
  if (m.contentType === "tool-result" && m.toolCallId) {
    const callIdx = pairs.callIdxById.get(m.toolCallId);
    if (callIdx === undefined || !kept.has(callIdx)) return true;
    return false;
  }
  if (m.role === "assistant" && m.toolCalls.length > 0) {
    for (const c of m.toolCalls) {
      const results = pairs.resultIdxsByCall.get(c.id) ?? [];
      // 结果还没落盘（本轮正在跑）时不算拆对：整条 turn 本来就在区间尾部之外。
      if (results.length === 0) continue;
      for (const r of results) if (!kept.has(r)) return true;
    }
  }
  return false;
}

export interface ResolvedRange {
  startRef: string;
  endRef: string;
  startIdx: number;
  endIdx: number;
  keptIdxs: number[];
  summary: string;
  topic?: string;
  chars: number;
  reversed: boolean;
  excludedRefs: string[];
  withdrewRefs: string[];
}

export interface BatchResult {
  ranges: ResolvedRange[];
  blocks: FoldBlock[];
  warnings: string[];
}

/**
 * 校验链（文档 §4.2 的 11 条）。任何一条硬错误都 throw；
 * 调用方（derive）捕获后 **整条 compress 调用跳过**，绝不部分成活（§5.6）。
 */
export function resolveAndValidateBatch(opts: {
  entries: CompressEntry[];
  core: CoreMsg[];
  refs: RefMap;
  existing: readonly FoldBlock[];
  protectedRefs: ReadonlySet<string>;
  blockIdOffset: number;
  callId: string;
}): BatchResult {
  const { entries, core, refs, existing, protectedRefs, blockIdOffset, callId } = opts;
  const covered = coveredIndexMap(existing);
  const pairs = buildPairMaps(core);
  const warnings: string[] = [];
  const resolved: ResolvedRange[] = [];

  for (const entry of entries) {
    const startRaw = entry.startId.trim();
    const endRaw = entry.endId.trim();
    // (1) 格式。ref: kernel :1752
    const startOrd = parseRefOrdinal(startRaw);
    const endOrd = parseRefOrdinal(endRaw);
    if (startOrd === null || endOrd === null) {
      throw new CompressValidationError(
        `Invalid boundary ref(s): startId="${entry.startId}", endId="${entry.endId}". Use mNNNNN.`,
      );
    }
    const canonical = (ord: number) => `m${String(ord).padStart(5, "0")}`;
    const startRef = canonical(startOrd);
    const endRef = canonical(endOrd);
    // (2) 存在性（BLOCKED 没有 ref，也归此条）。ref: kernel :1819
    const startIdx = refs.indexByRef.get(startRef);
    const endIdx = refs.indexByRef.get(endRef);
    if (startIdx === undefined) {
      throw new CompressValidationError(`startId="${startRaw}" does not exist in this session (typo or wrong session).`);
    }
    if (endIdx === undefined) {
      throw new CompressValidationError(`endId="${endRaw}" does not exist in this session (typo or wrong session).`);
    }
    // (3) 反向：交换不报错。ref: kernel :1770-1775
    let lo = startIdx;
    let hi = endIdx;
    const reversed = lo > hi;
    if (reversed) [lo, hi] = [hi, lo];

    // (4) 全是已覆盖。ref: kernel :5497
    const inRange: number[] = [];
    for (let i = lo; i <= hi; i += 1) if (refs.byId.has(core[i].id)) inRange.push(i);
    const fresh = inRange.filter((i) => !covered.has(i));
    if (fresh.length === 0) {
      const ids = Array.from(new Set(inRange.map((i) => covered.get(i)).filter((v): v is string => Boolean(v))));
      throw new CompressValidationError(
        `Range ${startRef}..${endRef} contains no new compressible messages — every message in it is already covered by active block(s) ${ids.join(", ") || "n/a"}. Nothing was compressed.`,
      );
    }

    // (5)(6) 保护区。ref: kernel :5442 / :5448
    const keptSet = new Set<number>();
    const excludedRefs: string[] = [];
    const protectedRefsInRange: string[] = [];
    for (const i of fresh) {
      const ref = refs.byId.get(core[i].id);
      if (ref && protectedRefs.has(ref)) {
        protectedRefsInRange.push(ref);
        excludedRefs.push(ref);
        continue;
      }
      keptSet.add(i);
    }
    if (keptSet.size === 0) {
      throw new CompressValidationError(
        `Range is entirely within the protected zone (the last 5 messages and/or the most recent user message): ${protectedRefsInRange.join(", ")}. Protected refs are hard-excluded — retargeting them in another call cannot succeed.`,
      );
    }
    if (excludedRefs.length > 0) {
      warnings.push(
        `Excluded ${excludedRefs.length} protected message(s) ${excludedRefs.join(", ")} from compression range (recent/last-user zone) — they stay visible outside the new block; do not target them in another compress call.`,
      );
    }

    // (7) 拆 pair / turn → 从两端撤回，迭代到不动点。ref: kernel computeIntegrityWithdrawals :5454-5477
    const withdrewRefs: string[] = [];
    for (;;) {
      const list = Array.from(keptSet).sort((a, b) => a - b);
      if (list.length === 0) break;
      const first = list[0];
      const last = list[list.length - 1];
      const firstBad = breaksPair(first, keptSet, core, pairs);
      const lastBad = last !== first && breaksPair(last, keptSet, core, pairs);
      if (!firstBad && !lastBad) break;
      if (firstBad) {
        keptSet.delete(first);
        const ref = refs.byId.get(core[first].id);
        if (ref) withdrewRefs.push(ref);
      }
      if (lastBad) {
        keptSet.delete(last);
        const ref = refs.byId.get(core[last].id);
        if (ref) withdrewRefs.push(ref);
      }
    }
    if (keptSet.size === 0) {
      throw new CompressValidationError(
        `Range ${startRef}..${endRef} would split a tool call/result pair — trimming it to whole turns left nothing to compress. Move startId/endId to turn boundaries.`,
      );
    }
    if (withdrewRefs.length > 0) {
      warnings.push(
        `Withdrew ${withdrewRefs.length} boundary message(s) ${withdrewRefs.join(", ")} from the range to keep tool call/result pairs intact.`,
      );
    }

    const keptIdxs = Array.from(keptSet).sort((a, b) => a - b);
    resolved.push({
      startRef: refs.byId.get(core[keptIdxs[0]].id) ?? startRef,
      endRef: refs.byId.get(core[keptIdxs[keptIdxs.length - 1]].id) ?? endRef,
      startIdx: keptIdxs[0],
      endIdx: keptIdxs[keptIdxs.length - 1],
      keptIdxs,
      summary: entry.summary,
      topic: entry.topic,
      chars: keptIdxs.reduce((n, i) => n + core[i].text.length, 0),
      reversed,
      excludedRefs,
      withdrewRefs,
    });
  }

  // (11) 同批相交：按解析后下标排序，后来的跳过 + 警告。ref: kernel :4853-4864
  resolved.sort((a, b) => a.startIdx - b.startIdx);
  const accepted: ResolvedRange[] = [];
  for (const r of resolved) {
    const clash = accepted.find((a) => r.keptIdxs.some((i) => a.keptIdxs.includes(i)));
    if (clash) {
      warnings.push(
        `Skipped range (${r.startRef}..${r.endRef}) — overlaps an earlier range in the batch; the earlier range takes precedence. Keep ranges disjoint.`,
      );
      continue;
    }
    accepted.push(r);
  }

  // (8) 批量可压字符量下限。ref: kernel minCompressRange
  const totalChars = accepted.reduce((n, r) => n + r.chars, 0);
  if (totalChars < MIN_RANGE_CHARS) {
    throw new CompressValidationError(
      `Total compressible content too small (${totalChars} chars across ${accepted.length} range(s), min ${MIN_RANGE_CHARS}). Nothing here is worth reclaiming yet — do not split it into another call.`,
    );
  }

  // (9)(10) 摘要长度。ref: kernel :5590 / :5596（超限抛错，不截断）
  for (const r of accepted) {
    const len = r.summary.length;
    if (len < MIN_SUMMARY_CHARS) {
      throw new CompressValidationError(
        `Summary too short (${len} chars, min ${MIN_SUMMARY_CHARS}). The summary must capture the compressed range's key information.`,
      );
    }
    if (len > MAX_SUMMARY_CHARS) {
      throw new CompressValidationError(
        `Summary too long (${len} chars, max ${MAX_SUMMARY_CHARS}). Strip noise — keep critical paths, decisions, errors, and code references. Compress fewer messages per range instead — don't lose critical info just to fit.`,
      );
    }
  }

  const blocks: FoldBlock[] = accepted.map((r, i) => ({
    blockId: `b${blockIdOffset + i + 1}`,
    summary: r.summary,
    topic: r.topic,
    directMessageIds: r.keptIdxs.map((idx) => core[idx].id),
    directMessageIdxs: [...r.keptIdxs],
    compressedTokens: r.keptIdxs.reduce((n, idx) => n + core[idx].tokens, 0),
    compressCallId: callId,
    startRef: r.startRef,
    endRef: r.endRef,
    createdAt: Date.now(),
  }));

  return { ranges: accepted, blocks, warnings };
}

/**
 * 账本 derive-only（文档 §5.6，全文档最关键一节）：从转录里已成功执行的 compress 调用重放。
 * ref: BC state-rebuild.ts:112-166 —— (1) 先扫 toolResult 分成功/失败；(2) 只重放成功的
 * compress 调用；(3) 用【当前视图】的 ref 直接校验（我们确定性重算，无需逐前缀重放）；
 * (4) 抛错 / 0 块 → 整条调用跳过，state 不动。
 */
export function deriveBlocks(core: CoreMsg[], refs: RefMap, protectedRefs: ReadonlySet<string>): FoldBlock[] {
  const succeeded = new Set<string>();
  for (const m of core) {
    if (m.contentType !== "tool-result" || !m.toolCallId) continue;
    if (!m.isError) succeeded.add(m.toolCallId);
  }
  const blocks: FoldBlock[] = [];
  for (const m of core) {
    if (m.role !== "assistant") continue;
    for (const call of m.toolCalls) {
      if (call.name !== "compress" || !succeeded.has(call.id)) continue;
      try {
        const entries = parseCompressEntries(call.arguments);
        const r = resolveAndValidateBatch({
          entries,
          core,
          refs,
          existing: blocks,
          protectedRefs,
          blockIdOffset: blocks.length,
          callId: call.id,
        });
        if (r.blocks.length === 0) continue;
        blocks.push(...r.blocks);
      } catch {
        // 区间失效不炸账本：整条调用跳过（宁漏不错）。
        continue;
      }
    }
  }
  return blocks;
}

// ── 隐形标签（ref: kernel src_render-refs.ts:45-57 + BC pi adapter messages.ts:483-539）──
const WC_TAG_RE = /\n\n<wc tokens="[^"]*" type="[^"]*">m\d{1,5}<\/wc>\s*$/;

/** 注入前先剥掉自身旧标签，防自增殖（ref: BC messages.ts:250-252 stripRefTag）。 */
export function stripWcTag(text: string): string {
  return text.replace(WC_TAG_RE, "");
}

function typeLabel(m: CoreMsg): string {
  if (m.role === "tool") return m.toolName || "tool";
  if (m.role === "user") return "user";
  return "meta";
}

function renderTag(ref: string, m: CoreMsg): string {
  return `<wc tokens="${formatTokens(m.tokens)}" type="${typeLabel(m)}">${ref}</wc>`;
}

function appendToParts(parts: readonly unknown[], tag: string): unknown[] {
  const out = parts.map((p) => (p && typeof p === "object" && (p as { type?: string }).type === "text" ? { ...(p as object) } : p));
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const p = out[i] as { type?: string; text?: string } | undefined;
    if (p && p.type === "text" && typeof p.text === "string" && p.text.trim() !== "") {
      const base = stripWcTag(p.text);
      p.text = base.trim() === "" ? tag : `${base}\n\n${tag}`;
      return out;
    }
  }
  out.push({ type: "text", text: tag });
  return out;
}

/**
 * 只对 user / tool 注入标签。assistant 一律不注入 —— 模型会把自己历史回复里的标签
 * 回声出来，终端出现标签残渣（ref: BC messages.ts:483 注释原文）。
 * 落点 = 最后一个非空 text block 末尾（pi adapter 实测比前缀更稳）。
 */
function injectTag(msg: AgentMessage, tag: string): AgentMessage {
  const role = (msg as { role?: string }).role;
  const content = (msg as { content?: unknown }).content;
  if (role === "user") {
    if (typeof content === "string") {
      const base = stripWcTag(content);
      return { ...(msg as object), content: base.trim() === "" ? tag : `${base}\n\n${tag}` } as AgentMessage;
    }
    if (Array.isArray(content)) return { ...(msg as object), content: appendToParts(content, tag) } as AgentMessage;
    return msg;
  }
  if (role === "toolResult") {
    if (!Array.isArray(content)) return msg;
    return { ...(msg as object), content: appendToParts(content, tag) } as AgentMessage;
  }
  return msg;
}

// ── 可压区间（nudge 与工具返回值共用）──────────────────────────────────────
export interface RangeInfo {
  startRef: string;
  endRef: string;
  startIdx: number;
  endIdx: number;
  msgCount: number;
  tokens: number;
  chars: number;
  toolPct: number;
  textPct: number;
}

/**
 * 连续可压 run（带 ref、未被块覆盖、不在保护区），被 <1000 字符的碎片隔断时合并，
 * 最后只保留 chars ≥ 5000 的区间 —— 与校验链 (8) 同口径（ref: kernel pendingByTier :1648-1678）。
 */
export function computeRanges(
  core: CoreMsg[],
  refs: RefMap,
  covered: ReadonlySet<number>,
  protectedRefs: ReadonlySet<string>,
): RangeInfo[] {
  const isCandidate = (i: number): boolean => {
    const ref = refs.byId.get(core[i].id);
    if (!ref || covered.has(i)) return false;
    return !protectedRefs.has(ref);
  };
  const runs: number[][] = [];
  let run: number[] = [];
  for (let i = 0; i < core.length; i += 1) {
    if (isCandidate(i)) {
      run.push(i);
    } else if (run.length > 0) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length > 0) runs.push(run);

  const merged: number[][] = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    if (prev) {
      let gapChars = 0;
      for (let i = prev[prev.length - 1] + 1; i < r[0]; i += 1) gapChars += core[i].text.length;
      if (gapChars < RANGE_GAP_CHARS) {
        prev.push(...r);
        continue;
      }
    }
    merged.push([...r]);
  }

  const out: RangeInfo[] = [];
  for (const r of merged) {
    const chars = r.reduce((n, i) => n + core[i].text.length, 0);
    if (chars < MIN_RANGE_CHARS) continue;
    const tokens = r.reduce((n, i) => n + core[i].tokens, 0);
    const toolTokens = r.reduce((n, i) => n + (core[i].contentType === "tool-result" ? core[i].tokens : 0), 0);
    const toolPct = tokens > 0 ? Math.round((toolTokens / tokens) * 100) : 0;
    out.push({
      startRef: refs.byId.get(core[r[0]].id) ?? "",
      endRef: refs.byId.get(core[r[r.length - 1]].id) ?? "",
      startIdx: r[0],
      endIdx: r[r.length - 1],
      msgCount: r.length,
      tokens,
      chars,
      toolPct,
      textPct: 100 - toolPct,
    });
  }
  return out.sort((a, b) => a.startIdx - b.startIdx);
}

/** 候选清单渲染。ref: kernel src_nudge-text.ts:193-206 模板。 */
export function renderRanges(ranges: readonly RangeInfo[]): string {
  const lines = [`Compressible ranges (${ranges.length}, oldest first):`];
  for (const r of ranges) {
    lines.push(
      `  ${r.startRef}–${r.endRef}  ${r.msgCount} msgs  ${formatTokens(r.tokens)} [tool ${r.toolPct}% | text ${r.textPct}%]`,
    );
  }
  return lines.join("\n");
}

/** nudge 文本。三条 BC 纪律：不披露占比、措辞是效率提醒而非溢出警告、给模型拒绝权。 */
export function renderNudge(blocks: readonly FoldBlock[], ranges: readonly RangeInfo[]): string {
  const head = [
    "This is an efficiency nudge to compress early and keep context lean — not an overflow warning.",
    "Compress consumed ranges now, or reply and continue working (you may compress later).",
  ];
  const blockLine =
    blocks.length > 0
      ? [`Compressed blocks: ${blocks.length} active — ${blocks.map((b) => `${b.blockId}=${b.startRef}–${b.endRef}`).join(", ")}`]
      : [];
  const first = ranges[0];
  const example = first
    ? [`Example: compress({ content: [{ startId: "${first.startRef}", endId: "${first.endRef}", summary: "..." }] })`]
    : [];
  return [...head, ...blockLine, renderRanges(ranges), ...example].join("\n");
}

// ── 会话状态（内存 Map，进程内；账本本身靠 derive 重放，不持久化）──────────
export interface SessionState {
  core: CoreMsg[];
  refs: RefMap;
  protectedRefs: Set<string>;
  blocks: FoldBlock[];
  usage: number;
  /** 窗口大小（低占用硬门 + 用量回显用），0 = 未知。 */
  contextWindow: number;
  userCount: number;
  /** 增长门基线；0 = 尚未记录。 */
  baseline: number;
  /** 上次发出 nudge 时的用量；0 = 从未。 */
  lastNudge: number;
  lastBlockCount: number;
  failCount: number;
  repeatSig: string;
  repeatCount: number;
}

export function createSessionState(): SessionState {
  return {
    core: [],
    refs: assignRefs([]),
    protectedRefs: new Set<string>(),
    blocks: [],
    usage: 0,
    contextWindow: 0,
    userCount: 0,
    baseline: 0,
    lastNudge: 0,
    lastBlockCount: 0,
    failCount: 0,
    repeatSig: "",
    repeatCount: 0,
  };
}

export interface UsageProbe {
  /** provider 上一轮报回的真实 prompt tokens（floor 校正用），未知为 null。 */
  tokens: number | null;
  contextWindow: number;
  systemPrompt: string;
}

export interface ViewResult {
  messages: AgentMessage[];
  usage: number;
  ranges: RangeInfo[];
  pendingTokens: number;
  nudged: boolean;
  truncated: number;
  blocks: FoldBlock[];
}

interface ViewItem {
  core: CoreMsg | null;
  msg: AgentMessage;
}

function summaryText(block: FoldBlock): string {
  return block.topic ? `${SUMMARY_HEADER} — ${block.topic}\n${block.summary}` : `${SUMMARY_HEADER}\n${block.summary}`;
}

/**
 * 摘要形态（文档 §5.5 的显式选型）：kernel 原始形态（摘要全文在场），但角色用
 * `custom`/`wc-summary` 而非 system —— 转录层它是「非对话 meta」，LLM 层由
 * convertToLlm 映射为 user（ref: core/messages.js:75-123），与教义 SUMMARIES IN CONTEXT
 * 里「系统元数据，不是用户消息」的措辞保持一致（BC 同款矛盾，刻意为之）。
 * display:false ⇒ 用户 UI 不渲染它（原文仍在会话转录里，用户自己翻阅）。
 */
function summaryMessage(block: FoldBlock): AgentMessage {
  return {
    role: "custom",
    customType: SUMMARY_CUSTOM_TYPE,
    content: summaryText(block),
    display: false,
    details: undefined,
    timestamp: block.createdAt,
  } as AgentMessage;
}

/** 锚点不得落在 tool call/result 之间或连续 assistant 中间。ref: kernel pairSafeAnchorIndex :172-216。 */
function splitsStructure(view: readonly ViewItem[], pos: number): boolean {
  if (pos <= 0 || pos >= view.length) return false;
  const prev = view[pos - 1].core;
  const cur = view[pos].core;
  if (!prev || !cur) return false;
  if (cur.contentType === "tool-result" && prev.contentType === "tool-result") return true;
  if (cur.contentType === "tool-result" && prev.role === "assistant" && prev.toolCalls.length > 0) return true;
  if (cur.role === "assistant" && prev.role === "assistant") return true;
  return false;
}

function adjustAnchor(view: readonly ViewItem[], pos: number): number {
  let p = pos;
  while (splitsStructure(view, p)) p += 1;
  return p;
}

/**
 * 视图主管线（文档 §5）：project → assignRefs → derive → hide → 折叠 + 摘要注入 →
 * 标签 → nudge → 应急截断。返回发送视图，同时把快照写回 state（工具执行据此校验：
 * 模型所见 = 校验所据）。
 */
export function refreshView(state: SessionState, messages: readonly AgentMessage[], probe: UsageProbe): ViewResult {
  const core = projectMessages(messages);
  const refs = assignRefs(core);
  const protectedRefs = computeProtectedRefs(core, refs);
  const blocks = deriveBlocks(core, refs, protectedRefs);
  const covered = coveredIndexMap(blocks);
  const coveredIdx = new Set<number>(covered.keys());

  // hide：成活（=derive 出块）的 compress 调用连同其 result 整体隐藏 —— summary 参数含
  // 全文，不隐藏就会与注入的摘要重复计费（文档 §5.4）。失败调用是正常历史，保留。
  const hidden = new Set<number>();
  const assistantByCall = new Map<string, number>();
  for (const m of core) for (const c of m.toolCalls) assistantByCall.set(c.id, m.idx);
  for (const b of blocks) {
    const aIdx = assistantByCall.get(b.compressCallId);
    if (aIdx === undefined) continue;
    const assistant = core[aIdx];
    if (assistant.toolCalls.length !== 1) continue; // 同批还有别的调用，不能整条隐藏
    hidden.add(aIdx);
    for (const m of core) if (m.contentType === "tool-result" && m.toolCallId === b.compressCallId) hidden.add(m.idx);
  }

  const firstUserIdx = core.find((m) => m.role === "user")?.idx ?? -1;
  const view: ViewItem[] = [];
  for (const m of core) {
    if (hidden.has(m.idx)) continue;
    // 首条 user 消息永不移除（ref: kernel src_prune.ts:245，锚定任务起源）。
    if (coveredIdx.has(m.idx) && m.idx !== firstUserIdx) continue;
    view.push({ core: m, msg: messages[m.idx] });
  }

  // 摘要注入：锚点 = 最早被覆盖位（pair-safe 调整）。倒序插入以保持块序。
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block.directMessageIdxs.length === 0) continue;
    const earliest = Math.min(...block.directMessageIdxs);
    let pos = 0;
    for (const v of view) if (v.core && v.core.idx < earliest) pos += 1;
    // 首条 user 是任务起源锚，摘要不得插到它前面。
    if (pos === 0 && view.length > 0 && view[0].core?.idx === firstUserIdx) pos = 1;
    view.splice(adjustAnchor(view, pos), 0, { core: null, msg: summaryMessage(block) });
  }

  // 用量：视图估算 + 系统提示词，再用 provider 真实值做 floor 校正（防低估自欺）。
  let viewTokens = 0;
  for (const v of view) viewTokens += v.core ? v.core.tokens : estimateTokens(summaryTextOf(v.msg));
  const usage = Math.max(viewTokens + estimateTokens(probe.systemPrompt), probe.tokens ?? 0);

  const ranges = computeRanges(core, refs, coveredIdx, protectedRefs);
  const pendingTokens = ranges.reduce((n, r) => n + r.tokens, 0);

  // nudge 判定（文档 §5.7 三通路）。压出新块 → 重武装基线。
  if (blocks.length > state.lastBlockCount) {
    state.baseline = usage;
    state.lastNudge = 0;
    state.lastBlockCount = blocks.length;
  }
  const win = probe.contextWindow > 0 ? probe.contextWindow : DEFAULT_CONTEXT_WINDOW;
  const growth = Math.max(0, usage - state.baseline);
  const firstSight = state.lastNudge === 0 && state.baseline === 0;
  let nudged = false;
  if (firstSight) {
    // A. 首次见面即大量可压（ref: kernel firstSightMassReady :1756-1760）
    if (usage >= MIN_CONTEXT_LIMIT_PCT * win && pendingTokens >= GROWTH_FLOOR) nudged = true;
    else state.baseline = usage; // 只是没触发，也要把基线记下来供 B 通路测增长
  } else if (pendingTokens >= GROWTH_FLOOR) {
    // B. 常规增长门：可压量充足时门槛降到 22.5K（ref: :1746-1751）
    const need = GROWTH_FLOOR * MIN_GROWTH_RATIO;
    if (growth >= need) nudged = true;
  }
  if (!nudged && usage >= MAX_CONTEXT_LIMIT_PCT * win) {
    // C. 高压带：额外要求可回收 ≥ max(5000, 1% 窗口)（ref: :1797）
    const benefit = Math.max(5000, win * 0.01);
    if (pendingTokens >= benefit && growth >= PRESSURE_GROWTH_TOKENS) nudged = true;
  }
  if (nudged) {
    state.baseline = usage;
    state.lastNudge = usage;
    view.push({
      core: null,
      msg: {
        role: "user",
        content: [{ type: "text", text: renderNudge(blocks, ranges) }],
        timestamp: Date.now(),
      } as AgentMessage,
    });
  }

  // 标签注入（放在折叠/隐藏之后 ⇒ 标签里的 tokens 与视图一致；assistant 零标签）。
  for (const v of view) {
    if (!v.core) continue;
    const ref = refs.byId.get(v.core.id);
    if (!ref) continue;
    if (v.core.role !== "user" && v.core.role !== "tool") continue;
    v.msg = injectTag(v.msg, renderTag(ref, v.core));
  }

  // 应急截断：模型没听 nudge 的兜底。铁律：注入的摘要永不截（core===null）。
  let truncated = 0;
  let finalUsage = usage;
  const target = EMERGENCY_PCT * EMERGENCY_TARGET_RATIO * win;
  if (usage >= EMERGENCY_PCT * win) {
    const candidates = view
      .map((v, i) => ({ v, i }))
      .filter(
        ({ v, i }) =>
          v.core !== null &&
          v.core.role === "tool" &&
          v.core.tokens >= TRUNCATE_MIN_TOKENS &&
          i < view.length - 3 &&
          !v.core.text.includes(TRUNCATE_MARKER),
      )
      .sort((a, b) => (b.v.core?.tokens ?? 0) - (a.v.core?.tokens ?? 0));
    for (const { v } of candidates) {
      if (finalUsage <= target) break;
      const original = v.core?.tokens ?? 0;
      const cut = truncateText(messagesText(v.msg), original);
      if (!cut) continue;
      v.msg = replaceText(v.msg, cut);
      finalUsage -= Math.max(0, original - estimateTokens(cut));
      truncated += 1;
    }
  }

  // 快照写回（工具执行据此校验）。
  state.core = core;
  state.refs = refs;
  state.protectedRefs = protectedRefs;
  state.blocks = blocks;
  state.usage = finalUsage;
  state.contextWindow = win;
  const userCount = core.filter((m) => m.role === "user").length;
  if (userCount > state.userCount) {
    state.userCount = userCount;
    state.failCount = 0;
    state.repeatSig = "";
    state.repeatCount = 0;
  }

  return {
    messages: view.map((v) => v.msg),
    usage,
    ranges,
    pendingTokens,
    nudged,
    truncated,
    blocks,
  };
}

function summaryTextOf(msg: AgentMessage): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content;
  return flattenParts(content).text;
}

/** 截断替换文本（ref: kernel src_truncate-tools.ts:103）。 */
function truncateText(text: string, originalTokens: number): string | null {
  if (text.length <= TRUNCATE_KEEP_CHARS * 2 + 100) return null;
  const prefix = text.slice(0, TRUNCATE_KEEP_CHARS);
  const suffix = text.slice(-TRUNCATE_KEEP_CHARS);
  return `${prefix}\n\n...${TRUNCATE_MARKER} — original ~${formatTokens(originalTokens)} tokens]...\n\n${suffix}`;
}

function messagesText(msg: AgentMessage): string {
  return flattenParts((msg as { content?: unknown }).content).text;
}

/** 只替换最后一个非空 text block（标签跟着 suffix 留在原地）。 */
function replaceText(msg: AgentMessage, text: string): AgentMessage {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return { ...(msg as object), content: text } as AgentMessage;
  if (!Array.isArray(content)) return msg;
  const out = [...content];
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const p = out[i] as { type?: string } | undefined;
    if (p && p.type === "text") {
      out[i] = { ...(p as object), text };
      return { ...(msg as object), content: out } as AgentMessage;
    }
  }
  return msg;
}

// ── 教义（文档 §7.2 定稿，逐字；~2.1K 字符 ≈ 520 token）────────────────────
export const COMPRESS_DOCTRINE = `CONTEXT COMPRESSION

Compression Philosophy:
- All compression serves the primary task, but be frugal.
- Context capacity is precious. Save context by compressing consumed outputs, not by avoiding tools.
- Compress by need, not by percentage.
- Work from summaries, not raw tool outputs. Only protected content and what the current step
  actively uses are exempt.

WHEN TO COMPRESS
- A delegated/subagent result you have already extracted key facts from.
- Verbose command output (build/test logs, git diff, installs, listings) once you used it.
- Exploration that led nowhere (keep the lesson, drop the journey).
- Repeated reads/status checks once the decision is recorded.
- Resolved discussion threads where the decision is captured.
- Intermediate steps of a completed multi-step task; a phase that ended (hunt complete, root
  cause found, sprint wrapped).

WHEN NOT TO COMPRESS
- Content the current step is actively reading or reasoning about.
- Important user messages — exact intent, constraints, acceptance criteria. Exclude them from
  ranges instead of compressing them.
- Protected tool outputs — hard-excluded, they stay visible.
- Window usage below 45% — the tool refuses and reports the real numbers (e.g. "36% (94K/256K)").
  Message count is never the trigger; window pressure is.
- After a rejected call: do not probe other ranges the same turn. One attempt per turn — take the
  reported reason, keep working, and reconsider when usage crosses the gate.

HOW TO COMPRESS
The summary you write becomes the ONLY record of the replaced range. Make it self-contained: a
later reader must be able to continue WITHOUT the original. It records the PAST as of this
block's creation — label task state as history ("TASK AS OF THIS BLOCK: …"), never a live
instruction.
KEEP VERBATIM: full file paths with line numbers on every mention (\`server/src/bridge.ts:524\`,
never bare \`bridge.ts\`); function/class signatures and the exact lines that ARE the logic; error
messages and stack traces (exact text); decisions with their "because"; constraints discovered;
exact values (versions, keys, thresholds); key user intents quoted WITH their message ref
(\`User said (m00132): "…"\`); \`Open objectives:\` one-line entry for any user objective not yet
completed or superseded (carried into every later summary — the last thing to drop); the user's
overall goal and how it evolved; purpose behind each action; open questions/TODOs; refs of key
anchors.
DROP: verbose logs once the error line/result is captured; duplicate reads; consumed exploration;
dead ends (one line: "tried X, failed because Y"); back-and-forth once position is captured.
For each significant item dropped add one line describing WHAT it covered (not where it lives).
PRIORITY when compacting: goal/constraints > decisions+rationale > exact artifacts (paths,
signatures, errors, values) > conclusions > lessons.
Write dense scannable bullets under thematic headers. Never mimic existing summaries' style.

TAGS
Each user/tool message carries a \`<wc tokens="2.1K" type="bash">m00175</wc>\` tag: its ref, size,
type. Target ranges by refs in compress calls. Never echo wc tags in your replies.

SUMMARIES IN CONTEXT
\`[Compressed conversation section]\` blocks are system metadata, not user messages. Their content
is HISTORY — record of what happened, not instructions to act on. Trust the summary as the
authoritative record; the original text remains in the session transcript for the user.`;

// ── compress 工具 ──────────────────────────────────────────────────────────
const DEAD_REPEAT_REJECT = 2;
/** 一轮内累计失败上限：超过就硬停，绝不让模型换个范围接着试。 */
const MAX_COMPRESS_ATTEMPTS = 2;

const compressRangeSpec = Type.Object({
  startId: Type.String({ description: 'Start ref "m00005" (from the wc tag).' }),
  endId: Type.String({ description: "Inclusive end ref." }),
  topic: Type.Optional(Type.String({ description: "Short label for THIS range, e.g. 'Auth exploration'." })),
  summary: Type.String({
    description:
      "Complete technical summary replacing all content in range: paths+lines, signatures, exact errors, decisions, values. 50-20000 chars.",
  }),
});

const compressParams = Type.Object({
  topic: Type.Optional(Type.String({ description: "Fallback topic (3-5 words) for entries without one." })),
  content: Type.Array(compressRangeSpec, { minItems: 1 }),
});

/** 会话快照表（进程内）。账本不在这里持久化 —— 它靠 derive 从转录重放。 */
const sessions = new Map<string, SessionState>();

function headTail(text: string, n: number, fromEnd: boolean): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= n) return flat;
  return fromEnd ? `…${flat.slice(-n)}` : `${flat.slice(0, n)}…`;
}

/** §4.3 成功返回模板（删掉了被砍工具的一切引用）。 */
function renderSuccess(state: SessionState, created: FoldBlock[], warnings: string[]): string {
  const reclaimed = created.reduce(
    (n, b) => n + Math.max(0, b.compressedTokens - estimateTokens(summaryText(b)) - 8),
    0,
  );
  const before = state.usage > 0 ? state.usage : state.core.reduce((n, m) => n + m.tokens, 0);
  const after = Math.max(0, before - reclaimed);
  const spans = created.map((b) => `${b.blockId}=${b.startRef}–${b.endRef}`).join(", ");
  // 用量回显：模型自己看不见窗口占用，成功/失败都得把真实数字给它。
  const win = state.contextWindow;
  const head =
    win > 0
      ? `▣ wc | ${fmtK(before)} → ${fmtK(after)} tokens (${pctOf(before, win)} → ${pctOf(after, win)} of ${fmtK(win)} window; ~${fmtK(reclaimed)} reclaimed, blocks: ${spans})`
      : `▣ wc | ${fmtK(before)} → ${fmtK(after)} tokens (~${fmtK(reclaimed)} reclaimed, blocks: ${spans})`;
  const lines = [head];
  for (const b of created) {
    lines.push(
      ` · ${b.blockId} summary ${b.summary.length}ch · head "${headTail(b.summary, 60, false)}" … tail "${headTail(b.summary, 40, true)}"`,
    );
  }
  if (warnings.length > 0) lines.push(`⚠️ ${warnings.join("; ")}`);

  const covered = new Set<number>();
  for (const b of state.blocks) for (const i of b.directMessageIdxs) covered.add(i);
  const ranges = computeRanges(state.core, state.refs, covered, state.protectedRefs);
  if (ranges.length > 0) {
    lines.push(renderRanges(ranges));
    const first = ranges[0];
    lines.push(`Example: compress({ content: [{ startId: "${first.startRef}", endId: "${first.endRef}", summary: "..." }] })`);
  }
  return lines.join("\n");
}

function compressInputSignature(params: unknown): string {
  try {
    const content = (params as { content?: unknown }).content;
    if (!Array.isArray(content)) return safeJson(params);
    return content
      .map((c) => {
        const e = c as { startId?: unknown; endId?: unknown };
        return `${String(e?.startId ?? "")}..${String(e?.endId ?? "")}`;
      })
      .join("|");
  } catch {
    return "";
  }
}

const compressTool = defineTool({
  name: "compress",
  label: "Compress",
  // ref: BC compress-tool.ts:52-60（acp tag → wc tag 措辞）
  description:
    "Replace older conversation ranges with detailed summaries you write. Single range: compress({ content: [{ startId, endId, summary }] }). Batch: compress({ content: [{ topic, startId, endId, summary }, ...] }) — each entry gets its own summary. The tool reports real window usage and refuses below 45%.",
  promptSnippet: "compress({ content: [{ startId, endId, summary }] }) or batch multiple ranges",
  promptGuidelines: [
    "Each message has a wc tag with its mNNNNN ref, token size, and type. Compress ranges by their refs.",
    "Batch multiple unrelated ranges in one call — each gets its own topic and summary.",
    "Write dense, self-contained summaries — preserve file paths, signatures, errors, and decisions verbatim.",
    "Never compress content the current step is actively using.",
    "Compress under window pressure only (≥45% usage); a long transcript by itself is not a reason.",
    "One failed compress per turn: do not probe other ranges — report the reason and keep working.",
  ],
  parameters: compressParams,
  executionMode: "sequential",
  execute: async (toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> => {
    const sid = ctx.sessionManager.getSessionId();
    let state = sessions.get(sid);
    if (!state) {
      state = createSessionState();
      sessions.set(sid, state);
    }
    const { text } = runCompress(state, toolCallId, params);
    return { content: [{ type: "text", text }], details: undefined };
  },
});

/** 占用百分比（整数），用于把窗口余量如实回给模型。 */
function pctOf(used: number, win: number): string {
  if (win <= 0) return "?";
  return `${Math.round((used / win) * 100)}%`;
}

/**
 * 低占用硬门（解决"36% 就去压缩"）：模型看不见自己的窗口占用，只凭"会话很长"的
 * 错觉激进压缩。占用没到增长门（与 §5.7 A 通路同口径）就直接拒，并把真实数字回给它。
 */
function contextGateMessage(state: SessionState): string {
  const win = state.contextWindow;
  const used = state.usage;
  if (win <= 0 || used <= 0) return ""; // 探测不到就不猜测，放行给常规校验
  const pct = used / win;
  if (pct >= MIN_CONTEXT_LIMIT_PCT) return "";
  return (
    `REFUSED — context usage is only ${pctOf(used, win)} (${fmtK(used)}/${fmtK(win)}). ` +
    `Compression needs at least ${Math.round(MIN_CONTEXT_LIMIT_PCT * 100)}% of the window; ` +
    "there is nothing to reclaim yet. A long message count is not the trigger — window pressure is.\n" +
    `Do NOT call compress again this turn. Continue the task; reconsider only once usage passes ${Math.round(MIN_CONTEXT_LIMIT_PCT * 100)}%.`
  );
}

/** 一次失败就劝退：不把模型引到"再换个范围试试"的路上。 */
const NO_RETRY_STEER =
  "One failed compress is enough — do not probe other ranges this turn. Continue the task; " +
  "call compress again only when the reported usage crosses the gate or a listed range is clearly worth reclaiming.";

/**
 * 工具执行（拆成函数便于冒烟脚本直接调用）。
 * 校验对象是**上一次 context 事件留下的快照** —— 模型所见即校验所据。
 */
export function runCompress(
  state: SessionState,
  toolCallId: string,
  params: unknown,
): { text: string } {
  if (state.core.length === 0) {
    throw new Error("No conversation snapshot yet — call compress on a later turn.");
  }
  const gate = contextGateMessage(state);
  if (gate) throw new Error(gate);
  const sig = compressInputSignature(params);
  try {
    const entries = parseCompressEntries(params);
    const result = resolveAndValidateBatch({
      entries,
      core: state.core,
      refs: state.refs,
      existing: state.blocks,
      protectedRefs: state.protectedRefs,
      blockIdOffset: state.blocks.length,
      callId: toolCallId,
    });
    if (result.blocks.length === 0) {
      throw new CompressValidationError("Nothing was compressed — every range in this call resolved to zero new messages.");
    }
    state.blocks = [...state.blocks, ...result.blocks];
    state.failCount = 0;
    state.repeatSig = "";
    state.repeatCount = 0;
    return { text: renderSuccess(state, result.blocks, result.warnings) };
  } catch (e) {
    // 死循环防线（文档 §4.4）：同一区间连续 2 次全不可压 → 硬拒；累计 3 次失败 → 暂停。
    if (sig === state.repeatSig) state.repeatCount += 1;
    else {
      state.repeatSig = sig;
      state.repeatCount = 1;
    }
    state.failCount += 1;
    const message = e instanceof Error ? e.message : String(e);
    if (state.repeatCount >= DEAD_REPEAT_REJECT) {
      const covered = new Set<number>();
      for (const b of state.blocks) for (const i of b.directMessageIdxs) covered.add(i);
      const ranges = computeRanges(state.core, state.refs, covered, state.protectedRefs);
      throw new Error(
        `REJECTED — the same range failed twice and is not compressible. ${message}\n` +
          (ranges.length > 0 ? renderRanges(ranges) : "No compressible range (≥5000 chars) is available right now.") +
          `\n${NO_RETRY_STEER}`,
      );
    }
    if (state.failCount >= MAX_COMPRESS_ATTEMPTS) {
      throw new Error(
        `PAUSED — ${MAX_COMPRESS_ATTEMPTS} compress attempts already failed this turn. Stop and continue working.`,
      );
    }
    throw new Error(`${message}\n${NO_RETRY_STEER}`);
  }
}

// ── 接线（四件套 + 教义）──────────────────────────────────────────────────
function probeFromContext(ctx: ExtensionContextLike): UsageProbe {
  const usage = ctx.getContextUsage();
  const win = ctx.model?.contextWindow ?? usage?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  let systemPrompt = "";
  try {
    systemPrompt = ctx.getSystemPrompt();
  } catch {
    systemPrompt = "";
  }
  return { tokens: usage?.tokens ?? null, contextWindow: win, systemPrompt };
}

/** 结构化声明，避免为了一个签名把整个 ExtensionContext 拖进冒烟脚本的类型面。 */
interface ExtensionContextLike {
  sessionManager: { getSessionId(): string };
  model: { contextWindow?: number } | undefined;
  getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  getSystemPrompt(): string;
}

/** 扩展工厂：Pi-Work 侧 `-e` 直接加载；pi-desktop 侧见 compressExtension。 */
export default function piworkCompress(pi: ExtensionAPI): void {
  const config = readCompressConfigSync();
  // 关 → 不注册工具、不挂事件：模型与提示词里完全没有本扩展的痕迹。
  if (!config.enabled) return;
  const doctrine = config.doctrineOverride ?? COMPRESS_DOCTRINE;

  // 1) 接管压缩：内置 threshold / manual / overflow 三条路都在事件处挡掉（文档 §2）。
  pi.on("session_before_compact", () => ({ cancel: true }));

  // 2) 每回合视图改写。ref: BC index.ts:406-423（入参 event.messages，出参 { messages }）。
  pi.on("context", (event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    let state = sessions.get(sid);
    if (!state) {
      state = createSessionState();
      sessions.set(sid, state);
    }
    const view = refreshView(state, event.messages, probeFromContext(ctx));
    return { messages: view.messages };
  });

  // 3) 教义追加在系统提示词最末（与 docs 剥离 / preamble / rules / soul 的链式共存，文档 §6）。
  pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${doctrine}` }));

  // 4) 唯一工具。
  pi.registerTool(compressTool);

  // 运行期 teardown：快照丢了也能从转录 derive 重建，不必跨 runtime 存活。
  pi.on("session_shutdown", () => {
    sessions.clear();
  });
}

/** pi-desktop 侧的注册形态（session-manager 两个 extensionFactories 数组）。 */
export const compressExtension: InlineExtension = {
  name: "compress",
  factory: (pi) => {
    piworkCompress(pi);
  },
};

/** 测试与诊断用：当前快照表（只读）。 */
export function sessionStateFor(sessionId: string): SessionState | undefined {
  return sessions.get(sessionId);
}
