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
/** 块边界形态 bN（块边界蒸馏：把 bN..bM 合并成一条总纪要，ref: BC 同款 b 引用）。 */
const BLOCK_REF_PATTERN = /^b0*(\d{1,4})$/;
/** 账本自身永不压缩（它的 summary 参数就是账本内容）。ref: kernel protected.d.ts:9。 */
const ALWAYS_PROTECTED_TOOLS = ["compress"];
/** 这两类工具的输出完全排除在尾部保护区之外：既不占「最后 5 条」名额，也不进尾部
 *  5000-token 保护集（token 仍计入累计量）——大输出调用恰恰是最该压的目标，不能让一条
 *  巨型 read 把整个尾窗变成压不动的。ref: kernel protected.ts:31-36 NEVER_PRESERVE_RECENT_TOOLS。 */
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
const MIN_CONTEXT_LIMIT_PCT = 0.3; // BC 默认 0.45，本实现下调到 30%（nudge 与手动压缩硬门共用）
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
/** tool 对边界加宽最多越出请求范围多少条（ref: kernel tool-pairs.ts:17-66 双向扫描上限 20）。 */
const PAIR_WIDEN_RADIUS = 20;
/** D 通路（蒸馏提议）阈值：active 块的摘要残留合计 ≥ 15K token 就提议合并老块。 */
const DIGEST_PENDING_TOKENS = 15_000;
/** D 通路阈值：可合并（去掉热区）的 active 块数 ≥ 12 也提议。 */
const DIGEST_PENDING_BLOCKS = 12;
/** 最近这么多块算「热区」，不进自动蒸馏提议（模型显式提交 b 边界仍允许合它们）。 */
const HOT_BLOCK_COUNT = 3;
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

/** bN（允许前导零缺位）→ 块序号；非法返回 null。 */
function parseBlockOrdinal(raw: string): number | null {
  const m = BLOCK_REF_PATTERN.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

// ── 保护区（尾部软保护区；硬保护区靠 BLOCKED 实现）─────────────────────────
/**
 * ref: kernel computeProtectedRefs（preserveRecentMessages:5 / preserveRecentTokens:5000）。
 * 三层：最后 5 条 ∪ 尾部累计 5000 token ∪ 最近一条真实 user 消息。
 * read/bash 类工具输出完全不入保护集（BC never-preserve 语义）：既不占名额，尾窗扫描
 * 穿过它们时也只为累计 token 继续向前——尾窗保护的是「正在用的东西」，大输出调用
 * 本身就是首要压缩目标，否则一条巨型 read 就能把整个尾部变成压不动的。
 * 返回受保护的 **ref** 集合（BLOCKED 消息本来就没有 ref，不参与）。
 */
export function computeProtectedRefs(core: CoreMsg[], refs: RefMap): Set<string> {
  const protectedRefs = new Set<string>();
  const refAt = (idx: number): string | undefined => refs.byId.get(core[idx].id);
  const neverPreserved = (m: CoreMsg): boolean =>
    m.contentType === "tool-result" && NEVER_PRESERVE_RECENT_TOOLS.includes(m.toolName ?? "");

  let quota = 0;
  for (let i = core.length - 1; i >= 0 && quota < PRESERVE_RECENT_MESSAGES; i -= 1) {
    const m = core[i];
    if (neverPreserved(m)) continue; // 不占名额、不受保护
    const ref = refAt(i);
    if (ref) protectedRefs.add(ref);
    quota += 1;
  }

  let acc = 0;
  for (let i = core.length - 1; i >= 0; i -= 1) {
    acc += core[i].tokens; // never-preserve 消息的 token 照常累计
    const ref = refAt(i);
    if (ref && !neverPreserved(core[i])) protectedRefs.add(ref);
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
  /** 蒸馏代数：普通块 1；合并块 = max(被吞块)+1。代数不封顶（对数增长自然收敛）。 */
  generation: number;
  /** 被本块吞掉的 active 块 id（谱系）。普通块为空数组。 */
  directBlockIds: string[];
}

/**
 * active 块 = 没有被任何后续块的 directBlockIds 引用过的块。
 * 派生即得、不存字段（账本 derive-only，零新增落盘）。视图折叠、摘要注入、候选清单、
 * nudge 块清单、成功回显只认 active 块；被吞块仍留在数组里保编号稳定。
 */
export function deriveActiveBlocks(blocks: readonly FoldBlock[]): FoldBlock[] {
  const consumed = new Set<string>();
  for (const b of blocks) for (const id of b.directBlockIds ?? []) consumed.add(id);
  return blocks.filter((b) => !consumed.has(b.blockId));
}

/** 块的展示形态：`bN=m…–m…`；合并块追加 `·G<gen>`（谱系只在渲染时可见，账本仍 derive-only）。 */
export function fmtBlockSpan(b: FoldBlock): string {
  return `${b.blockId}=${b.startRef}–${b.endRef}${b.generation >= 2 ? `·G${b.generation}` : ""}`;
}

/** 校验类错误：一律以 throw 呈现，pi 才会把 toolResult 标成 isError。
 *  ref: BC compress-tool.ts:458-462 注释原文。 */
export class CompressValidationError extends Error {}

interface CompressEntry {
  startId: string;
  endId: string;
  summary: string;
  topic?: string;
  /** "block" = b 边界（合并现有块），"msg" = m 边界（压消息区间）。 */
  boundaryKind: "msg" | "block";
}

/**
 * `content` 宽容解包（ref: kernel parseCompressInput 全套）：模型序列化经常跑偏——
 * 整个数组被 JSON 化成字符串、只给单个条目对象、数组元素又是 JSON 字符串、双重嵌套。
 * 一律归一成条目数组；修不动的原样交给下面的字段校验报可操作错误。
 */
function coerceContentItems(raw: unknown): unknown[] {
  if (typeof raw === "string") {
    const cleaned = stripFence(raw.trim());
    if (cleaned === "") return [];
    let value = tryParseLenient(cleaned);
    if (value === undefined) {
      // 单引号 JSON：只在归一化确实救回东西时采用（正文撇号会改语义）。ref: BC normalizeSingleQuotes 次序。
      const norm = normalizeSingleQuotes(cleaned);
      if (norm !== undefined) value = tryParseLenient(norm);
    }
    if (typeof value === "string") {
      const inner = stripFence(value.trim()); // 双重 stringify：内层再来一轮
      value = tryParseLenient(inner);
      if (value === undefined) {
        const norm = normalizeSingleQuotes(inner);
        if (norm !== undefined) value = tryParseLenient(norm);
      }
    }
    if (Array.isArray(value)) return unwrapArrayItems(value);
    if (value && typeof value === "object") return unwrapContentObject(value as Record<string, unknown>);
    if (value === undefined) {
      // 整段 parse 不动：先按截断 JSON 抢救条目，再退行式切分（BC 的次序）。
      const salv = salvageContentEntries(`{"content": ${cleaned}`);
      if (salv.length > 0) return salv;
      return splitLineEntries(stripJsonWrapperResidue(cleaned));
    }
    return [value]; // parse 出标量：交给条目级丢弃报错
  }
  if (Array.isArray(raw)) return unwrapArrayItems(raw);
  if (raw && typeof raw === "object") return unwrapContentObject(raw as Record<string, unknown>);
  return [];
}

function unwrapArrayItems(list: readonly unknown[]): unknown[] {
  const flat: unknown[] = [];
  for (const item of list) {
    if (typeof item === "string") {
      const t = item.trim();
      if (t.startsWith("[") || t.startsWith("{")) {
        // 元素自身又被 JSON 化：解开（行式字符串以 ref 开头、不以 [/{ 开头，不抢行式的活）
        const u = tryParseLenient(stripFence(t));
        if (Array.isArray(u)) {
          flat.push(...u);
          continue;
        }
        if (u && typeof u === "object") {
          flat.push(u);
          continue;
        }
      }
    }
    flat.push(item);
  }
  return flat;
}

function unwrapContentObject(obj: Record<string, unknown>): unknown[] {
  if (Array.isArray(obj.ranges)) return unwrapArrayItems(obj.ranges as unknown[]); // { ranges: [...] } 套一层
  return [obj]; // 单条目对象没包数组
}

/** 剥 markdown 围栏：```json … ``` → 正文（模型爱把 JSON 包在围栏里）。ref: BC stripFence。 */
function stripFence(s: string): string {
  if (!s.startsWith("```")) return s;
  const nl = s.indexOf("\n");
  if (nl === -1) return s;
  const end = s.lastIndexOf("```");
  return end > nl + 1 ? s.slice(nl + 1, end).trim() : s.slice(nl + 1).trim();
}

/** 删掉紧邻 }/] 的尾逗号（字符串外）。ref: BC stripTrailingCommas。 */
function stripTrailingCommas(s: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < s.length && /[ \t\n\r]/.test(s[j])) j += 1;
      if (j < s.length && (s[j] === "}" || s[j] === "]")) continue;
    }
    out += ch;
  }
  return out;
}

