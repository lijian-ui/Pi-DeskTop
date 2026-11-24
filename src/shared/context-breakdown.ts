/**
 * 环形上下文用量的「点击查看明细」口径 —— 纯函数、零 IO，main / renderer 共用
 * （放在 src/shared 的先例：src/shared/i18n、src/shared/schedule）。
 *
 * token 估算对齐 acp-kernel `src_tokenize.ts:5-13`（与
 * src/main/pi/compress/piwork-compress.ts 的 estimateTokens 同一把尺子）：
 * CJK 1 字 = 1 token，其余 4 字符 = 1 token。这只是「估算口径」，与 provider
 * 报称的真实计费 token 数是两套读数，只能分行展示、不得互相换算或相减
 * （BC issue #18 纪律）。
 */

/** 我们扩展写进上下文的摘要前缀（src/main/pi/compress/piwork-compress.ts:114）。 */
export const SUMMARY_HEADER = "[Compressed conversation section]";

/**
 * CJK 基本区 + 平假名/片假名 + 谚文音节（与 compress 扩展同一把尺子的字符范围）。
 * String.match 带 /g 会自行复位 lastIndex，模块级复用安全。
 */
const CJK_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;

/** 分类输入：main 侧把 session entries 投影成这个形态，renderer 只消费结果。 */
export type BreakdownContentType = "text" | "tool-call" | "tool-result";

export interface BreakdownMessage {
  role: string;
  text: string;
  contentType: BreakdownContentType;
  /** 思考内容折算好的 token；只有有限正数才计入（防御 undefined / NaN / 负数）。 */
  thinkingTokens?: number;
  /**
   * 上游已认定这条就是压缩摘要（内置压缩边界的 summary 不带我们的前缀，
   * 靠这个标记兜住）。命中摘要桶的判定是 `summary === true || 前缀匹配`。
   */
  summary?: boolean;
}

/** 消息侧分桶结果（按来源分桶：谁产生的内容占了多少上下文）。 */
export interface BreakdownBuckets {
  /** 对话转录里的 system 角色消息；UI 并入「系统提示」行展示。 */
  system: number;
  /** 用户输入：user 角色正文（未知/自定义角色的兜底）。 */
  user: number;
  /** 模型输出：assistant 正文 + 思考。 */
  model: number;
  /** 工具：调用入参 + 工具输出。 */
  tool: number;
  /** 压缩摘要（自研 wc-summary + 内置压缩边界）。 */
  summaries: number;
  /** 桶和与外部地板（provider 真实读数）取大后的合计。 */
  total: number;
}

/** getContextUsage 附带的完整明细；拿不到原料的字段给 null（UI 显示 n/a，不按 0 算）。 */
export interface ContextBreakdown extends BreakdownBuckets {
  systemPrompt: number | null;
  toolDefs: number | null;
  providerTokens: number | null;
  /** true = 条目过多被截断，或原料不全，合计只是下界。 */
  estimated: boolean;
}

/** CJK 1:1，其余 4 字符:1（向上取整）。 */
export function countTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(CJK_RE) ?? []).length;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/** 单条消息的估算：正文 + 守卫过的思考 token。 */
export function countMessageTokens(msg: BreakdownMessage): number {
  const thinking = msg.thinkingTokens;
  const extra =
    typeof thinking === "number" && Number.isFinite(thinking) && thinking > 0 ? thinking : 0;
  return countTokens(msg.text) + extra;
}

/**
 * 只按 contentType 判定工具消息，**禁止看 toolName**（kernel src_message-kind.ts；
 * BC issue #390 的教训：普通文本消息也可能带 toolName 字段，按名字判会把正文算进工具桶）。
 */
export function isToolMessage(msg: BreakdownMessage): boolean {
  return msg.contentType === "tool-call" || msg.contentType === "tool-result";
}

/** 摘要判定：上游标记优先，其次我们扩展的前缀。 */
export function isSummaryMessage(msg: BreakdownMessage): boolean {
  return msg.summary === true || (typeof msg.text === "string" && msg.text.startsWith(SUMMARY_HEADER));
}

/** compress 工具名（与 src/main/pi/compress/piwork-compress.ts 注册名一致）。 */
export const COMPRESS_TOOL_NAME = "compress";

/**
 * 从 compress 调用的参数重建注入发送视图的摘要文本（拼接形态与 piwork-compress.ts
 * 的 summaryText 逐字一致）。
 *
 * wc-summary 摘要只在 `context` 事件逐回合注入发送视图，**从不落盘转录**，明细里
 * 只能从转录中 compress toolCall 的 summary 参数恢复回 summaries 桶。防御式解析：
 * 校验不通过的参数（失败的调用）返回空数组 —— 它们本来也没作为摘要生效。
 */
export function reconstructCompressSummaries(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const raw = args as { topic?: unknown; content?: unknown };
  const topTopic = typeof raw.topic === "string" && raw.topic.trim() !== "" ? raw.topic : undefined;
  if (!Array.isArray(raw.content)) return [];
  const out: string[] = [];
  for (const item of raw.content) {
    if (!item || typeof item !== "object") continue;
    const e = item as { summary?: unknown; topic?: unknown };
    if (typeof e.summary !== "string" || e.summary === "") continue;
    const topic = typeof e.topic === "string" && e.topic.trim() !== "" ? e.topic : topTopic;
    out.push(topic ? `${SUMMARY_HEADER} — ${topic}\n${e.summary}` : `${SUMMARY_HEADER}\n${e.summary}`);
  }
  return out;
}

/**
 * 分桶。判定顺序不许改：summaries → tool(contentType) → system → assistant → 其余。
 * 摘要必须抢在 tool 前（摘要由 compress 工具产出，形态上是 tool 结果）；tool 必须
 * 抢在其余之前（工具入参、返回值里满是代码块与正文）。其余按来源：assistant 进
 * 「模型输出」，user 及未知角色进「用户输入」。
 *
 * `total` 是外部地板（provider 报称的真实 token），合计取 `max(桶和, 地板)`。
 */
export function computeContextBreakdown(
  messages: readonly BreakdownMessage[],
  total?: number | null,
): BreakdownBuckets {
  let system = 0;
  let user = 0;
  let model = 0;
  let tool = 0;
  let summaries = 0;
  for (const msg of messages) {
    if (!msg) continue;
    const tokens = countMessageTokens(msg);
    if (isSummaryMessage(msg)) summaries += tokens;
    else if (isToolMessage(msg)) tool += tokens;
    else if (msg.role === "system") system += tokens;
    else if (msg.role === "assistant") model += tokens;
    else user += tokens;
  }
  const sum = system + user + model + tool + summaries;
  const floor = typeof total === "number" && Number.isFinite(total) ? total : 0;
  return { system, user, model, tool, summaries, total: Math.max(sum, floor) };
}
