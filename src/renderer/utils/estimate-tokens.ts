/**
 * 粗略 token 估算 —— 供流式输出过程中的"实时上下文用量"显示用。
 *
 * 背景：API 侧的 usage 只在**请求结束后**才有精确值（OpenAI 兼容流的 include_usage
 * 也是最后一帧才到），环形进度条想在输出过程中实时爬升只能靠估算。
 *
 * 口径：CJK 字符 ≈ 1 token/字；其他字符 ≈ 4 字符/token（BPE 词表的经验值，
 * 中英混排会有 ±20% 级别的偏差）。只求趋势正确 —— 回合结束后 ChatComposer 的
 * getContextUsage 轮询会用精确值覆盖。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    // CJK 统一表意文字 + 扩展A + 兼容表意 + 全角标点
    if (/[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}
