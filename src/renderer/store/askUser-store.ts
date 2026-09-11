/**
 * ask_user_question — renderer store.
 *
 * Holds the questionnaires pushed by the main process (`pi:askUserPrompt`),
 * keyed by questionnaire id, plus the user's in-progress drafts (option
 * selections, custom answers, per-question notes, global note) and the wizard
 * step (which question is currently shown). Drafts are kept per questionnaire
 * so switching sessions and coming back preserves the user's half-written
 * answers.
 *
 * Only the FOCUSED session's card renders (AskUserPanel matches against
 * session-store.currentPath) — parallel runs in other sessions keep their own
 * cards in this map until answered or closed.
 */
import { create } from "zustand";
import type {
  AskUserAnswer,
  AskUserAnswerPayload,
  AskUserPromptPayload,
} from "../../shared/ask-user-types";

/** Per-question user draft state. */
export interface AskUserQuestionDraft {
  /** Indexes of toggled author options (radio: 0-1 entries; multi: 0-N). */
  selected: number[];
  /** True when the user switched to the "type your own" textarea. */
  customMode: boolean;
  customText: string;
  /** Optional note attached to this question's answer (`user notes:`). */
  notes: string;
}

/** One pending questionnaire card with its live drafts. */
export interface AskUserCard {
  payload: AskUserPromptPayload;
  drafts: AskUserQuestionDraft[];
  globalNote: string;
  /** Wizard position — which question is currently shown (0-based). */
  step: number;
  submitting: boolean;
}

interface AskUserState {
  /** Questionnaire id → card. */
  cards: Record<string, AskUserCard>;
  /** Show/refresh a questionnaire (called from the onAskUserPrompt handler). */
  upsert: (payload: AskUserPromptPayload) => void;
  /** Drop a card (called from onAskUserClosed and after submit/cancel). */
  remove: (id: string) => void;
  setDraft: (
    id: string,
    questionIndex: number,
    patch: Partial<AskUserQuestionDraft>,
  ) => void;
  setGlobalNote: (id: string, note: string) => void;
  /** Move the wizard to another question (clamped by the UI). */
  setStep: (id: string, step: number) => void;
  /** Send the collected answers to the main process. */
  submit: (id: string) => Promise<void>;
  /** Abandon the questionnaire (DECLINE semantics). */
  cancel: (id: string) => Promise<void>;
}

function freshDrafts(questions: AskUserPromptPayload["questions"]): AskUserQuestionDraft[] {
  return questions.map(() => ({
    selected: [],
    customMode: false,
    customText: "",
    notes: "",
  }));
}

export const useAskUserStore = create<AskUserState>((set, get) => ({
  cards: {},

  upsert: (payload) => {
    set((s) => {
      const prev = s.cards[payload.id];
      // A live questionnaire should never be replaced mid-edit — only refresh
      // when the payload is actually new (same id = same questionnaire).
      if (prev) return s;
      return {
        cards: {
          ...s.cards,
          [payload.id]: {
            payload,
            drafts: freshDrafts(payload.questions),
            globalNote: "",
            step: 0,
            submitting: false,
          },
        },
      };
    });
  },

  remove: (id) => {
    set((s) => {
      if (!(id in s.cards)) return s;
      const cards = { ...s.cards };
      delete cards[id];
      return { cards };
    });
  },

  setDraft: (id, questionIndex, patch) => {
    set((s) => {
      const card = s.cards[id];
      if (!card) return s;
      const drafts = card.drafts.map((d, i) =>
        i === questionIndex ? { ...d, ...patch } : d,
      );
      return { cards: { ...s.cards, [id]: { ...card, drafts } } };
    });
  },

  setGlobalNote: (id, globalNote) => {
    set((s) => {
      const card = s.cards[id];
      if (!card) return s;
      return { cards: { ...s.cards, [id]: { ...card, globalNote } } };
    });
  },

  setStep: (id, step) => {
    set((s) => {
      const card = s.cards[id];
      if (!card) return s;
      return { cards: { ...s.cards, [id]: { ...card, step } } };
    });
  },

  submit: async (id) => {
    const card = get().cards[id];
    if (!card || card.submitting) return;
    set((s) => ({
      cards: { ...s.cards, [id]: { ...card, submitting: true } },
    }));

    const answers = buildAnswers(card.payload, card.drafts);
    const payload: AskUserAnswerPayload = {
      id,
      cancelled: false,
      answers,
      ...(card.globalNote && card.globalNote.trim().length > 0
        ? { globalNote: card.globalNote.trim() }
        : {}),
    };
    // Nothing answered and no global note → semantically identical to cancel
    // (DECLINE) rather than delivering an empty "answered" envelope.
    if (answers.length === 0 && !payload.globalNote) {
      payload.cancelled = true;
      delete payload.answers;
    }

    try {
      await window.piDesk.answerAskUserQuestion(payload);
    } finally {
      // Drop the card regardless of the IPC result — an unknown id means the
      // questionnaire already settled elsewhere (abort/timeout ghost).
      get().remove(id);
    }
  },

  cancel: async (id) => {
    const card = get().cards[id];
    if (!card || card.submitting) return;
    set((s) => ({
      cards: { ...s.cards, [id]: { ...card, submitting: true } },
    }));
    try {
      // A global note authored before cancelling still rides in `details`.
      const payload: AskUserAnswerPayload = { id, cancelled: true };
      if (card.globalNote && card.globalNote.trim().length > 0) {
        payload.globalNote = card.globalNote.trim();
      }
      await window.piDesk.answerAskUserQuestion(payload);
    } finally {
      get().remove(id);
    }
  },
}));

/** Convert drafts + payload into the structured answer list (main-process
 *  envelope consumes these). Mirrors rpiv's answer-intent semantics:
 *  - single-select: chosen option label (+preview) OR custom free text;
 *  - multi-select: chosen labels; a custom answer takes precedence (the
 *    free-text row is the "type your own" escape on both variants);
 *  - unanswered questions are omitted (their envelope segment is absent).
 */
function buildAnswers(
  payload: AskUserPromptPayload,
  drafts: AskUserQuestionDraft[],
): AskUserAnswer[] {
  const out: AskUserAnswer[] = [];
  payload.questions.forEach((q, qi) => {
    const d = drafts[qi];
    if (!d) return;
    const qa: AskUserAnswer = {
      questionIndex: qi,
      question: q.question,
      kind: "option",
      answer: null,
    };

    const custom = d.customMode && d.customText.trim().length > 0;
    if (q.multiSelect) {
      if (custom) {
        qa.kind = "custom";
        qa.answer = d.customText.trim();
      } else if (d.selected.length > 0) {
        qa.kind = "multi";
        qa.answer = null;
        qa.selected = d.selected.map((i) => q.options[i]?.label).filter(Boolean) as string[];
      } else {
        return; // no answer for this question
      }
    } else {
      if (custom) {
        qa.kind = "custom";
        qa.answer = d.customText.trim();
      } else if (d.selected.length === 1) {
        const opt = q.options[d.selected[0]];
        if (!opt) return;
        qa.kind = "option";
        qa.answer = opt.label;
        if (opt.preview && opt.preview.length > 0) qa.preview = opt.preview;
      } else {
        return; // no answer
      }
    }

    if (d.notes && d.notes.trim().length > 0) qa.notes = d.notes.trim();
    out.push(qa);
  });
  return out;
}
