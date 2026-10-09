/**
 * Pi inline extension: registers the `ask_user_question` tool.
 *
 * Desktop port of `@juicesharp/rpiv-ask-user-question` v2.9.0 (MIT) — see
 * ask-user-core.ts for the shared schema/validation/envelope heritage. The
 * original renders its questionnaire in the Pi TUI (`ctx.ui.custom`) or walks
 * RPC host dialogs; pi-desktop is a headless Electron embed of the Pi SDK
 * (mode "print", no ctx.ui), so interaction instead goes over our own IPC:
 *
 *   model calls ask_user_question
 *     → execute validates + registers a pending questionnaire
 *     → webContents.send("pi:askUserPrompt", {id, sessionPath, questions})
 *     → await user answer (agent loop blocks — SDK-native semantics)
 *     → renderer: invoke("pi:askUserAnswer", …) → registry resolves
 *     → execute returns the envelope (answered / DECLINE) → model continues
 *
 * Termination safety: the execute waits on a promise resolved by (a) the user
 * answering/cancelling in the renderer, (b) the agent being aborted (stop
 * button / session teardown — ctx.signal), or (c) a 10-minute timeout so a
 * dead renderer can never hang the loop forever. In both non-answer paths the
 * renderer gets `pi:askUserClosed` so a stale card never lingers.
 *
 * Mounting mirrors todo: normal/workspace sessions only — scheduled-task
 * sessions never receive this factory (a cron run has nobody to answer).
 */
