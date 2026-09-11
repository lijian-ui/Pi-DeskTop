/**
 * ask_user_question — pending registry.
 *
 * The tool's `execute` must BLOCK until the user answers in the renderer. This
 * module is the bridge between the waiting `execute` (main process) and the
 * renderer's answer which arrives via the `pi:askUserAnswer` IPC handler:
 *
 *   execute ── registerAskUser ──▶ await promise
 *   renderer ─▶ ipcMain "pi:askUserAnswer" ─▶ tryAnswerAskUser ─▶ resolve
 *
 * Keyed by SESSION PATH (one pending questionnaire per session at a time —
 * models never fire a second ask_user_question before the first resolves, but
 * concurrent cwds/sessions may each have one waiting). Only the focused
 * session's questionnaire is shown in the renderer.
 *
 * No module-level timer here: abort/timeout handling lives in the extension
 * (it owns the abort signal and the webContents it must notify).
 */
import type { AskUserAnswerPayload } from "../../../shared/ask-user-types";

export interface PendingAskUser {
  id: string;
  sessionPath: string;
  resolve: (payload: AskUserAnswerPayload) => void;
}

const pendingBySession = new Map<string, PendingAskUser>();

/** True when the given session already has a questionnaire waiting for input. */
export function hasActiveAskUser(sessionPath: string): boolean {
  return pendingBySession.has(sessionPath);
}

/**
 * Register a waiting questionnaire. Same-session duplicates are impossible via
 * the hasActiveAskUser guard in execute, but belt-and-braces: a stale entry
 * (e.g. an execute that never settled) is resolved as cancelled first so the
 * new one can never be shadowed by a leaked promise.
 */
export function registerAskUser(p: PendingAskUser): void {
  const prev = pendingBySession.get(p.sessionPath);
  if (prev) prev.resolve({ id: prev.id, cancelled: true });
  pendingBySession.set(p.sessionPath, p);
}

/**
 * Resolve the questionnaire with the given id (called from the IPC handler).
 * Returns false when the id is unknown (already settled / timed out / aborted)
 * so the renderer knows the card was a ghost.
 */
export function tryAnswerAskUser(id: string, payload: AskUserAnswerPayload): boolean {
  for (const [sessionPath, p] of pendingBySession) {
    if (p.id === id) {
      pendingBySession.delete(sessionPath);
      p.resolve(payload);
      return true;
    }
  }
  return false;
}

/** Drop the entry for a session WITHOUT resolving (session torn down). */
export function clearAskUserForSession(sessionPath: string): void {
  pendingBySession.delete(sessionPath);
}

/** Number of questionnaires currently awaiting user input (all sessions). */
export function activeAskUserCount(): number {
  return pendingBySession.size;
}
