/**
 * ask_user_question — core pure logic (schema, validation, envelope).
 *
 * Faithfully ported from `@juicesharp/rpiv-ask-user-question` v2.9.0 (MIT,
 * https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question):
 * the typebox parameter schema with hard limits, the runtime validator
 * (incl. reserved-label guard BEFORE duplicate-label), the answer-segment
 * formatter and the LLM-facing envelope builder. The terminal/RPC UI layers of
 * the original are NOT ported — pi-desktop is a headless Electron embed of the
 * Pi SDK (ctx.mode="print", no ctx.ui), so interaction goes through our own
 * IPC card queue (ask-user-extension.ts + renderer AskUserPanel).
 *
 * Content/envelope strings are localized to Chinese for consistency with the
 * other first-party tools (todo etc.). Reserved labels stay in their original
 * English form: the model authors options in whatever language, but those
 * exact strings would collide with the UI-appended free-text row.
 *
 * The file is deliberately SDK-free: everything here is a pure function of
 * plain shared types (src/shared/ask-user-types.ts), so it can be unit-tested
 * and reasoned about in isolation.
 */
import { Type } from "typebox";
import {
  MAX_HEADER_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MIN_OPTIONS,
  RESERVED_LABELS,
  type AskUserAnswer,
  type AskUserParams,
  type AskUserResult,
} from "../../../shared/ask-user-types";

/* ------------------------------------------------------------------ */
/* Schema — hard limits enforced at the tool boundary (TypeBox).       */
/* ------------------------------------------------------------------ */

const OptionSchema = Type.Object({
  label: Type.String({
    maxLength: MAX_LABEL_LENGTH,
    description: `MAX ${MAX_LABEL_LENGTH} CHARACTERS — hard limit, requests over the limit are rejected. The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.`,
  }),
  description: Type.String({
    description:
      "Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
  }),
  preview: Type.Optional(
    Type.String({
      description:
        "Optional markdown preview (mockups, code snippets, configuration examples) rendered when this option is selected, so the user compares real artifacts rather than just labels.",
    }),
  ),
});

const QuestionSchema = Type.Object({
  question: Type.String({
    description:
      'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly. Use it only when the user\'s request is genuinely underspecified and you cannot proceed without a decision.',
  }),
  header: Type.String({
    maxLength: MAX_HEADER_LENGTH,
    description: `MAX ${MAX_HEADER_LENGTH} CHARACTERS — hard limit, requests over the limit are rejected. Very short chip/tag shown next to the question. Examples: "Auth method", "Library", "Approach".`,
  }),
  options: Type.Array(OptionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description:
      "The available choices for this question. Must have 2-4 options, each a distinct mutually exclusive choice (unless multiSelect). A free-text 'type your own' row is appended by the UI automatically — do NOT author it.",
  }),
  multiSelect: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
    }),
  ),
});

export const AskUserQuestionnaireSchema = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    maxItems: MAX_QUESTIONS,
    description: "Questions to ask the user (1-4 questions).",
  }),
});

/* ------------------------------------------------------------------ */
/* Runtime validation (mirrors rpiv validate-questionnaire.ts).        */
/* ------------------------------------------------------------------ */

export const ERROR_NO_QUESTIONS = "错误：至少需要 1 个问题";
export const ERROR_TOO_MANY_QUESTIONS = `错误：每次调用最多 ${MAX_QUESTIONS} 个问题`;
export const ERROR_DUPLICATE_QUESTION = "错误：同一调用内问题文本必须唯一";
export const ERROR_TOO_FEW_OPTIONS = `错误：每个问题至少需要 ${MIN_OPTIONS} 个选项`;
export const ERROR_RESERVED_LABEL = `错误：选项标签为保留词（${RESERVED_LABELS.join("、")}）——这些由界面自动追加，请勿自行编写`;
export const ERROR_DUPLICATE_OPTION_LABEL = "错误：同一问题内选项标签必须唯一";

const RESERVED_LABEL_SET: ReadonlySet<string> = new Set<string>(RESERVED_LABELS);

export type AskUserValidation =
  | { ok: true }
  | { ok: false; error: string; message: string };

/**
 * Pure runtime validator for `AskUserParams`. Covers every guard that does not
 * depend on the environment. `reserved_label` MUST short-circuit before
 * `duplicate_option_label` (mirrors rpiv).
 */
