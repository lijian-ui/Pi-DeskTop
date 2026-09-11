import { getMessageText } from "../types";

/**
 * Best-effort current session id from an extension ctx, for episodic linking.
 * Never throws — returns null when unavailable (e.g. unpersisted session).
 */
export function safeSessionId(ctx: { sessionManager?: { getSessionId?: () => string } } | unknown): string | null {
  try {
    const mgr = (ctx as { sessionManager?: { getSessionId?: () => string } }).sessionManager;
    const id = mgr?.getSessionId?.();
    return typeof id === "string" && id.trim() ? id : null;
  } catch {
    return null;
  }
}

export function applyRecentMessageLimit(parts: string[], recentMessages = 0): string[] {
  if (Number.isFinite(recentMessages) && recentMessages > 0) {
    return parts.slice(-recentMessages);
  }
  return parts;
}

export function collectMessageParts(entries: unknown[], recentMessages = 0): string[] {
  const parts: string[] = [];

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    if ((entry as { type?: unknown }).type !== "message") continue;

    const msg = (entry as { message?: unknown }).message;
    const text = getMessageText(msg);
    if (!text) continue;

    const role = (msg as { role?: unknown } | null)?.role;
    const prefix = role === "user" ? "[USER]" : "[ASSISTANT]";
    parts.push(`${prefix}: ${text}`);
  }

  return applyRecentMessageLimit(parts, recentMessages);
}
