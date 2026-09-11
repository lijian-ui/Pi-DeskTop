/**
 * SSRF guard for model-supplied URLs.
 *
 * Threat model: fetched page content is untrusted input. A page can instruct
 * the model to `web_fetch` an internal address (cloud metadata at
 * 169.254.169.254, a LAN admin panel, localhost services), turning the agent
 * into a probe inside the user's network.
 *
 * Two defenses, both required:
 *  1. Resolve the hostname FIRST and reject if every/any address is non-public.
 *     Validating only the literal URL is not enough — a public hostname can
 *     resolve to 127.0.0.1.
 *  2. Re-validate on EVERY redirect hop. Auto-following redirects would let a
 *     public URL 302-bounce into the private range after the first check.
 *
 * Disabled only for hosts the user explicitly allow-listed (local dev servers),
 * never globally.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class UrlBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlBlockedError";
  }
}

function isBlockedIp(ip: string): boolean {
  // Node's isIP returns 4, 6 or 0. We only inspect literals; hostnames are
  // resolved by the caller before reaching here.
  if (isIP(ip) === 4) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8 "this network"
    if (a === 10) return true; // RFC1918 private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 private
    if (a === 192 && b === 168) return true; // RFC1918 private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast + reserved + broadcast
    return false;
  }
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (v === "::" || v === "::1") return true; // unspecified / loopback
    if (v.startsWith("fe80")) return true; // link-local
    if (/^f[cd]/.test(v)) return true; // unique local fc00::/7
    if (v.startsWith("ff")) return true; // multicast
    // IPv4-mapped (::ffff:127.0.0.1) must be judged by the embedded v4.
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
    return false;
  }
  // Unparseable → fail closed.
  return true;
}

export interface UrlSafetyOptions {
  /** Master switch from config. When false, only the scheme check applies. */
  enabled: boolean;
  /** Hosts exempt from the address checks, e.g. ["localhost", "127.0.0.1"]. */
  allowlist: string[];
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    throw new UrlBlockedError(`无效的 URL：${url}`);
  }
}

function isAllowlisted(hostname: string, allowlist: string[]): boolean {
  return allowlist.some((h) => {
    const entry = h.trim().toLowerCase();
    if (!entry) return false;
    // Exact match, or a single-level suffix match (".local" style domains).
    return hostname === entry || hostname.endsWith(`.${entry}`);
  });
}

/**
 * Validate a URL before any request is issued.
 *
 * @throws UrlBlockedError when the URL targets a disallowed address.
 */
export async function assertUrlSafe(
  rawUrl: string,
  opts: UrlSafetyOptions,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UrlBlockedError(`无效的 URL：${rawUrl}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UrlBlockedError(
      `不支持的协议 ${parsed.protocol.replace(":", "")}，仅允许 http / https`,
    );
  }

  const hostname = hostOf(rawUrl);
  if (!hostname) throw new UrlBlockedError(`URL 缺少主机名：${rawUrl}`);

  if (!opts.enabled) return;
  if (isAllowlisted(hostname, opts.allowlist)) return;

  // Literal IPs bypass DNS but still need checking.
  if (isIP(hostname) !== 0) {
    if (isBlockedIp(hostname)) {
      throw new UrlBlockedError(
        `URL 指向非公网地址（${hostname}），已阻止该请求。` +
          `如需访问，请在设置中把该主机加入内网白名单。`,
      );
    }
    return;
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new UrlBlockedError(`无法解析主机名：${hostname}`);
  }

  if (addresses.length === 0) {
    throw new UrlBlockedError(`无法解析主机名：${hostname}`);
  }

  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw new UrlBlockedError(
        `URL 指向非公网地址（${hostname} → ${address}），已阻止该请求。` +
          `如需访问，请在设置中把该主机加入内网白名单。`,
      );
    }
  }
}

export interface SafeFetchResult {
  response: Response;
  finalUrl: string;
}

/**
 * Fetch with manual redirect following, re-validating every hop.
 *
 * Mirrors CowAgent's `_safe_get` but in Node idiom: auto-redirect is disabled
 * and each `Location` target is re-resolved and re-checked, so a public URL
 * cannot bounce into the private range after passing the first check.
 */
export async function safeFetch(
  rawUrl: string,
  opts: UrlSafetyOptions,
  init: RequestInit = {},
  maxRedirects = 5,
): Promise<SafeFetchResult> {
  let current = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertUrlSafe(current, opts);

    const response = await fetch(current, {
      ...init,
      redirect: "manual",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/json,text/markdown;q=0.9,*/*;q=0.8",
        ...(init.headers as Record<string, string> | undefined),
      },
    });

    if (response.status < 300 || response.status > 399) {
      return { response, finalUrl: current };
    }

    const location = response.headers.get("location");
    if (!location) return { response, finalUrl: current };

    // Drain the redirect body so the socket can be reused.
    await response.arrayBuffer().catch(() => undefined);

    try {
      current = new URL(location, current).toString();
    } catch {
      throw new UrlBlockedError(`重定向目标无效：${location}`);
    }
  }

  throw new UrlBlockedError(`重定向次数过多（>${maxRedirects}）`);
}
