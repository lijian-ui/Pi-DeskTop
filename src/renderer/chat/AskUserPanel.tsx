/**
 * AskUserPanel — the model-driven questionnaire, ONE STEP per card.
 *
 * Rendered inside ChatComposer (above the input area, next to the bash
 * approval popup). When the model calls `ask_user_question` for the FOCUSED
 * session, this shows a slim wizard so the popup stays short no matter how
 * many questions the model asked:
 *
 *   Q1 → Q2 → … → Qn → 整体备注（可选，独立最后一步）→ 提交回答
 *
 * Each question step supports single/multi choice, per-option descriptions,
 * a markdown preview (single-select options carrying `preview`), a "type your
 * own" row and a per-question note. The FINAL step is the overall note —
 * folded into the envelope as 「全局备注」 when the answers are submitted.
 * Answers travel back via `pi:askUserAnswer` and the waiting tool call in the
 * main process resolves, letting the model continue.
 *
 * Drafts + the current step live in the askUser store (survive session
 * switching); ephemeral UI state (note editors open) is local.
 */
import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  HelpCircle,
  PencilLine,
  Send,
  StickyNote,
  X,
} from "lucide-react";
import {
  useAskUserStore,
  type AskUserCard,
  type AskUserQuestionDraft,
} from "../store/askUser-store";
import { useSessionStore } from "../store/session-store";
import Markdown from "./Markdown";
import styles from "./AskUserPanel.module.css";

export default function AskUserPanel() {
  const currentPath = useSessionStore((s) => s.currentPath);
  const cards = useAskUserStore((s) => s.cards);
  const upsert = useAskUserStore((s) => s.upsert);
  const remove = useAskUserStore((s) => s.remove);

  useEffect(() => {
    const offPrompt = window.piDesk.onAskUserPrompt((p) => upsert(p));
    const offClosed = window.piDesk.onAskUserClosed((c) => remove(c.id));
    return () => {
      offPrompt();
      offClosed();
    };
  }, [upsert, remove]);

  // Only the FOCUSED session's questionnaire renders here; parallel runs in
  // other sessions keep their cards in the store until answered/closed.
  const card = useMemo(() => {
    if (!currentPath) return undefined;
    return Object.values(cards).find((c) => c.payload.sessionPath === currentPath);
  }, [cards, currentPath]);

  if (!card) return null;
  return <QuestionnaireCard key={card.payload.id} card={card} />;
}

/** A question "has an answer" when a custom text is typed or an option picked. */
function hasAnswer(d?: AskUserQuestionDraft): boolean {
  if (!d) return false;
  if (d.customMode && d.customText.trim().length > 0) return true;
  return d.selected.length > 0;
}

