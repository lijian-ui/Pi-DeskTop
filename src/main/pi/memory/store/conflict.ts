/**
 * Lexical conflict detection for memories.
 *
 * When a new memory is about to be written, we compare it against the existing
 * entries of the SAME target and flag pairs that look like contradictory
 * assertions about the same subject — e.g. "this project uses npm" vs
 * "this project uses pnpm", or "user likes X" vs "user dislikes X".
 *
 * Deliberately lexical (no extra LLM call). Two signals must agree:
 *  1. SUBJECT — the two entries are about the same thing. Measured as
 *     containment of the shorter entry's content terms (not symmetric Jaccard,
 *     which penalises the longer of two phrasings).
 *  2. CONTRADICTION — either a polarity flip (one side negated, the other not)
 *     or both sides picking different options for the same slot
 *     ("使用 npm" vs "使用 yarn").
 *
 * Bias: false negatives are ACCEPTED (the LLM review/flush path can still
 * replace), false positives are kept low, because a spurious "conflict" badge
 * is worse than a missed one — and the ambiguous cases a lexical check cannot
 * resolve ("项目用 pnpm 不用 npm" vs "项目用 npm 不用 pnpm") are exactly the
 * ones the reviewer should judge with full context.
 */

import { tokenizeForStorage } from "../ranking";

export interface ConflictCandidate {
  /** The existing entry that conflicts. */
  existingText: string;
  /** Why it was flagged, for the UI/log. */
  reason: "negation" | "value-replacement";
  /** Containment score in [0,1] between the two entries' content terms. */
  overlap: number;
}

/** Markers that flip the polarity of an assertion (either language). */
const NEGATION_CUES = [
  "不", "别", "禁止", "不要", "不用", "没有", "无", "非", "取消",
  "not", "no", "don't", "dont", "never", "avoid", "stop", "without",
  "disallow", "disable", "forbid", "instead",
  "dislike", "dislikes", "hate", "hates", "against", "oppose", "opposes",
  "喜欢", "不喜欢", "讨厌", "反对",
];

/**
 * Verbs that select an option ("使用 npm", "换成 pnpm", "using yarn"). Shared
 * by the contradiction signal: when both entries pick, but pick differently,
 * the entries disagree.
 */
const CHOICE_VERBS = [
  "使用", "采用", "改用", "换成", "改为", "选用", "选择", "用", "作为",
  "use", "using", "choose", "select", "switch", "migrate", "replace", "prefer",
];

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "to", "of", "and", "or", "for", "in", "on",
  "it", "this", "that", "use", "uses", "using", "used", "prefer", "prefers",
  "preferred", "as", "with", "by", "at", "be", "was", "were",
]);

/**
 * Reduce text to content terms that are stable across phrasings.
 *
 * `tokenizeForStorage` emits CJK bigram fragments (管理 → 管理|理依|依赖).
 * Those overlapping fragments are great for FTS recall but terrible for set
 * comparison, so we keep only tokens that carry meaning:
 *  - Latin/digit tokens (identifiers) of length ≥ 2
 *  - CJK tokens of length ≥ 2
 */
function contentTerms(text: string): Set<string> {
  const tokens = tokenizeForStorage(text).split(/\s+/).filter(Boolean);
  const kept = new Set<string>();
  for (const t of tokens) {
    const lower = t.toLowerCase();
    if (STOPWORDS.has(lower)) continue;
    if (/[a-z0-9]/.test(lower)) {
      if (lower.length >= 2) kept.add(lower);
      continue;
    }
    if (t.length >= 2) kept.add(t);
  }
  return kept;
}

/**
 * Asymmetric overlap: how much of the SHORTER term set the other covers.
 *
 * Symmetric Jaccard punishes "项目用 npm 不用 pnpm" against the longer
 * "这个项目使用 npm 作为包管理器，不使用 pnpm" purely for having extra words.
 * Containment answers the question we actually care about — same subject?
 */
function overlapScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const t of small) if (large.has(t)) inter++;
  return inter / small.size;
}

/** Whether the text carries a negation cue. */
function hasNegation(text: string): boolean {
  const lower = text.toLowerCase();
  return NEGATION_CUES.some((cue) => lower.includes(cue.toLowerCase()));
}

/** Whether the text names a choice verb. */
function hasChoiceVerb(text: string): boolean {
  const lower = text.toLowerCase();
  return CHOICE_VERBS.some((v) => lower.includes(v));
}

/**
 * True when both entries pick an option for the same slot, but pick differently
 * ("使用 npm 管理依赖" vs "使用 yarn 管理依赖").
 *
 * Note: `tokenizeForStorage` hoists Latin/identifier tokens to the FRONT of its
 * output, so positional "token after the verb" adjacency is unusable. We
 * compare identifier-shaped sets instead: the two examples differ exactly by
 * {npm} vs {yarn}.
 */
function namesDifferentOption(
  a: string,
  existing: string,
  termsA: Set<string>,
  termsB: Set<string>,
): boolean {
  if (!hasChoiceVerb(a) || !hasChoiceVerb(existing)) return false;
  const optsA = optionTokens(termsA);
  const optsB = optionTokens(termsB);
  if (optsA.size === 0 || optsB.size === 0) return false;
  const aOnly = [...optsA].filter((t) => !optsB.has(t));
  const bOnly = [...optsB].filter((t) => !optsA.has(t));
  return aOnly.length > 0 && bOnly.length > 0;
}

/**
 * Option-like tokens within a term set: Latin/digit identifiers are the
 * strongest signal (npm, yarn, python3); CJK nouns (length ≥ 2, not a verb)
 * are weaker but still usable.
 */
function optionTokens(terms: Set<string>): Set<string> {
  const opts = new Set<string>();
  for (const t of terms) {
    if (/[a-z0-9]/.test(t)) {
      opts.add(t);
      continue;
    }
    if (t.length >= 2 && !CHOICE_VERBS.includes(t)) opts.add(t);
  }
  return opts;
}

/**
 * Find existing entries that lexically contradict `newContent`.
 *
 * @param newContent the memory about to be written
 * @param existingTexts current entries of the same target (metadata already stripped)
 * @param minOverlap containment floor to consider "same subject" (default 0.45)
 */
export function detectConflicts(
  newContent: string,
  existingTexts: string[],
  minOverlap = 0.45,
): ConflictCandidate[] {
  const newTokens = contentTerms(newContent);
  if (newTokens.size === 0) return [];

  const newNeg = hasNegation(newContent);
  const found: ConflictCandidate[] = [];

  for (const existing of existingTexts) {
    if (!existing?.trim()) continue;
    // Identical text is a restatement, never a conflict — this also skips the
    // entry's own freshly-written copy when it is already visible in the store.
    if (existing.trim() === newContent.trim()) continue;

    const existingTokens = contentTerms(existing);
    const overlap = overlapScore(newTokens, existingTokens);
    if (overlap < minOverlap) continue;

    // Signal 1: polarity flip (one side negated, the other not).
    if (newNeg !== hasNegation(existing)) {
      found.push({ existingText: existing, reason: "negation", overlap });
      continue;
    }

    // Signal 2: same slot, different option. Needs a stronger subject match,
    // because "both picked something" is weaker evidence than a polarity flip.
    if (
      overlap >= Math.max(minOverlap, 0.5) &&
      namesDifferentOption(newContent, existing, newTokens, existingTokens)
    ) {
      found.push({ existingText: existing, reason: "value-replacement", overlap });
    }
  }
  return found;
}