/** 字符串字面量里的裸 \n\r\t 转义成 \\\\n 等（摘要折行是 JSON.parse 失败头号原因）。
 *  ref: BC escapeRawNewlinesInStrings。 */
function escapeRawNewlinesInStrings(s: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (!inStr) {
      out += ch;
      if (ch === '"') inStr = true;
      continue;
    }
    if (esc) {
      esc = false;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inStr = false;
      out += ch;
      continue;
    }
    if (ch === "\n") {
      out += "\\n";
      continue;
    }
    if (ch === "\r") {
      out += "\\r";
      continue;
    }
    if (ch === "\t") out += "\\t";
    else out += ch;
  }
  return out;
}

/** 反复按 JSON.parse 报错里的位点修控制字符 / 非法转义（`\`` 之类模型幻觉转义）。
 *  ref: BC repairAtParserPositions —— 「按报错位点抢救」本体。 */
function repairAtParserPositions(s: string): string {
  let current = s;
  for (let iter = 0; iter < 24; iter += 1) {
    try {
      JSON.parse(current);
      break;
    } catch (e) {
      const m = /position (\d+)/.exec(e instanceof Error ? e.message : String(e));
      if (!m) break;
      let pos = Number(m[1]) - 1;
      if (!(pos >= 0 && pos < current.length)) break;
      const ch = current[pos];
      if (ch === "\n" || ch === "\r" || ch === "\t") {
        current = current.slice(0, pos) + "\\n" + current.slice(pos + 1); // \r\n 对会被二次修成 \\n，无害
        continue;
      }
      if (ch === "\\" && pos + 1 < current.length) {
        current = current.slice(0, pos + 1) + "\\" + current.slice(pos + 1); // 双写转义反斜杠
        continue;
      }
      break;
    }
  }
  return current;
}

/** 宽容 JSON.parse 五级阶梯（ref: BC tryParseLenient）：原样 → 删尾逗号 → 裸换行转义 → 报错位点修。 */
function tryParseLenient(s: string): unknown | undefined {
  const attempts = [s, stripTrailingCommas(s), escapeRawNewlinesInStrings(s)];
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      /* 进下一级 */
    }
    try {
      return JSON.parse(repairAtParserPositions(attempt));
    } catch {
      /* 进下一级 */
    }
  }
  return undefined;
}

/** 单引号 JSON → 双引号。只修字符串里的单引号，正文撇号会改语义，故仅当归一化后
 *  能解析且比原 parse 抠回更多内容时才采用。ref: BC normalizeSingleQuotes。 */
function normalizeSingleQuotes(raw: string): string | undefined {
  let out = "";
  let mode: "code" | "sq" | "dq" = "code";
  let esc = false;
  for (const ch of raw) {
    if (mode === "dq") {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') mode = "code";
      continue;
    }
    if (mode === "sq") {
      if (ch === "'") {
        mode = "code";
        out += '"';
      } else if (ch === '"') out += '\\"';
      else out += ch;
      continue;
    }
    if (ch === '"') {
      mode = "dq";
      out += ch;
      continue;
    }
    if (ch === "'") {
      mode = "sq";
      out += '"';
      continue;
    }
    out += ch;
  }
  return mode === "code" ? out : undefined;
}

/** 截断 JSON 抢救（ref: BC salvageContentEntries）：从 `"content":[` 后逐个抠出 depth-1
 *  完整闭合的条目切片，每片再走宽容解析（尾逗号/裸换行/位点修），未闭合尾巴丢弃。 */
function salvageContentEntries(raw: string): unknown[] {
  const out: unknown[] = [];
  const m = /"content"\s*:\s*\[/.exec(raw);
  if (!m) return out;
  const arrStart = raw.indexOf("[", m.index);
  if (arrStart < 0) return out;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let itemStart = -1;
  for (let i = arrStart + 1; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      if (depth === 1) itemStart = i;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && itemStart >= 0) {
        const parsed = tryParseLenient(raw.slice(itemStart, i + 1));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) out.push(parsed);
        itemStart = -1;
      }
    } else if (ch === "[" && depth > 0) {
      depth += 1;
    } else if (ch === "]" && depth > 0) {
      depth -= 1;
    }
  }
  return out;
}

/** 行式条目头：`m00150-m0220 [可选topic]`，摘要在后续行；也收 `m00123` 单条与同行冒号形态。
 *  分隔符宽容 .. … – — ~ to -（ref: BC parseCompressLineEntry；bN 块引用不收——本实现输入只认 m）。 */
const LINE_REF_PAIR_RE = /^\s*(m\d{1,5})\s*(?:\.\.\.|\u2026|to\b|[-–—~])\s*(m\d{1,5})\b/i;
const LINE_REF_SINGLE_RE = /^\s*(m\d{1,5})\b/i;

interface LineEntryResult {
  entry?: { startId: string; endId: string; summary: string; topic?: string };
  error?: string;
}

function parseLineEntry(input: string): LineEntryResult {
  const trimmed = input.trim();
  if (trimmed === "") return { error: "Empty content entry." };
  const nl = trimmed.indexOf("\n");
  const head = nl === -1 ? trimmed : trimmed.slice(0, nl);
  const body = nl === -1 ? "" : trimmed.slice(nl + 1).trim();
  let startId: string;
  let endId: string;
  let afterRefs: number;
  const pair = LINE_REF_PAIR_RE.exec(head);
  if (pair) {
    startId = pair[1];
    endId = pair[2];
    afterRefs = pair[0].length;
  } else {
    const single = LINE_REF_SINGLE_RE.exec(head);
    if (!single) return { error: "Line entry must start with `mNNNNN-mNNNNN` (or a single `mNNNNN`)." };
    startId = single[1];
    endId = single[1];
    afterRefs = single[0].length;
  }
  const rest = head.slice(afterRefs).trim();
  if (/^[:：]/.test(rest)) {
    // 同行冒号形态：`m起-m止: 摘要`（本实现保留的扩展形态，后续行并入摘要）
    const sameLine = rest.slice(1).trim();
    const summary = sameLine === "" ? body : body === "" ? sameLine : `${sameLine}\n${body}`;
    if (summary === "") return { error: "Line entry is missing a summary." };
    return { entry: { startId, endId, summary } };
  }
  if (body === "") return { error: "Line entry is missing a summary (put it on the lines below the ref range)." };
  return { entry: { startId, endId, summary: body, topic: rest === "" ? undefined : rest } };
}