function QuestionnaireCard({ card }: { card: AskUserCard }) {
  const { payload } = card;
  const count = payload.questions.length;
  // Wizard steps are Q0..Q(count-1) plus a final overall-note step (== count).
  const stepCount = count + 1;
  const [noteOpen, setNoteOpen] = useState(false);
  const setGlobalNote = useAskUserStore((s) => s.setGlobalNote);
  const setStep = useAskUserStore((s) => s.setStep);
  const submit = useAskUserStore((s) => s.submit);
  const cancel = useAskUserStore((s) => s.cancel);

  // Guard against a stale step; `count` = the overall-note step.
  const step = Math.min(Math.max(card.step, 0), count);
  const onNoteStep = step === count;
  const qi = onNoteStep ? count - 1 : step;

  const go = (next: number) => {
    setNoteOpen(false);
    setStep(payload.id, next);
  };

  const answered = useMemo(
    () =>
      payload.questions.reduce(
        (acc, _, i) => acc + (hasAnswer(card.drafts[i]) ? 1 : 0),
        0,
      ),
    [payload.questions, card.drafts],
  );

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <HelpCircle size={15} className={styles.headerIcon} />
        <span className={styles.headerTitle}>模型正在等待你的回答</span>
        {stepCount > 1 && (
          <div
            className={styles.stepDots}
            role="img"
            aria-label={
              onNoteStep
                ? `已作答 ${answered}/${count} 题，整体备注`
                : `${answered}/${count} 已作答`
            }
          >
            {Array.from({ length: stepCount }, (_, i) => (
              <span
                key={i}
                className={[
                  styles.stepDot,
                  i < step ? styles.stepDotDone : "",
                  i === step ? styles.stepDotCurrent : "",
                ].join(" ")}
              />
            ))}
          </div>
        )}
        <span className={styles.headerBadge}>
          {onNoteStep
            ? "整体备注"
            : count > 1
              ? `第 ${step + 1} / ${count} 题`
              : answered > 0
                ? "已作答"
                : "待作答"}
        </span>
        <button
          className={styles.closeBtn}
          title="取消作答，让模型自行决定（DECLINE）"
          onClick={() => void cancel(payload.id)}
          disabled={card.submitting}
        >
          <X size={14} />
        </button>
      </div>

      <div className={styles.body}>
        {onNoteStep ? (
          <div className={styles.noteStep}>
            <div className={styles.noteStepHeader}>
              <StickyNote size={14} className={styles.noteStepIcon} />
              <span className={styles.noteStepTitle}>整体备注</span>
              <span className={styles.optionalBadge}>可选</span>
            </div>
            <p className={styles.noteStepHint}>
              对整个问卷的补充说明。提交后会以「全局备注」附加在回答末尾发给模型，随答取消则不发送。
            </p>
            <textarea
              className={`${styles.noteArea} ${styles.globalNoteArea}`}
              value={card.globalNote}
              autoFocus
              rows={4}
              placeholder="例如：优先考虑成本更低的方案 / 回答里提到的目录都要存在…"
              onChange={(e) => setGlobalNote(payload.id, e.target.value)}
            />
          </div>
        ) : (
          <QuestionStep
            qi={qi}
            card={card}
            noteOpen={noteOpen}
            onToggleNote={() => setNoteOpen((v) => !v)}
          />
        )}
      </div>

      <div className={styles.footer}>
        <div className={styles.footerActions}>
          <button
            className={styles.btnCancel}
            onClick={() => void cancel(payload.id)}
            disabled={card.submitting}
          >
            取消
          </button>
          <div className={styles.footerRight}>
            {step > 0 && (
              <button
                className={styles.btnBack}
                onClick={() => void go(step - 1)}
                disabled={card.submitting}
              >
                上一步
              </button>
            )}
            {onNoteStep ? (
              <button
                className={styles.btnPrimary}
                onClick={() => void submit(payload.id)}
                disabled={card.submitting}
                title="提交全部回答给模型；全部未作答时等同放弃（DECLINE）"
              >
                <Send size={13} />
                {card.submitting ? "提交中…" : "提交回答"}
              </button>
            ) : (
              <button
                className={styles.btnPrimary}
                onClick={() => void go(step + 1)}
                disabled={card.submitting}
                title={
                  hasAnswer(card.drafts[qi])
                    ? step === count - 1
                      ? "进入整体备注（最后一步）"
                      : "进入下一题"
                    : step === count - 1
                      ? "未作答可跳过，进入整体备注"
                      : "未作答可跳过此题"
                }
              >
                下一步
                <ArrowRight size={13} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function QuestionStep({
  qi,
  card,
  noteOpen,
  onToggleNote,
}: {
  qi: number;
  card: AskUserCard;
  noteOpen: boolean;
  onToggleNote: () => void;
}) {
  const q = card.payload.questions[qi];
  const d = card.drafts[qi];
  const setDraft = useAskUserStore((s) => s.setDraft);
  const multi = q.multiSelect === true;

  const selectedPreview =
    !multi && !(d.customMode && d.customText.trim().length > 0) && d.selected.length === 1
      ? q.options[d.selected[0]]?.preview
      : undefined;

  const toggleOption = (i: number) => {
    if (multi) {
      const next = d.selected.includes(i)
        ? d.selected.filter((x) => x !== i)
        : [...d.selected, i];
      setDraft(card.payload.id, qi, { selected: next });
    } else {
      setDraft(card.payload.id, qi, {
        selected: d.selected[0] === i ? [] : [i],
        customMode: false,
      });
    }
  };

  return (
    <div className={styles.question}>
      <div className={styles.qHeader}>
        {q.header && <span className={styles.qChip}>{q.header}</span>}
        <span className={styles.qText}>{q.question}</span>
        <button
          className={`${styles.noteIconBtn} ${d.notes ? styles.noteIconBtnOn : ""}`}
          title={d.notes ? "编辑备注" : "添加备注"}
          onClick={onToggleNote}
        >
          <StickyNote size={13} />
        </button>
      </div>

      <div className={styles.optionList}>
        {q.options.map((o, i) => (
          <label
            key={i}
            className={styles.optionRow}
            data-checked={multi ? d.selected.includes(i) : d.selected[0] === i}
          >
            <input
              type={multi ? "checkbox" : "radio"}
              name={`askuser-q${card.payload.id}-${qi}`}
              checked={multi ? d.selected.includes(i) : d.selected[0] === i}
              disabled={d.customMode && d.customText.trim().length > 0}
              onChange={() => toggleOption(i)}
            />
            <span className={styles.optionText}>
              <span className={styles.optionLabel}>{o.label}</span>
              {o.description && (
                <span className={styles.optionDesc}>{o.description}</span>
              )}
            </span>
          </label>
        ))}
      </div>

      {selectedPreview && (
        <div className={styles.previewBox}>
          <div className={styles.previewLabel}>预览</div>
          <div className={styles.previewBody}>
            <Markdown content={selectedPreview} />
          </div>
        </div>
      )}

      {d.customMode ? (
        <textarea
          className={styles.customArea}
          value={d.customText}
          autoFocus
          placeholder="输入你自己的回答…（清空并勾选选项可切回选项）"
          rows={2}
          onChange={(e) =>
            setDraft(card.payload.id, qi, { customText: e.target.value })
          }
        />
      ) : (
        <button
          className={styles.customToggle}
          onClick={() =>
            setDraft(card.payload.id, qi, {
              customMode: true,
              selected: [],
            })
          }
        >
          <PencilLine size={12} />
          自定义回答…
        </button>
      )}

      {noteOpen && (
        <textarea
          className={styles.noteArea}
          value={d.notes}
          autoFocus
          placeholder="给这道题的备注（以「用户备注」随答案发给模型，不算作答）…"
          rows={2}
          onChange={(e) => setDraft(card.payload.id, qi, { notes: e.target.value })}
        />
      )}
    </div>
  );
}
