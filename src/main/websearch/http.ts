/**
 * Shared HTTP plumbing for provider adapters.
 *
 * Two responsibilities that must not be duplicated per provider:
 *  - Timeout composition: an outer `signal` (user abort) and a per-call
 *    deadline must BOTH be honoured, and a user abort must never be mistaken
 *    for a retryable provider failure.
 *  - Error classification: HTTP status → `WebSearchError` kind, so the
 *    fallback chain can tell "try another provider" from "tell the user".
 */
import { WebSearchError, type SearchErrorKind } from "./types";

/** Combine an external abort signal with a timeout into one signal. */
export function withDeadline(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    // Use a distinct reason so callers can tell timeout from user abort.
    controller.abort(new DOMException("timeout", "TimeoutError"));
  }, timeoutMs);

  const onOuterAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onOuterAbort);
    },
  };
}

export function isUserAbort(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError") return false;
  return error.name === "AbortError";
}

function classifyStatus(status: number, provider: string, consoleUrl: string): WebSearchError {
  const suffix = consoleUrl ? ` 控制台：${consoleUrl}` : "";
  switch (status) {
    case 401:
    case 407:
      return new WebSearchError(
        "auth",
        false,
        `${provider} API key 无效或已失效，请在设置页更新。${suffix}`,
      );
    case 403:
      return new WebSearchError(
        "quota",
        false,
        `${provider} 拒绝访问：余额不足或套餐配额已用尽。${suffix}`,
      );
    case 402:
      return new WebSearchError(
        "quota",
        false,
        `${provider} 配额已耗尽。${suffix}`,
      );
    case 429:
      return new WebSearchError("rate_limit", true, `${provider} 触发限流，请稍后重试。`);
    default:
      if (status >= 500) {
        return new WebSearchError("network", true, `${provider} 服务端错误（HTTP ${status}）。`);
      }
      return new WebSearchError("bad_request", false, `${provider} 返回 HTTP ${status}。`);
  }
}

export interface RequestJsonOptions {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Provider label used in error messages. */
  provider: string;
  /** Console URL shown for credential/quota errors. */
  consoleUrl?: string;
  /**
   * Providers that return HTTP 200 with a business-level error payload must
   * inspect the parsed body themselves; this hook receives it.
   */
  inspect?: (data: any) => void;
}

/**
 * Perform a JSON request, mapping transport-level failures into
 * `WebSearchError`. A user-initiated abort is re-thrown untouched so the
 * fallback chain does not retry a cancelled call.
 */
export async function requestJson<T = any>(opts: RequestJsonOptions): Promise<T> {
  const { signal, cleanup } = withDeadline(opts.signal, opts.timeoutMs);
  const init: RequestInit = {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers: {
      Accept: "application/json",
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...opts.headers,
    },
    signal,
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

  let response: Response;
  try {
    response = await fetch(opts.url, init);
  } catch (error: unknown) {
    cleanup();
    if (isUserAbort(error)) throw error;
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new WebSearchError(
        "timeout",
        true,
        `${opts.provider} 请求超时（${opts.timeoutMs}ms）。`,
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new WebSearchError("network", true, `${opts.provider} 网络请求失败：${detail}`);
  } finally {
    cleanup();
  }

  if (!response.ok) {
    throw classifyStatus(response.status, opts.provider, opts.consoleUrl ?? "");
  }

  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new WebSearchError(
      "network",
      true,
      `${opts.provider} 返回了非 JSON 响应（HTTP ${response.status}）。`,
    );
  }

  // Business-level failures often ride on HTTP 200 (verified: 博查 returns
  // 200 + {"code":"403","message":"You do not have enough money..."}).
  opts.inspect?.(data);
  return data as T;
}

/** Helper adapters use for the "HTTP 200 but business error" case. */
export function businessError(
  kind: SearchErrorKind,
  retryable: boolean,
  message: string,
): WebSearchError {
  return new WebSearchError(kind, retryable, message);
}
