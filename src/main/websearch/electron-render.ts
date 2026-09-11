/**
 * Headless browser fetch for JS-rendered pages (SPA: 今日头条 / 公众号壳 / Vue / React).
 *
 * pi-desktop bundles Chromium via Electron, so we reuse it instead of pulling in
 * Puppeteer/Playwright (~150MB download). Each call opens a throwaway hidden
 * BrowserWindow, serializes through a queue (Chromium is heavy — one page at a
 * time avoids OOM), waits for the framework to mount, then reads the rendered DOM
 * text.
 *
 * Security: the SSRF guard from ./url-safety is re-applied to the initial URL and
 * to every in-page redirect (only http/https targets are allowed to load). The
 * window runs with nodeIntegration off, contextIsolation on, sandbox on, and pops
 * no new windows. The AutomationControlled blink feature is disabled to reduce
 * headless fingerprinting (今日头条 etc. probe for it).
 */
import { app, BrowserWindow } from "electron";
import { WebSearchError, type FetchedPage } from "./types";
import { assertUrlSafe } from "./url-safety";

const REAL_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Below this length a fetched body is treated as an SPA shell (no real text). */
export const SPA_FALLBACK_MIN = 200;

// Disable the headless-automation flag once. Safe to call many times.
let blinkPatched = false;
function patchBlinkFlag(): void {
  if (blinkPatched) return;
  blinkPatched = true;
  try {
    app.commandLine.appendSwitch("disable-blink-features", "AutomationControlled");
  } catch {
    /* app may be shutting down */
  }
}

function safeUrl(u: string): URL | null {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

/**
 * DOM text extractor, executed inside the page. Pure JS (no TS syntax) because it
 * is passed to webContents.executeJavaScript as a string. Prefers the common
 * article containers, falls back to the full body innerText.
 */
const READ_DOM = `
(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el || !el.innerText) return "";
    return el.innerText.trim();
  };
  const text =
    pick("#js_content") ||
    pick("article") ||
    pick(".article-content") ||
    pick(".article") ||
    pick("main") ||
    (document.body ? document.body.innerText : "");
  return {
    text: text.replace(/\\s+/g, "\\n").replace(/\\n{3,}/g, "\\n\\n").trim(),
    title: document.title || "",
  };
})()
`;

/** Poll until the body yields meaningful text or we time out. */
function waitForContent(win: BrowserWindow, budgetMs: number): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = async (): Promise<void> => {
      let len = 0;
      try {
      len = (await win.webContents.executeJavaScript(
        "document.body ? document.body.innerText.length : 0",
      )) as number;
      } catch {
        /* context may be torn down */
      }
      if (len > SPA_FALLBACK_MIN) return resolve();
      if (Date.now() - start > budgetMs) return resolve();
      setTimeout(() => void tick(), 400);
    };
    setTimeout(() => void tick(), 400);
  });
}

interface RenderResult {
  text: string;
  title: string;
}

/** One headless render of `url`. Always opens + destroys its own window. */
function renderOnce(url: string, timeoutMs: number): Promise<RenderResult> {
  return new Promise<RenderResult>((resolve, reject) => {
    patchBlinkFlag();
    let win: BrowserWindow;
    try {
      win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
    } catch (err) {
      reject(
        new WebSearchError("network", true, `无法创建渲染窗口：${String((err as Error)?.message ?? err)}`),
      );
      return;
    }

    win.webContents.setUserAgent(REAL_UA);
    // Never let a page spawn a new window (SSRF / phishing escape hatch).
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        win.destroy();
      } catch {
        /* ignore */
      }
      action();
    };

    const timer = setTimeout(
      () => finish(() => reject(new WebSearchError("timeout", true, `浏览器渲染超时（${timeoutMs}ms）。`))),
      timeoutMs,
    );

    win.webContents.once("did-fail-load", (_ev, errorCode, errorDescription) =>
      finish(() =>
        reject(new WebSearchError("network", true, `浏览器加载失败（${errorCode} ${errorDescription}）。`)),
      ),
    );

    win.webContents.on("will-redirect", (ev, target) => {
      const p = safeUrl(target);
      if (!p || (p.protocol !== "http:" && p.protocol !== "https:")) {
        ev.preventDefault();
        finish(() => reject(new WebSearchError("bad_request", false, "渲染过程重定向到不安全地址，已阻止。")));
      }
    });

    win.webContents.once("did-finish-load", () => {
      waitForContent(win, Math.max(2000, timeoutMs - 5000))
        .then(() => win.webContents.executeJavaScript(READ_DOM) as Promise<RenderResult>)
        .then((result) => finish(() => resolve(result)))
        .catch((err) =>
          finish(() =>
            reject(
              err instanceof WebSearchError
                ? err
                : new WebSearchError("network", true, `渲染读取失败：${String((err as Error)?.message ?? err)}`),
            ),
          ),
        );
    });

    win.loadURL(url, { userAgent: REAL_UA }).catch((err) =>
      finish(() => reject(new WebSearchError("network", true, `加载 URL 失败：${String((err as Error)?.message ?? err)}`))),
    );
  });
}

// Serial queue: one heavy render at a time across the whole process.
let chain: Promise<unknown> = Promise.resolve();

/**
 * Fetch a JS-rendered page via headless Chromium. SSRF-checked up front; any
 * in-page redirect to a non-http(s) target aborts. Throws WebSearchError when the
 * page yields no real text (login wall, anti-bot, or timeout).
 */
export async function fetchElectron(
  url: string,
  opts: { ssrfEnabled: boolean; allowlist: string[] },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<FetchedPage> {
  await assertUrlSafe(url, { enabled: opts.ssrfEnabled, allowlist: opts.allowlist });

  const run = (): Promise<RenderResult> => {
    if (signal?.aborted) throw new DOMException("用户已取消", "AbortError");
    return renderOnce(url, timeoutMs);
  };

  // Enqueue on the serial chain; swallow a prior task's rejection so the chain
  // keeps flowing, but let THIS run's rejection propagate to the caller.
  chain = chain.catch(() => undefined).then(() => run());
  const result = (await chain) as RenderResult;

  if (!result.text || result.text.length < SPA_FALLBACK_MIN) {
    throw new WebSearchError("bad_request", false, "浏览器渲染后仍未提取到正文（可能是登录墙或反爬）。");
  }

  return {
    url,
    finalUrl: url,
    title: result.title || undefined,
    text: result.text,
    backend: "electron",
    truncated: false,
  };
}