export function validateAskUserQuestionnaire(params: AskUserParams): AskUserValidation {
  if (params.questions.length === 0) {
    return { ok: false, error: "no_questions", message: ERROR_NO_QUESTIONS };
  }
  if (params.questions.length > MAX_QUESTIONS) {
    return { ok: false, error: "too_many_questions", message: ERROR_TOO_MANY_QUESTIONS };
  }

  const seenQuestions = new Set<string>();
  for (const q of params.questions) {
    if (seenQuestions.has(q.question)) {
      return { ok: false, error: "duplicate_question", message: ERROR_DUPLICATE_QUESTION };
    }
    seenQuestions.add(q.question);
  }

  for (const q of params.questions) {
    if (q.options.length < MIN_OPTIONS) {
      return { ok: false, error: "empty_options", message: ERROR_TOO_FEW_OPTIONS };
    }
    const seenLabels = new Set<string>();
    for (const o of q.options) {
      if (RESERVED_LABEL_SET.has(o.label)) {
        return { ok: false, error: "reserved_label", message: ERROR_RESERVED_LABEL };
      }
      if (seenLabels.has(o.label)) {
        return { ok: false, error: "duplicate_option_label", message: ERROR_DUPLICATE_OPTION_LABEL };
      }
      seenLabels.add(o.label);
    }
  }

  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Answer formatting + LLM-facing envelope (mirrors rpiv).             */
/* ------------------------------------------------------------------ */

const NO_INPUT_PLACEHOLDER = "(无输入)";
const DECLINE_MESSAGE = "用户已取消作答（未回答任何问题）。不要假设答案，请按你的最佳判断继续，或向用户说明你需要的决策。";
const ENVELOPE_PREFIX = "用户已回答你的问题：";
const ENVELOPE_SUFFIX = "现在可以带着用户的回答继续。";

/** Scalar form of one answer (used inside the envelope segments). */
export function formatAnswerScalar(a: AskUserAnswer): string {
  switch (a.kind) {
    case "multi":
      return a.selected && a.selected.length > 0 ? a.selected.join("、") : NO_INPUT_PLACEHOLDER;
    case "custom":
      return a.answer && a.answer.length > 0 ? a.answer : NO_INPUT_PLACEHOLDER;
    case "option":
      return a.answer ?? NO_INPUT_PLACEHOLDER;
    default:
      // Exhaustive over AskUserAnswer["kind"]; TS cannot always prove it.
      return NO_INPUT_PLACEHOLDER;
  }
}

/** One `"Q"=A` segment with optional `selected preview:` / `user notes:` suffixes. */
function buildAnswerSegment(a: AskUserAnswer): string {
  const parts: string[] = [`"${a.question}"="${formatAnswerScalar(a)}"`];
  if (a.preview && a.preview.length > 0) parts.push(`选中预览：${a.preview}`);
  if (a.notes && a.notes.length > 0) parts.push(`用户备注：${a.notes}`);
  return `${parts.join("。")}。`;
}

/**
 * Map a `AskUserResult` to the model-facing envelope text. Cancelled and
 * "no segments" both fall to the single canonical DECLINE message. A global
 * note riding a cancelled result still survives in `details` for replay.
 */
export function buildAskUserEnvelope(result: AskUserResult | null | undefined, params: AskUserParams): string {
  if (!result || result.cancelled) {
    return DECLINE_MESSAGE;
  }
  const segments: string[] = [];
  for (let i = 0; i < params.questions.length; i++) {
    const a = result.answers.find((x) => x.questionIndex === i);
    if (a) segments.push(buildAnswerSegment(a));
  }
  if (result.globalNote && result.globalNote.length > 0) {
    segments.push(`全局备注：${result.globalNote}。`);
  }
  if (segments.length === 0) {
    return DECLINE_MESSAGE;
  }
  return `${ENVELOPE_PREFIX} ${segments.join(" ")} ${ENVELOPE_SUFFIX}`;
}

/** Tool result shape: text content for the model + structured details. */
export interface AskUserToolResultBody<T = unknown> {
  content: Array<{ type: "text"; text: string }>;
  details: T;
}

export function buildAskUserToolResult(text: string, details: AskUserResult): AskUserToolResultBody<AskUserResult> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}