/** ref-only 尾巴（输出到一半被 token 上限切断）补的占位摘要。ref: BC TRUNCATED_BY_LIMIT_MESSAGE。 */
const TRUNCATED_BY_LIMIT_MESSAGE = "[summary truncated by output token limit — re-compress this range with a shorter summary if needed]";

/** 兄弟拼接：`["m00158-m01712 topic", "## TASK …"]` —— 只含 ref 头的条目吞并紧随的无 ref 兄弟
 *  当摘要，ref-only 尾巴报错。ref: BC coalesceLineEntries。 */
function coalesceLineEntries(items: unknown[]): unknown[] {
  if (!items.some((it) => typeof it === "string" && lineEntryHeadHasRef(it))) return items;
  const out: unknown[] = [];
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (typeof it !== "string" || !lineEntryHeadHasRef(it)) {
      out.push(it);
      i += 1;
      continue;
    }
    if (it.indexOf("\n") !== -1) {
      out.push(it);
      i += 1;
      continue;
    }
    const headerOnlyIdx: number[] = [];
    let j = i + 1;
    while (j < items.length && typeof items[j] === "string" && !lineEntryHeadHasRef(items[j] as string)) {
      headerOnlyIdx.push(j);
      j += 1;
    }
    if (headerOnlyIdx.length === 0) {
      out.push(it);
      i += 1;
      continue;
    }
    out.push([it, ...headerOnlyIdx.map((k) => items[k] as string)].join("\n"));
    i = j;
  }
  const tail = out[out.length - 1];
  if (typeof tail === "string" && lineEntryHeadHasRef(tail) && tail.indexOf("\n") === -1) {
    out[out.length - 1] = `${tail}\n${TRUNCATED_BY_LIMIT_MESSAGE}`;
  }
  return out;
}

function lineEntryHeadHasRef(s: string): boolean {
  const nl = s.indexOf("\n");
  const head = nl === -1 ? s : s.slice(0, nl);
  return LINE_REF_PAIR_RE.test(head) || LINE_REF_SINGLE_RE.test(head);
}

/** 整段字符串按 ref 头行切分成多个行式条目（JSON.stringify 整批行式后的残留形态）。
 *  ref: BC splitLineEntries + stripJsonWrapperResidue。 */