import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import {
  defineTool,
  type AgentToolResult,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type {
  AskUserAnswerPayload,
  AskUserPromptPayload,
  AskUserResult,
  AskUserParams,
} from "../../../shared/ask-user-types";
import { readAskUserConfigSync } from "./ask-user-config";
import {
  AskUserQuestionnaireSchema,
  buildAskUserEnvelope,
  buildAskUserToolResult,
  validateAskUserQuestionnaire,
} from "./ask-user-core";
import {
  clearAskUserForSession,
  hasActiveAskUser,
  registerAskUser,
} from "./ask-user-registry";

/** Longest an unanswered questionnaire blocks the agent before auto-decline
 *  (renderer dead / user walked away). Mirrors the bash-approval safety net. */
const ASK_USER_TIMEOUT_MS = 10 * 60 * 1000;

/** What waitForAnswer resolves with. `answeredByUser` distinguishes a real
 *  renderer answer from synthetic abort/timeout settles (not part of the
 *  renderer contract — added by the wait layer only). */
interface AnswerOutcome extends AskUserAnswerPayload {
  answeredByUser: boolean;
}

/**
 * Build the ask_user_question inline extension. Factory-style because execute
 * needs the live webContents to push the questionnaire to the renderer —
 * resolved at SEND time (the getter survives window rebuilds), same pattern as
 * createSubagentExtension.
 */
export function createAskUserExtension(
  getWebContents: () => WebContents | null,
): InlineExtension {
  const send = (channel: string, payload: unknown): boolean => {
    const wc = getWebContents();
    if (!wc || wc.isDestroyed()) return false;
    wc.send(channel, payload);
    return true;
  };

  return {
    name: "ask-user-question",
    hidden: false,
    factory: (pi) => {
      if (!readAskUserConfigSync().enabled) return; // master switch off

      pi.registerTool(
        defineTool({
          name: "ask_user_question",
          label: "询问用户",
          description:
            "Ask the user 1-4 structured questions during execution (each with 2-4 explained options; the user may also pick the 'custom answer' row to type freely, or cancel the whole set). " +
            "Use it to clarify ambiguous requirements, to let the user decide among approaches/preferences/directions, or to compare options — do not guess on the user's behalf. Notes:\n" +
            "- The user can always type freely via the auto-appended 'custom answer' row; do not write your own Other / Type something. labels (reserved words are rejected).\n" +
            "- Set multiSelect: true when several answers can hold at once; options may carry a markdown preview (prototype/code/config sample) so the user can compare real artifacts — preview is single-select only.\n" +
            "- If you recommend an option, put it first and append '(recommended)' to its label.\n" +
            "- Do not stack multiple calls — merge all clarifying questions into a single call.",
          promptSnippet:
            "Ask the user up to 4 structured questions (2-4 options each) when requirements are ambiguous",
          promptGuidelines: [
            "When the user's request is ambiguous or missing a necessary decision and you cannot proceed, ask via ask_user_question — at most 4 questions per call; ask everything at once, do not make multiple back-to-back calls.",
            "Each question must have 2-4 options; each option needs a one-line explanation of its meaning/cost. The user can also type their own answer via the auto-appended 'custom answer' row, or cancel the whole questionnaire. Do not author your own Other / Type something. labels — the runtime rejects reserved words.",
            "Set multiSelect: true when several answers can hold at once; options with a preview markdown (UI mockup/code snippet/config example) let the user compare real artifacts rather than labels — preview is single-select only. Put a recommended option first and append '(recommended)' to its label.",
          ],
          parameters: AskUserQuestionnaireSchema,
          execute: async (
            _toolCallId,
            params,
            _signal,
            _onUpdate,
            ctx,
          ): Promise<AgentToolResult<AskUserResult>> => {
            if (!readAskUserConfigSync().enabled) {
              return buildAskUserToolResult(
                "The ask_user_question tool is currently disabled (askuser-config.json enabled=false). Ask the user directly in chat text instead.",
                { answers: [], cancelled: true },
              );
            }

            const typed = params as unknown as AskUserParams;
            const validation = validateAskUserQuestionnaire(typed);
            if (!validation.ok) {
              return buildAskUserToolResult(validation.message, {
                answers: [],
                cancelled: true,
              });
            }

            // The renderer card queue is the only interaction surface.
            const sessionPath = ctx.sessionManager.getSessionFile() ?? "";
            if (!sessionPath) {
              return buildAskUserToolResult(
                "Could not determine the current session; cannot show the questionnaire. Ask the user directly in chat text instead.",
                { answers: [], cancelled: true },
              );
            }
            if (hasActiveAskUser(sessionPath)) {
              return buildAskUserToolResult(
                "This session already has a question waiting for the user. Wait for it to finish; do not ask again.",
                { answers: [], cancelled: true },
              );
            }

            const id = randomUUID();
            const prompt: AskUserPromptPayload = { id, sessionPath, questions: typed.questions };
            if (!send("pi:askUserPrompt", prompt)) {
              return buildAskUserToolResult(
                "The desktop UI is unavailable (window not ready); cannot show the questionnaire. Do not call this tool again — ask the user directly in chat text instead.",
                { answers: [], cancelled: true },
              );
            }

            // Block until the user answers — resolve on answer, abort, timeout.
            const outcome = await waitForAnswer(id, sessionPath, ctx.signal);
            if (!outcome.answeredByUser) {
              // Abort/timeout — the renderer never submitted; drop its card.
              send("pi:askUserClosed", { id });
            }

            const result: AskUserResult = {
              answers: outcome.answers ?? [],
              cancelled: outcome.cancelled,
              ...(outcome.globalNote && outcome.globalNote.length > 0
                ? { globalNote: outcome.globalNote }
                : {}),
            };

            return buildAskUserToolResult(buildAskUserEnvelope(result, typed), result);
          },
        }),
      );
    },
  };
}

/**
 * Register the questionnaire and block until the user answers. Resolves with a
 * synthetic cancelled outcome when the agent is aborted (ctx.signal) or after
 * ASK_USER_TIMEOUT_MS — both keep the loop from hanging forever.
 */
function waitForAnswer(
  id: string,
  sessionPath: string,
  signal: AbortSignal | undefined,
): Promise<AnswerOutcome> {
  return new Promise<AnswerOutcome>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const settle = (payload: AnswerOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(payload);
    };

    // Real renderer answer: the registry removes the entry in
    // tryAnswerAskUser BEFORE resolving, so no cleanup needed here beyond
    // marking the outcome as user-driven.
    registerAskUser({
      id,
      sessionPath,
      resolve: (payload) => settle({ ...payload, answeredByUser: true }),
    });

    const onAbort = () => {
      clearAskUserForSession(sessionPath); // nobody will answer now
      settle({ id, cancelled: true, answeredByUser: false });
    };

    timer = setTimeout(onAbort, ASK_USER_TIMEOUT_MS);

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
}
