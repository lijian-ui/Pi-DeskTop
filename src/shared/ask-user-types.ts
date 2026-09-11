/**
 * Shared types for the first-party `ask_user_question` tool (desktop port of
 * @juicesharp/rpiv-ask-user-question — MIT, see ask-user-core.ts header).
 *
 * The model calls the tool with 1-4 structured questions (each with 2-4
 * written-out options); the renderer shows them as an interactive card queue
 * above the chat composer; the user's answers come back as a structured
 * `QuestionnaireResult` and are handed to the model as the tool envelope.
 *
 * These types are consumed by BOTH the main process (schema/validation/envelope
 * in ask-user-core.ts) and the renderer (AskUserPanel). Pure data — no SDK
 * imports.
 */

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;

/**
 * Labels reserved for runtime sentinels — authoring an option with any of
 * these triggers the `reserved_label` runtime guard. The UI appends its own
 * "自定义回答" row, so the model must never author an equivalent label itself.
 * Order matters ("Other" first) — keep the literal.
 */
export const RESERVED_LABELS = ["Other", "Type something.", "Next"] as const;
export type ReservedLabel = (typeof RESERVED_LABELS)[number];

/** One selectable choice the model authored. */
export interface AskUserOption {
  /** Concise display text the user sees (1-5 words). */
  label: string;
  /** Explanation of what this choice means / its trade-offs. */
  description: string;
  /**
   * Optional markdown preview (mockups, code, config…) rendered beside the
   * option list once the option is focused/selected. Single-select only in
   * practice — the core validator does not forbid it for multiSelect, but the
   * tool description guides the model away.
   */
  preview?: string;
}

/** One question of a questionnaire (1-4 per invocation). */
export interface AskUserQuestion {
  /** Full question text, as the agent authored it. */
  question: string;
  /** Very short chip/tag shown next to the question. */
  header: string;
  /** Author-defined choices (2-4). A free-text "type your own" row is always
   *  appended by the UI — never authored here. */
  options: AskUserOption[];
  /** True iff the user may pick multiple options. */
  multiSelect?: boolean;
}

/** Tool parameters. */
export interface AskUserParams {
  questions: AskUserQuestion[];
}

/**
 * Answer intent discriminated union.
 * - `option`: picked one author-defined option; `answer` = its label.
 * - `custom`: free-text via the "type your own" row; `answer` = typed text.
 * - `multi`: committed multi-select choices; `selected` carries labels.
 */
export interface AskUserAnswer {
  questionIndex: number;
  question: string;
  kind: "option" | "custom" | "multi";
  answer: string | null;
  selected?: string[];
  /** Optional per-question note authored by the user (rides as `user notes:`). */
  notes?: string;
  /** Markdown of the matched option's `preview` (echoed as `selected preview:`). */
  preview?: string;
}

/** Structured result that becomes the tool's `details`. */
export interface AskUserResult {
  answers: AskUserAnswer[];
  /** True when the user abandoned the questionnaire (Esc / cancel). */
  cancelled: boolean;
  /** Global note for the whole questionnaire (rides as `global note:`). */
  globalNote?: string;
}

export function isAskUserResult(value: unknown): value is AskUserResult {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.answers) && typeof v.cancelled === "boolean";
}

/** Main → renderer: a questionnaire has arrived and awaits user input. */
export interface AskUserPromptPayload {
  /** Unique questionnaire id (pending registry key). */
  id: string;
  /** Owning session path — the card only shows when that session is focused. */
  sessionPath: string;
  questions: AskUserQuestion[];
}

/** Renderer → main: user answered (or cancelled). */
export interface AskUserAnswerPayload {
  id: string;
  cancelled: boolean;
  answers?: AskUserAnswer[];
  globalNote?: string;
}

/** Main → renderer: the questionnaire was closed without a user action
 *  (agent aborted / session torn down) — drop the card if still showing. */
export interface AskUserClosedPayload {
  id: string;
}
