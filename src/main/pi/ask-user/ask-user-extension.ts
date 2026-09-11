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
            "在执行过程中向用户提出 1-4 个结构化问题（每题 2-4 个带说明的选项，用户可另选『自定义回答』自由输入，也可整体取消）。" +
            "需要澄清含糊需求、让用户在多个方案/偏好/方向中做决定、或提供选项对比时使用——不要替用户猜测。用法注意：\n" +
            "- 用户能通过自动追加的『自定义回答』行自由输入；不要自行编写 Other / Type something. 等标签（会被拒绝）。\n" +
            "- 多选可同时成立时设 multiSelect: true；选项可带 markdown preview（原型/代码/配置示例）供用户对比真实产物——preview 仅用于单选。\n" +
            "- 若你推荐某一项，把它放第一位并在标签末尾加『(推荐)』。\n" +
            "- 不要连续堆叠多次调用——把所有澄清问题合并到一次调用。",
          promptSnippet:
            "Ask the user up to 4 structured questions (2-4 options each) when requirements are ambiguous",
          promptGuidelines: [
            "用户的请求含糊、缺少必要决策而无法继续时，用 ask_user_question 提问——一次最多 4 问，把该问的一次问完，不要背靠背多次调用。",
            "每题必须 2-4 个选项；每个选项要有一句话说明其含义/代价。用户还能通过自动追加的『自定义回答』行输入自己的答案，或取消整个问卷。不要自行编写 Other / Type something. 标签——运行时保留词会被拒绝。",
            "多个答案同时成立时设 multiSelect: true；选项带 preview markdown（界面原型/代码片段/配置示例）能让用户对比真实产物而非标签——preview 仅单选时使用。推荐项放第一位并在 label 后加『(推荐)』。",
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
                "ask_user_question 工具当前未启用（askuser-config.json enabled=false）。请直接以聊天文本向用户提问。",
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
                "无法确定当前会话，无法弹出问卷。请改用聊天文本直接向用户提问。",
                { answers: [], cancelled: true },
              );
            }
            if (hasActiveAskUser(sessionPath)) {
              return buildAskUserToolResult(
                "该会话已有问题在等待用户回答。请等待其完成，不要重复发起询问。",
                { answers: [], cancelled: true },
              );
            }

            const id = randomUUID();
            const prompt: AskUserPromptPayload = { id, sessionPath, questions: typed.questions };
            if (!send("pi:askUserPrompt", prompt)) {
              return buildAskUserToolResult(
                "桌面界面不可用（窗口未就绪），无法弹出问卷。请不要再次调用此工具，改用聊天文本直接向用户提问。",
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