function splitLineEntries(s: string): string[] {
  return s
    .split(/\n(?=\s*(?:["']\s*,\s*)?["']?\s*m\d{1,5}\s*(?:\.\.\.|\u2026|to\b|[-–—~])\s*m\d{1,5}\b)/i)
    .map((p) => stripJsonWrapperResidue(p))
    .filter((p) => p !== "");
}

function stripJsonWrapperResidue(s: string): string {
  let out = s;
  for (;;) {
    const before = out;
    out = out.replace(/^\s*(?:\[|,|"|\{)\s*/, "").replace(/\s*(?:\]|,|"|\})\s*$/, "");
    if (before === out) break;
  }
  return out.trim();
}

/** 缺 topic 时用摘要首个标题行/首行当块标题（剥列表符号、60 字符封顶）。ref: BC deriveTopicFromSummary。 */
function deriveTopicFromSummary(summary: string): string {
  const lines = summary.split("\n");
  let topic = "";
  for (const line of lines) {
    const t = line.trim();
    if (t === "") continue;
    const h = /^#{1,6}\s+(.+)$/.exec(t);
    topic = (h ? h[1] : t).replace(/^[-*+]\s+/, "").trim();
    break;
  }
  if (topic.length <= 60) return topic;
  const cut = topic.slice(0, 60);
  const sp = cut.lastIndexOf(" ");
  return (sp > 30 ? cut.slice(0, sp) : cut) + "…";
}

/** 解析 compress 调用参数（工具执行与 derive 重放共用，保证两处判定一致）。 */
export function parseCompressEntries(args: unknown, dropNotes?: string[]): CompressEntry[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new CompressValidationError("compress expects an object with a `content` array.");
  }
  const raw = args as Record<string, unknown>;
  const topTopic = typeof raw.topic === "string" && raw.topic.trim() !== "" ? raw.topic : undefined;
  // 顶层就是单条目的跑偏（没有 content 包装）：自身当 content（ref: BC 顶层单条目容忍）。
  const contentRaw =
    raw.content === undefined && (typeof raw.startRef === "string" || typeof raw.startId === "string") ? raw : raw.content;
  const items = coalesceLineEntries(coerceContentItems(contentRaw));
  if (items.length === 0) {
    throw new CompressValidationError(
      "compress expects `content` — a non-empty array of { startId, endId, summary } (a single entry object or a JSON-encoded string of either is also accepted).",
    );
  }
  // 条目级宽容（ref: BC validateEntry 不连坐）：坏条目跳过并记原因，一个都不剩才报错；
  // 字段名容忍 startRef/startId/messageId 别名（BC validateEntry 同款）。
  const entries: CompressEntry[] = [];
  const dropped: string[] = [];
  items.forEach((item, i) => {
    if (typeof item === "string") {
      const { entry, error } = parseLineEntry(item); // 行式条目：m起-m止 [topic] + 后续行摘要
      if (!entry) {
        dropped.push(`entry ${i}: ${error}`);
        return;
      }
      entries.push({
        ...entry,
        topic: entry.topic ?? topTopic ?? deriveTopicFromSummary(entry.summary),
        boundaryKind: "msg", // 行式条目只认 m 范围（b 边界必须是对象形态）
      });
      return;
    }
    if (!item || typeof item !== "object") {
      dropped.push(`entry ${i}: not an object or line entry`);
      return;
    }
    const e = item as Record<string, unknown>;
    const strOr = (k: string): string | undefined => (typeof e[k] === "string" ? (e[k] as string) : undefined);
    const startId = strOr("startRef") ?? strOr("startId") ?? strOr("messageId");
    const endId = strOr("endRef") ?? strOr("endId") ?? strOr("messageId");
    const summary = strOr("summary");
    if (!startId || !endId || !summary) {
      dropped.push(`entry ${i}: missing string startId/endId/summary`);
      return;
    }
    const explicitTopic = strOr("topic");
    // 两端都是 bN 才算块边界条目；一 m 一 b 的混边界留给校验链报可操作错误（宁准不猜）。
    const boundaryKind: "msg" | "block" =
      BLOCK_REF_PATTERN.test(startId.trim()) && BLOCK_REF_PATTERN.test(endId.trim()) ? "block" : "msg";
    entries.push({
      startId,
      endId,
      summary,
      topic: explicitTopic && explicitTopic.trim() !== "" ? explicitTopic : topTopic ?? deriveTopicFromSummary(summary),
      boundaryKind,
    });
  });
  if (entries.length === 0) {
    throw new CompressValidationError(
      `compress received ${items.length} malformed content entr${items.length === 1 ? "y" : "ies"}` +
        (dropped.length > 0 ? ` (${dropped.slice(0, 3).join("; ")})` : "") +
        " — each entry must be an object with startId, endId and summary (or a line like `m00005-m00012: summary`).",
    );
  }
  if (dropNotes && dropped.length > 0) dropNotes.push(...dropped);
  return entries;
}

function coveredIndexMap(blocks: readonly FoldBlock[]): Map<number, string> {
  const covered = new Map<number, string>();
  for (const b of blocks) for (const idx of b.directMessageIdxs) covered.set(idx, b.blockId);
  return covered;
}

/** 清单专用覆盖集：按 [startRef..endRef] 跨度闭合每个块（ref 失效时退回按点集）。
 *  校验器的点集（coveredIndexMap）不能换——它要逐条精确语义；但候选清单若只按点集，
 *  块跨度内的夹缝（compress 对、回放剔除留下的洞）会以「自由消息」混进候选，模型照
 *  清单去压又撞上 "covered by bN"——列表与实际覆盖不一致，白烧一个试错回合。 */
function coveredSpanSet(refs: RefMap, blocks: readonly FoldBlock[]): Set<number> {
  const covered = new Set<number>();
  for (const b of blocks) {
    const a = refs.indexByRef.get(b.startRef);
    const z = refs.indexByRef.get(b.endRef);
    if (a === undefined || z === undefined) {
      for (const idx of b.directMessageIdxs) covered.add(idx);
      continue;
    }
    for (let i = Math.min(a, z); i <= Math.max(a, z); i += 1) covered.add(i);
  }
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

/**
 * tool 对的另一半（call ↔ result）。dangling = result 存在但快照里找不到 call
 * （结果先于调用落盘的竞态）——加宽无从下手，只能撤回这一头。
 */
function partnersOf(idx: number, core: CoreMsg[], pairs: PairMaps): { idxs: number[]; dangling: boolean } {
  const m = core[idx];
  if (m.contentType === "tool-result" && m.toolCallId) {
    const callIdx = pairs.callIdxById.get(m.toolCallId);
    return callIdx === undefined ? { idxs: [], dangling: true } : { idxs: [callIdx], dangling: false };
  }
  if (m.role === "assistant" && m.toolCalls.length > 0) {
    const out: number[] = [];
    // 结果还没落盘（本轮正在跑）的调用不算拆对：整条 turn 本来就在区间尾部之外。
    for (const c of m.toolCalls) out.push(...(pairs.resultIdxsByCall.get(c.id) ?? []));
    return { idxs: out, dangling: false };
  }
  return { idxs: [], dangling: false };
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

/** b 边界条目解析出的合并计划（块边界蒸馏）。 */
interface BlockPlan {
  lo: number;
  hi: number;
  summary: string;
  topic?: string;
  /** 被吞掉的 active 块（谱系 + 记账来源）。 */
  consumed: FoldBlock[];
  spanStart: number;
  spanEnd: number;
  /** 跨度闭合后的全部下标（含子块之间的夹缝）。 */
  spanIdxs: number[];
  startRef: string;
  endRef: string;
  /** BC 记账：Σ 被吞块 compressedTokens + Σ 被吞块摘要 tokens（防重复计）。 */
  compressedTokens: number;
  generation: number;
}

/** 两个下标集是否相交（小集遍历大集查表）。 */
function setsOverlap(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const i of small) if (big.has(i)) return true;
  return false;
}

/** 摘要长度门（m / b 条目共用）。ref: kernel :5590 / :5596（超限抛错，不截断）。 */
function assertSummaryLength(summary: string): void {
  const len = summary.length;
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
  const activeExisting = deriveActiveBlocks(existing);
  const covered = coveredIndexMap(activeExisting);
  const pairs = buildPairMaps(core);
  const warnings: string[] = [];
  const resolved: ResolvedRange[] = [];
  const blockPlans: BlockPlan[] = [];
  const nearestRef = (from: number, dir: 1 | -1): string | undefined => {
    for (let i = from; i >= 0 && i < core.length; i += dir) {
      const ref = refs.byId.get(core[i].id);
      if (ref) return ref;
    }
    return undefined;
  };

  for (const entry of entries) {
    const startRaw = entry.startId.trim();
    const endRaw = entry.endId.trim();

    // b 边界（块边界蒸馏）：绕过保护区、pair 加宽/撤回与 MIN_RANGE_CHARS，只保留摘要门。
    if (entry.boundaryKind === "block") {
      const loOrd = parseBlockOrdinal(startRaw);
      const hiOrd = parseBlockOrdinal(endRaw);
      if (loOrd === null || hiOrd === null) {
        throw new CompressValidationError(
          `Invalid boundary block ref(s): startId="${entry.startId}", endId="${entry.endId}". Use bN.`,
        );
      }
      let lo = loOrd;
      let hi = hiOrd;
      if (lo > hi) [lo, hi] = [hi, lo]; // 反向交换不报错（与 m 边界同款）
      const targets = activeExisting.filter((b) => {
        const ord = parseBlockOrdinal(b.blockId);
        return ord !== null && ord >= lo && ord <= hi;
      });
      if (targets.length === 0) {
        const list = activeExisting.map(fmtBlockSpan).join(", ") || "none";
        throw new CompressValidationError(
          `Block range b${lo}..b${hi} contains no active block — every one of them was already merged into a newer digest. Active blocks now: ${list}. Target only those (they are listed in the "Compressed blocks" line of the last compress result). Nothing was compressed.`,
        );
      }
      // 跨度闭合：子块之间的夹缝（旧 compress 对、残料消息）一并纳入 ⇒ 原文从视图消失，
      // 教义据此要求总纪要承接它们的结论。
      let spanStart = Number.POSITIVE_INFINITY;
      let spanEnd = -1;
      for (const b of targets) {
        for (const idx of b.directMessageIdxs) {
          if (idx < spanStart) spanStart = idx;
          if (idx > spanEnd) spanEnd = idx;
        }
        const a = refs.indexByRef.get(b.startRef);
        const z = refs.indexByRef.get(b.endRef);
        if (a !== undefined) spanStart = Math.min(spanStart, a);
        if (z !== undefined) spanEnd = Math.max(spanEnd, z);
      }
      if (spanEnd < spanStart) {
        throw new CompressValidationError(
          `Block range b${lo}..b${hi} no longer resolves to messages in this session (rewind or branch). Nothing was compressed.`,
        );
      }
      const spanIdxs: number[] = [];
      for (let i = spanStart; i <= spanEnd; i += 1) spanIdxs.push(i);
      blockPlans.push({
        lo,
        hi,
        summary: entry.summary,
        topic: entry.topic,
        consumed: targets,
        spanStart,
        spanEnd,
        spanIdxs,
        startRef: nearestRef(spanStart, 1) ?? targets[0].startRef,
        endRef: nearestRef(spanEnd, -1) ?? targets[targets.length - 1].endRef,
        compressedTokens: targets.reduce((n, b) => n + b.compressedTokens + estimateTokens(summaryText(b)), 0),
        generation: Math.max(...targets.map((b) => b.generation ?? 1)) + 1,
      });
      continue;
    }

    // (1) 格式。ref: kernel :1752
    const startOrd = parseRefOrdinal(startRaw);
    const endOrd = parseRefOrdinal(endRaw);
    if (startOrd === null || endOrd === null) {
      const isBlock = BLOCK_REF_PATTERN.test(startRaw) || BLOCK_REF_PATTERN.test(endRaw);
      throw new CompressValidationError(
        isBlock
          ? `Mixed boundary refs: startId="${entry.startId}", endId="${entry.endId}" — a range must be all message refs (mNNNNN) or all block refs (bN).`
          : `Invalid boundary ref(s): startId="${entry.startId}", endId="${entry.endId}". Use mNNNNN.`,
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
      // 把覆盖块的 m 边界也列出来：模型只看 block id 猜不出边界在哪，容易原地重试。
      const spans = ids.map((id) => {
        const b = existing.find((x) => x.blockId === id);
        return b ? fmtBlockSpan(b) : id;
      });
      throw new CompressValidationError(
        `Range ${startRef}..${endRef} contains no new compressible messages — every message in it is already covered by active block(s) ${spans.join(", ") || "n/a"}. Nothing was compressed. Every range must include at least one message outside existing blocks — pick refs from the listed compressible ranges instead.`,
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

    // (7) tool 对 / turn 完整性：**预防性加宽优先**，撤回只是兜底。
    // ref: kernel tool-pairs.ts:17-66 —— 裁窄切掉对的一半会丢内容，把另一半拉进块里
    // 内容更完整；对侧拉不进（越出扫描半径 / 受保护 / 已被覆盖 / 无 ref）才撤回这一头。
    // 加宽会级联出新的孤面对端，故不动点迭代；加宽/撤回都不发生即收敛。
    const withdrewRefs: string[] = [];
    const widenedRefs: string[] = [];
    const canWidenInto = (idx: number): boolean => {
      if (idx < lo - PAIR_WIDEN_RADIUS || idx > hi + PAIR_WIDEN_RADIUS) return false;
      if (!refs.byId.has(core[idx].id)) return false; // BLOCKED 消息进不了块
      const ref = refs.byId.get(core[idx].id);
      if (ref && protectedRefs.has(ref)) return false;
      return !covered.has(idx);
    };
    for (let iter = 0; iter < core.length + 8; iter += 1) {
      const added: number[] = [];
      const stranded: number[] = [];
      for (const i of Array.from(keptSet).sort((a, b) => a - b)) {
        const { idxs, dangling } = partnersOf(i, core, pairs);
        if (dangling) {
          stranded.push(i);
          continue;
        }
        for (const p of idxs) {
          if (keptSet.has(p) || added.includes(p)) continue;
          if (canWidenInto(p)) added.push(p);
          else if (!stranded.includes(i)) stranded.push(i);
        }
      }
      if (added.length === 0 && stranded.length === 0) break;
      for (const p of added) {
        keptSet.add(p);
        const ref = refs.byId.get(core[p].id);
        if (ref && !widenedRefs.includes(ref)) widenedRefs.push(ref);
      }
      for (const i of stranded) {
        keptSet.delete(i);
        const ref = refs.byId.get(core[i].id);
        if (ref && !withdrewRefs.includes(ref)) withdrewRefs.push(ref);
      }
    }
    if (keptSet.size === 0) {
      throw new CompressValidationError(
        `Range ${startRef}..${endRef} would split a tool call/result pair and the missing half is protected/covered — trimming left nothing to compress. Move startId/endId to turn boundaries that exclude that message.`,
      );
    }
    if (widenedRefs.length > 0) {
      warnings.push(
        `Widened ${widenedRefs.length} boundary message(s) ${widenedRefs.join(", ")} into the block to keep tool call/result pairs intact — make the summary cover them too.`,
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

  // (11) 同批相交：m 范围与 b 跨度按下标混排，后来的让路 + 警告。ref: kernel :4853-4864
  // b 的跨度是闭合的（含夹缝），与任何范围相交都只能让路。
  type BatchItem = { label: string; startIdx: number; idxs: Set<number>; range?: ResolvedRange; plan?: BlockPlan };
  const items: BatchItem[] = [
    ...resolved.map((r) => ({ label: `(${r.startRef}..${r.endRef})`, startIdx: r.startIdx, idxs: new Set(r.keptIdxs), range: r })),
    ...blockPlans.map((p) => ({ label: `b${p.lo}..b${p.hi}`, startIdx: p.spanStart, idxs: new Set(p.spanIdxs), plan: p })),
  ].sort((a, b) => a.startIdx - b.startIdx);
  const accepted: BatchItem[] = [];
  for (const it of items) {
    const clash = accepted.find((a) => setsOverlap(a.idxs, it.idxs));
    if (clash) {
      warnings.push(
        it.plan
          ? `Skipped block range ${it.label} — overlaps ${clash.plan ? `block range ${clash.label}` : `range ${clash.label}`} in the same batch; the earlier one takes precedence. Keep block ranges disjoint.`
          : `Skipped range ${it.label} — overlaps an earlier range in the batch; the earlier range takes precedence. Keep ranges disjoint.`,
      );
      continue;
    }
    accepted.push(it);
  }
  const acceptedRanges = accepted.map((it) => it.range).filter((r): r is ResolvedRange => Boolean(r));
  const acceptedPlans = accepted.map((it) => it.plan).filter((p): p is BlockPlan => Boolean(p));

  // (8) 批量可压字符量下限。ref: kernel minCompressRange
  //     b 条目豁免：它换掉的是摘要与早已折叠的夹缝，不是原文，字符量门无从谈起。
  if (acceptedPlans.length === 0) {
    const totalChars = acceptedRanges.reduce((n, r) => n + r.chars, 0);
    if (totalChars < MIN_RANGE_CHARS) {
      throw new CompressValidationError(
        `Total compressible content too small (${totalChars} chars across ${acceptedRanges.length} range(s), min ${MIN_RANGE_CHARS}). Nothing here is worth reclaiming yet — do not split it into another call.`,
      );
    }
  }

  // (9)(10) 摘要长度：m / b 条目都过这道门。
  for (const r of acceptedRanges) assertSummaryLength(r.summary);
  for (const p of acceptedPlans) assertSummaryLength(p.summary);

  // 块序 = 跨度起点序（m 与 b 混排）：derive 重放与工具执行据此给同一批条目分配相同 b 编号。
  const blocks: FoldBlock[] = accepted.map((it, i) => {
    const blockId = `b${blockIdOffset + i + 1}`;
    if (it.plan) {
      const p = it.plan;
      return {
        blockId,
        summary: p.summary,
        topic: p.topic,
        directMessageIds: p.spanIdxs.map((idx) => core[idx].id),
        directMessageIdxs: [...p.spanIdxs],
        compressedTokens: p.compressedTokens,
        compressCallId: callId,
        startRef: p.startRef,
        endRef: p.endRef,
        createdAt: Date.now(),
        generation: p.generation,
        directBlockIds: p.consumed.map((b) => b.blockId),
      };
    }
    const r = it.range as ResolvedRange;
    return {
      blockId,
      summary: r.summary,
      topic: r.topic,
      directMessageIds: r.keptIdxs.map((idx) => core[idx].id),
      directMessageIdxs: [...r.keptIdxs],
      compressedTokens: r.keptIdxs.reduce((n, idx) => n + core[idx].tokens, 0),
      compressCallId: callId,
      startRef: r.startRef,
      endRef: r.endRef,
      createdAt: Date.now(),
      generation: 1,
      directBlockIds: [],
    };
  });

  return { ranges: acceptedRanges, blocks, warnings };
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
// ctx 段是游标油表（只在最新一条上出现），必须写成可选并排在 type 之后 ——
// 否则带 ctx 的标签剥不掉，下轮注入会叠加重复计费。
const WC_TAG_RE = /\n\n<wc tokens="[^"]*" type="[^"]*"(?: ctx="[^"]*")?>m\d{1,5}<\/wc>\s*$/;

/** 注入前先剥掉自身旧标签，防自增殖（ref: BC messages.ts:250-252 stripRefTag）。 */
export function stripWcTag(text: string): string {
  return text.replace(WC_TAG_RE, "");
}

function typeLabel(m: CoreMsg): string {
  if (m.role === "tool") return m.toolName || "tool";
  if (m.role === "user") return "user";
  return "meta";
}

/** ctx 传油表读数（见 refreshView 的游标注入）；不传时输出与旧版逐字节一致。 */
function renderTag(ref: string, m: CoreMsg, ctx?: string): string {
  const ctxAttr = ctx ? ` ctx="${ctx}"` : "";
  return `<wc tokens="${formatTokens(m.tokens)}" type="${typeLabel(m)}"${ctxAttr}>${ref}</wc>`;
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

  // 清单预筛（ref: BC recommend 在列清单前跑 pair 撤回预筛）：模拟校验链 (7) 的拆对
  // 撤回做不动点迭代，把「模型照单去压必被 REJECTED」的消息剔掉，剩余按 run 内相邻
  // 关系重分段。清单里的候选对端要么在同段、要么本就撤不回（无 ref / 跨 run），
  // 不做加宽模拟 —— 加宽只会让范围成活，不筛顶多多报一段可成功的候选。
  const pairs = buildPairMaps(core);
  const foldableRuns: number[][] = [];
  for (const r of merged) {
    const kept = new Set<number>(r);
    for (let iter = 0; iter < r.length + 8; iter += 1) {
      let changed = false;
      for (const i of Array.from(kept)) {
        const { idxs, dangling } = partnersOf(i, core, pairs);
        if (dangling || idxs.some((p) => !kept.has(p))) {
          kept.delete(i);
          changed = true;
        }
      }
      if (!changed) break;
    }
    let seg: number[] = [];
    for (const i of r) {
      if (kept.has(i)) {
        seg.push(i);
      } else if (seg.length > 0) {
        foldableRuns.push(seg);
        seg = [];
      }
    }
    if (seg.length > 0) foldableRuns.push(seg);
  }

  const out: RangeInfo[] = [];
  for (const r of foldableRuns) {
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
export function renderNudge(
  blocks: readonly FoldBlock[],
  ranges: readonly RangeInfo[],
  digest?: { firstBlockId: string; lastBlockId: string },
): string {
  const head = [
    "This is an efficiency nudge to compress early and keep context lean — not an overflow warning.",
    "Compress consumed ranges now, or reply and continue working (you may compress later).",
  ];
  const blockLine =
    blocks.length > 0
      ? [
          `Compressed blocks: ${blocks.length} active — ${blocks.map(fmtBlockSpan).join(", ")}`,
        ]
      : [];
  const digestLines = digest
    ? [
        `Digest older blocks: compress({ content: [{ startId: "${digest.firstBlockId}", endId: "${digest.lastBlockId}", summary: "...", topic: "..." }] }) — block refs merge whole blocks into one digest you write.`,
        "A merge loses their detail for good: what still matters must already live in a file or be stated as a file pointer. Keep the newest blocks detailed.",
      ]
    : [];
  const first = ranges[0];
  const example = first
    ? [`Example: compress({ content: [{ startId: "${first.startRef}", endId: "${first.endRef}", summary: "..." }] })`]
    : [];
  return [...head, ...blockLine, ...digestLines, renderRanges(ranges), ...example].join("\n");
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
  /** 上次提议蒸馏（D 通路）时的 active 块数；0 = 从未。抑制重复提议。 */
  lastDigestNudge: number;
  failCount: number;
  repeatSig: string;
  repeatCount: number;
  /** 连续 stuck 轮数（高压带 + 无可压范围 + 截断 0 收益），terminal escape 计数。 */
  stuckStreak: number;
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
    lastDigestNudge: 0,
    failCount: 0,
    repeatSig: "",
    repeatCount: 0,
    stuckStreak: 0,
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
  // 视图侧只认 active 块：被蒸馏吞掉的子块不再折叠、不再注入摘要（总纪要接管它们的位置）。
  // blocks（含被吞块）仍是编号与谱系的依据，故 state.blocks 存全量。
  const activeBlocks = deriveActiveBlocks(blocks);
  // 蒸馏残留：active 块摘要占的 token。D 通路提议与 stuck 判定共用这把尺子。
  let digestPending = 0;
  for (const b of activeBlocks) digestPending += estimateTokens(summaryText(b)) + 8;
  const covered = coveredIndexMap(activeBlocks);
  const coveredIdx = new Set<number>(covered.keys());

  // hide：成活（=derive 出块）的 compress 调用连同其 result 整体隐藏 —— summary 参数含
  // 全文，不隐藏就会与注入的摘要重复计费（文档 §5.4）。失败调用是正常历史、默认保留，
  // 但只保留最近 KEEP_LAST_FAILED_CALLS 对：失败错误文案看一对就够了，同参失败风暴
  // （BC 实测过 3849 次重复）恰恰是最能吞上下文的孤儿。ref: kernel hide-consumed.ts:5-22。
  const hidden = new Set<number>();
  const assistantByCall = new Map<string, number>();
  for (const m of core) for (const c of m.toolCalls) assistantByCall.set(c.id, m.idx);
  const aliveCallIds = new Set<string>();
  for (const b of activeBlocks) {
    aliveCallIds.add(b.compressCallId);
    const aIdx = assistantByCall.get(b.compressCallId);
    if (aIdx === undefined) continue;
    const assistant = core[aIdx];
    if (assistant.toolCalls.length !== 1) continue; // 同批还有别的调用，不能整条隐藏
    hidden.add(aIdx);
    for (const m of core) if (m.contentType === "tool-result" && m.toolCallId === b.compressCallId) hidden.add(m.idx);
  }
  // 孤儿 compress 对（执行过但 derive 没出块 = 被拒/失败）：除最近 N 对外全部隐藏。
  const orphanPairs: { callIdx: number; resultIdxs: number[] }[] = [];
  for (const m of core) {
    if (m.toolCalls.length !== 1 || m.toolCalls[0].name !== "compress") continue; // 混合批次不能整条隐藏
    const cid = m.toolCalls[0].id;
    if (aliveCallIds.has(cid)) continue;
    const resultIdxs = core.filter((r) => r.contentType === "tool-result" && r.toolCallId === cid).map((r) => r.idx);
    if (resultIdxs.length === 0) continue; // 结果未落盘，等下一拍
    orphanPairs.push({ callIdx: m.idx, resultIdxs });
  }
  for (const p of orphanPairs.slice(0, -KEEP_LAST_FAILED_CALLS)) {
    hidden.add(p.callIdx);
    for (const i of p.resultIdxs) hidden.add(i);
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
  for (let i = activeBlocks.length - 1; i >= 0; i -= 1) {
    const block = activeBlocks[i];
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

  // 候选清单按块跨度闭合判覆盖：跨度内夹缝不进清单，免得模型照单去压又撞 covered 错。
  const ranges = computeRanges(core, refs, coveredSpanSet(refs, activeBlocks), protectedRefs);
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
  let digestHint: { firstBlockId: string; lastBlockId: string } | undefined;
  if (firstSight) {
    // A. 首次见面即大量可压（ref: kernel firstSightMassReady :1756-1760）
    if (usage >= MIN_CONTEXT_LIMIT_PCT * win && pendingTokens >= GROWTH_FLOOR) nudged = true;
    else state.baseline = usage; // 只是没触发，也要把基线记下来供 B 通路测增长
  } else if (usage >= MIN_CONTEXT_LIMIT_PCT * win && pendingTokens >= GROWTH_FLOOR) {
    // B. 常规增长门：可压量充足时门槛降到 22.5K（ref: :1746-1751）。
    // 占用地板与 compress 工具的硬门同口径 —— 否则低占用时一边催压一边 REFUSED。
    const need = GROWTH_FLOOR * MIN_GROWTH_RATIO;
    if (growth >= need) nudged = true;
  }
  if (!nudged && usage >= MAX_CONTEXT_LIMIT_PCT * win) {
    // C. 高压带：额外要求可回收 ≥ max(5000, 1% 窗口)（ref: :1797）
    const benefit = Math.max(5000, win * 0.01);
    if (pendingTokens >= benefit && growth >= PRESSURE_GROWTH_TOKENS) nudged = true;
  }
  // D. 蒸馏通路（文档 compress-block-boundary-distillation）：active 块的摘要残留堆到
  //    阈值 → 提议把最老的非热区块合成一条总纪要。热区（最近 HOT_BLOCK_COUNT 块）不进
  //    自动提议；抑制 = 距上次提议至少新增过块 + A/B/C 已发时不叠发。
  const mergeable = Math.max(0, activeBlocks.length - HOT_BLOCK_COUNT);
  const digestReady = digestPending >= DIGEST_PENDING_TOKENS || mergeable >= DIGEST_PENDING_BLOCKS;
  if (
    !nudged &&
    digestReady &&
    mergeable >= 2 &&
    usage >= MIN_CONTEXT_LIMIT_PCT * win &&
    activeBlocks.length > state.lastDigestNudge
  ) {
    nudged = true;
    state.lastDigestNudge = activeBlocks.length;
    digestHint = { firstBlockId: activeBlocks[0].blockId, lastBlockId: activeBlocks[mergeable - 1].blockId };
  }
  if (nudged) {
    state.baseline = usage;
    state.lastNudge = usage;
    view.push({
      core: null,
      msg: {
        role: "user",
        content: [{ type: "text", text: renderNudge(activeBlocks, ranges, digestHint) }],
        timestamp: Date.now(),
      } as AgentMessage,
    });
  }

  // 标签注入（放在折叠/隐藏之后 ⇒ 标签里的 tokens 与视图一致；assistant 零标签）。
  // 游标油表：ctx 读数只挂**最新一条** user/tool 的标签上，每回合随游标挪走、
  // 旧标签自动回到无 ctx 形态 —— 历史消息字节稳定，前缀缓存不伤。
  // ⚠compress 与 B 通路/硬门同口径（≥30% 且旧段落有 ≥GROWTH_FLOOR 可回收，见 :1029 注释），
  // 免得"表上催压、真去压又被拒"。注入发生在应急截断之前，高压截断回合
  // 读数偏保守（报的是截断前占用），可接受。
  let cursorIdx = -1;
  for (let i = view.length - 1; i >= 0; i -= 1) {
    const v = view[i];
    if (!v.core) continue;
    if (!refs.byId.get(v.core.id)) continue;
    if (v.core.role !== "user" && v.core.role !== "tool") continue;
    cursorIdx = i;
    break;
  }
  const cursorCtx =
    cursorIdx >= 0 && win > 0 && usage > 0
      ? `${formatTokens(usage)}/${formatTokens(win)} ${pctOf(usage, win)}${usage >= MIN_CONTEXT_LIMIT_PCT * win && pendingTokens >= GROWTH_FLOOR ? " ⚠compress" : ""}`
      : undefined;
  for (let i = 0; i < view.length; i += 1) {
    const v = view[i];
    if (!v.core) continue;
    const ref = refs.byId.get(v.core.id);
    if (!ref) continue;
    if (v.core.role !== "user" && v.core.role !== "tool") continue;
    v.msg = injectTag(v.msg, renderTag(ref, v.core, i === cursorIdx ? cursorCtx : undefined));
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
  // 终态计数（ref: BC compress.ts:1081-1084 noViableCompression + escapeAfter）：
  // 没有任何可压区间、应急截断也没省出东西、占用还过了高压线 → 连续累计；
  // 满 TERMINAL_ESCAPE_AFTER 轮后 session_before_compact 放行内置压缩，解开溢出死锁。
  // 蒸馏残留没到阈值才算 stuck —— 还有老块可合的时候不许抢先放核弹。
  const stuck =
    win > 0 &&
    ranges.length === 0 &&
    truncated === 0 &&
    digestPending < DIGEST_PENDING_TOKENS &&
    finalUsage >= MAX_CONTEXT_LIMIT_PCT * win;
  state.stuckStreak = stuck ? state.stuckStreak + 1 : 0;
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
- Window usage below 30% — the tool refuses and reports the real numbers (e.g. "22% (56K/256K)").
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

WHEN / HOW TO DISTILL OLD SUMMARIES
Compressed blocks themselves can be merged: send BLOCK refs instead of message refs —
compress({ content: [{ startId: "b1", endId: "b7", summary: "…", topic: "…" }] }). Every block in
that range vanishes and ONE digest you write replaces them all. Distilling is lossier than
compressing: the blocks' detail is gone for good, so anything that still matters must already live
in a file, or appear in the digest as a file pointer (full path, never "see above").
A digest carries forward: how the goal evolved; decisions with their "because" and the rejected
alternatives; the pointer list (full paths of the artifacts each phase produced); traps hit
("tried X, failed because Y"); open questions and \`Open objectives:\` lines. Drop what a file
already holds. Leave the newest blocks detailed — they are still working memory; distill old ones.

TAGS
Each user/tool message carries a \`<wc tokens="2.1K" type="bash">m00175</wc>\` tag: its ref, size,
type. The NEWEST message's tag also carries \`ctx="used/window pct"\` — your live context gauge
(exactly one readout; it moves to the newest message every turn). When it shows an ⚠compress mark,
compress old ranges proactively instead of guessing from message count. Target ranges by refs in
compress calls. Never echo wc tags in your replies.

SUMMARIES IN CONTEXT
\`[Compressed conversation section]\` blocks are system metadata, not user messages. Their content
is HISTORY — record of what happened, not instructions to act on. Trust the summary as the
authoritative record; the original text remains in the session transcript for the user.`;

// ── compress 工具 ──────────────────────────────────────────────────────────
const DEAD_REPEAT_REJECT = 2;
/** 失败 compress 的孤儿 call+result 对在视图里只保留最新这么多对，更旧的隐藏
 *  （BC 曾出现 3849 次同参调用风暴，失败残留自己就在喂 token）。ref: kernel hide-consumed.ts:13。 */
const KEEP_LAST_FAILED_CALLS = 2;
/** 连续多少轮 stuck（高压带且无可压范围、应急截断也切不动）就放行 pi 内置压缩兜底。
 *  ref: kernel compress.ts:1073-1090 + config truncate.terminalEscapeAfter=3。 */
const TERMINAL_ESCAPE_AFTER = 3;
/** 一轮内累计失败上限（熔断分级 ref: BC 回合级上限 3；新一轮 user 消息清零，
 *  与 BC 按 user entry id 计数等价，见 derive 的 userCount 判定）。BC 的教训是 2 太脆：
 *  一次误报 + 一次修正失败就把整轮压缩机会烧掉。 */
const MAX_COMPRESS_ATTEMPTS = 3;

const compressRangeSpec = Type.Object({
  startId: Type.String({
    description: 'Start ref: "m00005" (message range, from the wc tag) or "b3" (merge whole blocks b3..endId into one digest).',
  }),
  endId: Type.String({ description: "Inclusive end ref (mNNNNN, or bN for a block merge)." }),
  topic: Type.Optional(Type.String({ description: "Short label for THIS range, e.g. 'Auth exploration'." })),
  summary: Type.String({
    description:
      "Complete technical summary replacing all content in range: paths+lines, signatures, exact errors, decisions, values. 50-20000 chars.",
  }),
});

// content 形态放宽（ref: kernel parseCompressInput）：模型经常把数组序列化成分隔字符串、
// 或只塞一个条目对象。schema 卡太死 = 白白浪费一个回合去试错；统一由 coerceContentItems 归一。
const compressRangeItem = Type.Union([
  compressRangeSpec,
  Type.String({ description: "JSON-encoded entry (accepted and unwrapped automatically)." }),
]);

const compressParams = Type.Object({
  topic: Type.Optional(Type.String({ description: "Fallback topic (3-5 words) for entries without one." })),
  content: Type.Union(
    [
      Type.Array(compressRangeItem, { minItems: 1 }),
      compressRangeSpec,
      Type.String({ description: "JSON-encoded array of entries, or a single entry." }),
    ],
    { description: "Range entries (array preferred); a single entry object or JSON-encoded string is auto-unwrapped." },
  ),
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
  // 回收量口径：普通块 = 被折叠原文 token − 摘要 token；合并块 = 被吞块摘要 token −
  // 总纪要 token（它们的原文早就折叠掉了，再算一次原文会虚报收益）。
  const blockById = new Map(state.blocks.map((b) => [b.blockId, b]));
  const reclaimed = created.reduce((n, b) => {
    const gained = b.directBlockIds.length
      ? b.directBlockIds.reduce((m, id) => {
          const child = blockById.get(id);
          return m + (child ? estimateTokens(summaryText(child)) + 8 : 0);
        }, 0)
      : b.compressedTokens;
    return n + Math.max(0, gained - estimateTokens(summaryText(b)) - 8);
  }, 0);
  const before = state.usage > 0 ? state.usage : state.core.reduce((n, m) => n + m.tokens, 0);
  const after = Math.max(0, before - reclaimed);
  const spans = created.map(fmtBlockSpan).join(", ");
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
    if (b.directBlockIds.length > 0) {
      lines.push(
        ` · Merged ${b.directBlockIds.length} blocks (${b.directBlockIds.join(", ")}) → ${b.blockId} (G${b.generation}). Their summaries are gone; this digest is now the only record of that stretch.`,
      );
    }
  }
  if (warnings.length > 0) lines.push(`⚠️ ${warnings.join("; ")}`);
  // 块世代全景：成功回执也列 active 清单（此前只有 nudge 与错误里有），
  // 模型看得见世代才会主动挑蒸馏靶；也让 b 分支错误的“Compressed blocks line”承诺兑现。
  const active = deriveActiveBlocks(state.blocks);
  if (active.length > 0) {
    lines.push(`Compressed blocks: ${active.length} active — ${active.map(fmtBlockSpan).join(", ")}`);
  }

  const ranges = computeRanges(state.core, state.refs, coveredSpanSet(state.refs, state.blocks), state.protectedRefs);
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
    "Replace older conversation ranges with detailed summaries you write. Single range: compress({ content: [{ startId, endId, summary }] }). Batch: compress({ content: [{ topic, startId, endId, summary }, ...] }) — each entry gets its own summary. Block refs (startId: 'b1', endId: 'b7') merge whole blocks into one digest you write. The tool reports real window usage and refuses below 30%.",
  promptSnippet: "compress({ content: [{ startId, endId, summary }] }) or batch multiple ranges",
  promptGuidelines: [
    "Each message has a wc tag with its mNNNNN ref, token size, and type. Compress ranges by their refs.",
    "Batch multiple unrelated ranges in one call — each gets its own topic and summary.",
    "Write dense, self-contained summaries — preserve file paths, signatures, errors, and decisions verbatim.",
    "Never compress content the current step is actively using.",
    "Compress under window pressure only (≥30% usage); a long transcript by itself is not a reason.",
    "One failed compress per turn: do not probe other ranges — every failure lists the live compressible ranges, pick from that list next time.",
    "The newest wc tag carries ctx=used/window percent — your live fuel gauge; an ⚠compress mark means compress old ranges now.",
    "A boundary message may be auto-widened into the block (named in a warning) to keep tool call/result pairs intact — cover it in the summary.",
    "Merge old blocks into one digest with block refs: compress({ content: [{ startId: 'b1', endId: 'b7', summary, topic }] }) — the digest must carry file pointers and open leads forward; keep the newest blocks detailed.",
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
  const dropNotes: string[] = [];
  try {
    const entries = parseCompressEntries(params, dropNotes);
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
    // 抢救回来的部分条目照常成活，坏条目点名跳过（省一个整批重试的回合）。
    if (dropNotes.length > 0) {
      result.warnings.push(`Skipped ${dropNotes.length} malformed entr${dropNotes.length === 1 ? "y" : "ies"}: ${dropNotes.join("; ")}`);
    }
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
    // 失败必附 LIVE 可压范围（ref: BC 同指纹硬拒直接列 viable ranges）：模型与其盲猜
    // 下一个范围，不如照清单挑。每次现算——块账本/保护区在两次尝试间可能已变。
    const liveRangesText = (): string => {
      const ranges = computeRanges(state.core, state.refs, coveredSpanSet(state.refs, state.blocks), state.protectedRefs);
      return ranges.length > 0 ? renderRanges(ranges) : "No compressible range (≥5000 chars) is available right now.";
    };
    if (state.repeatCount >= DEAD_REPEAT_REJECT) {
      throw new Error(
        `REJECTED — the same range failed twice and is not compressible. ${message}\n` +
          liveRangesText() +
          `\n${NO_RETRY_STEER}`,
      );
    }
    if (state.failCount >= MAX_COMPRESS_ATTEMPTS) {
      throw new Error(
        `PAUSED — ${MAX_COMPRESS_ATTEMPTS} compress attempts already failed this turn. Stop and continue working (the gauge stays valid; a new user message re-arms compress).\n` +
          liveRangesText(),
      );
    }
    if (e instanceof CompressValidationError) {
      // 首次校验失败也给 LIVE 出路：错误文案再准，模型还是要自己猜下一个范围。
      throw new Error(`${message}\n${liveRangesText()}\n${NO_RETRY_STEER}`);
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
  // 唯一例外：终态（无可压区间 + 截不动 + 连续 TERMINAL_ESCAPE_AFTER 轮高压）——放行
  // pi 内置 compact，否则会永久卡在溢出上。放行时清零计数；内置压缩重写转录后 derive
  // 块整体失效重放，账本自然重置。ref: BC compress.ts:1081-1084 escapeAfter=3。
  pi.on("session_before_compact", (_event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    const st = sessionStateFor(sid);
    if (st && st.stuckStreak >= TERMINAL_ESCAPE_AFTER) {
      st.stuckStreak = 0;
      return undefined; // 不 cancel ⇒ 内置压缩照常执行
    }
    return { cancel: true };
  });

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
