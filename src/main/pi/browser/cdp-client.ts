/**
 * Managed CDP transport — 主进程**直连**托管 Chrome（OpenClaw 同款机制）。
 *
 * 为什么不用扩展桥：MV3 扩展的 Service Worker 有「长轮询永不 idle → Chrome 不热重载旧 SW」
 * 的顽疾，导致桥 `connected:false`、token 缓存、崩溃恢复等一系列偶发故障。而 CDP
 * （Chrome DevTools Protocol）是 Chrome 原生调试协议，playwright-core 的
 * `connectOverCDP` 直接连上我们启动的 Chrome（带 `--remote-debugging-port`），
 * 截图 / 点击 / 填表 / 快照 / 执行 JS 全是原生能力，**不需要在浏览器里装任何扩展**。
 *
 * 接口与旧 `bridge.send(action, params)` 完全对齐（命名空间 `page.*` / `tab.*`），
 * 因此 browser-tool.ts 上层 dispatch 几乎不动——只是把 `bridge.send` 换成 `cdp.send`。
 *
 * 快照形状沿用同一份页面脚本：resources/browser/snapshot-page.js 作为 init script
 * 注入每个页面，元素 uid 的反查 map（`window.__PI_BROWSER_STATE__.elements[uid]`）不变，
 * 模型侧无需任何改动。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type APIResponse, type Browser, type BrowserContext, type ElementHandle, type Page } from "playwright-core";
import { browserResourceDir } from "./paths";

/** 探活判定"被重定向到登录页"的 URL 特征。 */
const LOGIN_URL_RE =
  /login|signin|sign-in|passport|oauth|sso|cas|auth|account\/|token|redirect.*login|login.htm/i;

/** 连接已断开/目标丢失时的错误特征（需触发重连）。 */
const STALE_RE = /Connection closed|Target closed|Session closed|WebSocket|not connected|has been closed|ERR_CONNECTION/i;

/** 懒加载页面脚本（资源目录 asarUnpack 后必然存在）。 */
let snapshotScript: string | undefined;
function getSnapshotScript(): string {
  if (snapshotScript === undefined) {
    snapshotScript = readFileSync(join(browserResourceDir(), "snapshot-page.js"), "utf8");
  }
  return snapshotScript;
}

export class ManagedCdp {
  private browser?: Browser;
  private readonly instrumented = new WeakSet<BrowserContext>();
  private readonly pageIds = new WeakMap<Page, string>();
  private nextPageId = 0;

  constructor(private readonly cdpUrl: string) {}

  get connected(): boolean {
    return Boolean(this.browser?.isConnected());
  }

  /** CDP 调试端点 URL（供 status / window 诊断展示）。 */
  get url(): string {
    return this.cdpUrl;
  }

  status(): { url: string; mode: "cdp"; connected: boolean } {
    return { url: this.cdpUrl, mode: "cdp", connected: this.connected };
  }

  /** 连接（或重连）到托管 Chrome。幂等：已连且存活则直接返回。 */
  async connect(): Promise<void> {
    if (this.browser?.isConnected()) return;
    this.browser = undefined;
    this.browser = await chromium.connectOverCDP(this.cdpUrl);
  }

  /** 主动断开（Chrome 重启前调用，避免拿到一个死连接）。 */
  disconnect(): void {
    try {
      this.browser?.close().catch(() => {});
    } catch {
      // best-effort
    }
    this.browser = undefined;
    // WeakSet<BrowserContext> 无法 clear；旧 contexts 随 browser 丢弃被 GC，无需显式清理。
  }

  // ---------------------------------------------------------------------------
  // 统一 send 出口（命名空间 action，与旧桥一致）
  // ---------------------------------------------------------------------------

  async send(action: string, params: Record<string, unknown>): Promise<unknown> {
    const dot = action.indexOf(".");
    const ns = dot >= 0 ? action.slice(0, dot) : action;
    const name = dot >= 0 ? action.slice(dot + 1) : "";
    const targetId = typeof params.targetId === "string" ? params.targetId : undefined;

    if (ns === "tab") return this.tabAction(name, params);
    if (ns !== "page") throw new Error(`未知 action 命名空间: ${action}（仅支持 page.* / tab.*）`);

    // 页面类动作：取页面 → 执行 → 任一连接错误触发一次重连重试。
    const run = async (): Promise<unknown> => {
      const { ctx, page } = await this.acquire(targetId);
      switch (name) {
        case "snapshot":
          return this.doSnapshot(page, params);
        case "screenshot":
          return this.doScreenshot(page, params);
        case "navigate":
          return this.doNavigate(page, params);
        case "click":
          return this.doClick(ctx, page, params);
        case "type":
          return this.doType(page, params);
        case "fill":
          return this.doFill(page, params);
        case "key":
          return this.doKey(page, params);
        case "hover":
          return this.doHover(page, params);
        case "scroll":
          return this.doScroll(page, params);
        case "evaluate":
          return this.doEvaluate(page, params);
        case "drag":
          return this.doDrag(page, params);
        case "upload":
          return this.doUpload(page, params);
        default:
          throw new Error(`未知 page action: ${name}`);
      }
    };

    try {
      return await run();
    } catch (error) {
      if (STALE_RE.test(String((error as Error).message))) {
        this.disconnect();
        await this.connect();
        const { page } = await this.acquire(targetId);
        // 重连后页面对象已变，若动作依赖 uid 句柄则需重新取；这里对无状态动作重试。
        // 依赖 uid 的动作（click/type/fill/hover/drag/upload）在重试时也重新解析，安全。
        return runAfterReconnect(name, page, params);
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // 页面动作
  // ---------------------------------------------------------------------------

  private async doSnapshot(page: Page, params: Record<string, unknown>): Promise<unknown> {
    const snapshot = (await page.evaluate(
      (args) =>
        (globalThis as unknown as { __piBrowserSnapshotPage?: (...a: unknown[]) => unknown })
          .__piBrowserSnapshotPage?.(...args),
      [
        params.maxElements ?? 80,
        params.containingText ?? null,
        params.roleFilter ?? null,
        params.mode ?? "auto",
        params.query ?? null,
        params.delta === true,
      ] as unknown[],
    )) as unknown;
    if (!snapshot) throw new Error("快照失败：页面尚未注入快照脚本（请先 navigate）。");
    return snapshot;
  }

  private async doScreenshot(page: Page, params: Record<string, unknown>): Promise<unknown> {
    const format = params.format === "jpeg" ? "jpeg" : "png";
    const quality = typeof params.quality === "number" ? params.quality : 80;
    const buffer = await page.screenshot({
      type: format,
      ...(format === "jpeg" ? { quality } : {}),
      fullPage: false,
    });
    const dataUrl = `data:image/${format};base64,${buffer.toString("base64")}`;
    return { dataUrl, tab: { url: page.url(), title: await page.title() } };
  }

  private async doNavigate(page: Page, params: Record<string, unknown>): Promise<unknown> {
    const url = params.url;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      throw new Error("navigate 需要合法的 http(s) url。");
    }
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    // goto 触发新文档 → init script 已重置快照 map；导航后稍等首屏脚本。
    return { tab: { url: page.url(), title: await page.title() } };
  }

  private async doClick(
    _ctx: BrowserContext,
    page: Page,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const handle = await this.handleForUid(page, params);
    await handle.click({ timeout: 30_000 });
    return { ok: true };
  }

  private async doType(page: Page, params: Record<string, unknown>): Promise<unknown> {
    const text = typeof params.text === "string" ? params.text : "";
    const handle = await this.handleForUid(page, params);
    await handle.focus();
    await handle.type(text, { delay: params.perCharacter === true ? 30 : 0 });
    if (params.pressEnter === true) await page.keyboard.press("Enter");
    return { ok: true };
  }

  private async doFill(page: Page, params: Record<string, unknown>): Promise<unknown> {
    const text = typeof params.text === "string" ? params.text : "";
    const handle = await this.handleForUid(page, params);
    await handle.fill(text);
    if (params.submit === true) await handle.press("Enter");
    return { ok: true };
  }

  private async doKey(page: Page, params: Record<string, unknown>): Promise<unknown> {
    const key = typeof params.key === "string" ? params.key : "";
    const modifiers = this.modifiers(params);
    for (const m of modifiers) await page.keyboard.down(m);
    try {
      await page.keyboard.press(key);
    } finally {
      for (let i = modifiers.length - 1; i >= 0; i--) await page.keyboard.up(modifiers[i]);
    }
    return { ok: true };
  }

  private async doHover(page: Page, params: Record<string, unknown>): Promise<unknown> {
    const handle = await this.handleForUid(page, params);
    await handle.hover();
    return { ok: true };
  }

  private async doScroll(page: Page, params: Record<string, unknown>): Promise<unknown> {
    const deltaX = typeof params.deltaX === "number" ? params.deltaX : 0;
    const deltaY = typeof params.deltaY === "number" ? params.deltaY : 0;
    await page.mouse.wheel(deltaX, deltaY);
    return { ok: true };
  }

  private async doEvaluate(page: Page, params: Record<string, unknown>): Promise<unknown> {
    const expression = typeof params.expression === "string" ? params.expression : "undefined";
    // playwright 的 page.evaluate(expression:string) 走 CDP，不受页面 CSP 限制。
    return await page.evaluate(expression);
  }

  private async doDrag(page: Page, params: Record<string, unknown>): Promise<unknown> {
    const from = await this.pointFor(page, params, "fromUid", "fromX", "fromY");
    const to = await this.pointFor(page, params, "toUid", "toX", "toY");
    const steps = typeof params.steps === "number" ? params.steps : 12;
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    }
    await page.mouse.up();
    return { ok: true };
  }

  private async doUpload(page: Page, params: Record<string, unknown>): Promise<unknown> {
    const paths = Array.isArray(params.paths) ? (params.paths as string[]) : [];
    if (paths.length === 0) throw new Error("upload 需要 paths 数组。");
    const handle = await this.handleForUid(page, params);
    await handle.setInputFiles(paths);
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // tab 动作
  // ---------------------------------------------------------------------------

  /** 导出指定 url 作用域的完整 cookie（含 HttpOnly），拼成 `k=v; k2=v2` 请求头格式，同名去重保留第一个。 */
  private async doGetCookie(params: Record<string, unknown>): Promise<unknown> {
    const url = typeof params.url === "string" ? params.url : "";
    if (!/^https?:\/\//i.test(url)) throw new Error("get_cookie 需要合法的 http(s) url。");
    const ctx = await this.context();
    const cookies = await ctx.cookies(url);
    const seen = new Set<string>();
    const parts: string[] = [];
    const entries: Array<{
      name: string;
      value: string;
      httpOnly: boolean;
      domain: string;
      path: string;
      secure: boolean;
    }> = [];
    for (const c of cookies) {
      if (!seen.has(c.name)) {
        seen.add(c.name);
        parts.push(`${c.name}=${c.value}`);
      }
      entries.push({
        name: c.name,
        value: c.value,
        httpOnly: c.httpOnly,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
      });
    }

    // 会话探活：cookie 为空 → 必然未登录；否则按 probe 开关决定是否做一次无副作用 GET。
    const result: Record<string, unknown> = {
      cookie: parts.join("; "),
      count: cookies.length,
      url,
      entries,
      valid: "unknown",
      probed: false,
    };
    if (cookies.length === 0) {
      result.valid = "no";
      result.reason = "no_cookies";
      result.note = "该站点没有可用 cookie：可能从未登录，或登录态已丢失（session/profile 被清理）。需要 show 弹窗重新登录。";
    } else if (params.probe !== false) {
      result.probed = true;
      Object.assign(result, await this.probeValidity(ctx, url));
    } else {
      result.valid = "unknown";
      result.note = "未做探活（probe=false）：以受保护接口的 401/302 为准判断会话是否失效。";
    }
    return result;
  }

  /**
   * 无副作用探活：用当前 context 的登录态对该站点做一次 GET，判断会话是否仍有效。
   * `context.request` 复用浏览器上下文的 cookie 存储；只强判明确信号（401/403、重定向到登录页），
   * 其余保守返回 unknown，避免误报。所有异常吞掉，**不影响 cookie 导出本身**。
   */
  private async probeValidity(
    ctx: BrowserContext,
    url: string,
  ): Promise<{ valid: "yes" | "no" | "unknown"; reason?: string; note?: string }> {
    let resp: APIResponse;
    try {
      resp = await ctx.request.get(url, { timeout: 15_000, maxRedirects: 5 });
    } catch (error) {
      return { valid: "unknown", note: `探活失败（不影响导出）：${(error as Error).message}` };
    }
    const status = resp.status();
    if (status >= 200 && status < 300) return { valid: "yes" };
    if (status === 401 || status === 403) return { valid: "no", reason: `http_${status}`, note: "服务端返回 401/403，会话已失效，需重新登录。" };
    if (status >= 300 && status < 400) {
      const loc = (resp.headers()["location"] ?? "").toLowerCase();
      if (LOGIN_URL_RE.test(loc)) {
        return { valid: "no", reason: "redirect_login", note: `被重定向到登录页：${loc}，会话已失效，需重新登录。` };
      }
      return { valid: "yes", note: `重定向到非登录地址：${loc}` };
    }
    return {
      valid: "unknown",
      reason: `http_${status}`,
      note: "非鉴权类状态码，无法据此判定会话；以受保护接口的 401 为准。",
    };
  }

  private async tabAction(name: string, _params: Record<string, unknown>): Promise<unknown> {
    if (name === "version") return { name: "managed-cdp", connected: this.connected };
    if (name === "get_cookie") return this.doGetCookie(_params);
    if (name === "list") {
      const ctx = await this.context();
      const pages = ctx.pages();
      const tabs = await Promise.all(
        pages.map(async (p) => ({ id: this.pageId(p), url: p.url(), title: await p.title() })),
      );
      return tabs;
    }
    throw new Error(`未知 tab action: ${name}`);
  }

  // ---------------------------------------------------------------------------
  // 内部工具
  // ---------------------------------------------------------------------------

  private modifiers(params: Record<string, unknown>): Array<"Control" | "Alt" | "Shift" | "Meta"> {
    const out: Array<"Control" | "Alt" | "Shift" | "Meta"> = [];
    if (params.ctrlKey === true) out.push("Control");
    if (params.altKey === true) out.push("Alt");
    if (params.shiftKey === true) out.push("Shift");
    if (params.metaKey === true) out.push("Meta");
    return out;
  }

  /** 按 uid（来自最近快照）或 CSS selector 解析元素句柄。 */
  private async handleForUid(page: Page, params: Record<string, unknown>): Promise<ElementHandle> {
    const uid = typeof params.uid === "string" ? params.uid : undefined;
    const selector = typeof params.selector === "string" ? params.selector : undefined;
    if (uid) {
      const handle = await page.evaluateHandle(
        (u) => (globalThis as unknown as { __PI_BROWSER_STATE__?: { elements?: Record<string, unknown> } })
          .__PI_BROWSER_STATE__?.elements?.[u] ?? null,
        uid,
      );
      const el = handle.asElement();
      if (el) return el;
      throw new Error(`uid 已失效（可能是页面已跳转）。请重新 browser({action:"snapshot"}) 取新 uid。`);
    }
    if (selector) {
      const el = await page.locator(selector).first().elementHandle();
      if (el) return el;
      throw new Error(`selector 未找到元素：${selector}`);
    }
    throw new Error("需要 uid 或 selector 来定位元素。");
  }

  /** 拖拽的起止点：优先 uid 元素中心，否则用坐标。 */
  private async pointFor(
    page: Page,
    params: Record<string, unknown>,
    uidKey: string,
    xKey: string,
    yKey: string,
  ): Promise<{ x: number; y: number }> {
    const uid = typeof params[uidKey] === "string" ? (params[uidKey] as string) : undefined;
    if (uid) {
      const handle = await this.handleForUid(page, { uid });
      const box = await handle.boundingBox();
      if (!box) throw new Error(`uid 元素不可见（无尺寸），无法拖拽：${uid}`);
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    const x = typeof params[xKey] === "number" ? (params[xKey] as number) : 0;
    const y = typeof params[yKey] === "number" ? (params[yKey] as number) : 0;
    return { x, y };
  }

  private async context(): Promise<BrowserContext> {
    await this.connect();
    const browser = this.browser!;
    const existing = browser.contexts();
    const ctx = existing[0] ?? (await browser.newContext());
    if (!this.instrumented.has(ctx)) {
      try {
        await ctx.addInitScript(getSnapshotScript());
        this.instrumented.add(ctx);
      } catch {
        // 已注入则忽略
      }
    }
    return ctx;
  }

  private async acquire(targetId?: string): Promise<{ ctx: BrowserContext; page: Page }> {
    const ctx = await this.context();
    const page = await this.resolvePage(ctx, targetId);
    return { ctx, page };
  }

  private async resolvePage(ctx: BrowserContext, targetId?: string): Promise<Page> {
    const pages = ctx.pages();
    if (targetId) {
      const byId = pages.find((p) => this.pageId(p) === targetId);
      if (byId) return byId;
      for (const p of pages) {
        if (p.url().includes(targetId) || (await p.title()).includes(targetId)) return p;
      }
    }
    const nonBlank = pages.find((p) => p.url() && p.url() !== "about:blank");
    if (nonBlank) return nonBlank;
    if (pages[0]) return pages[0];
    return ctx.newPage();
  }

  private pageId(page: Page): string {
    let id = this.pageIds.get(page);
    if (!id) {
      id = `tab-${this.nextPageId++}`;
      this.pageIds.set(page, id);
    }
    return id;
  }
}

/**
 * 重连后的重试：重连拿到的页面对象是新实例，需重新 acquire。
 * 这里对"无 uid 依赖"的动作（snapshot/screenshot/navigate/scroll/key/evaluate/tab）直接重试；
 * uid 依赖动作在 run() 内已按 uid 重新解析，安全。
 */
async function runAfterReconnect(
  name: string,
  page: Page,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "snapshot":
      return (await page.evaluate(
        (args) =>
          (globalThis as unknown as { __piBrowserSnapshotPage?: (...a: unknown[]) => unknown })
            .__piBrowserSnapshotPage?.(...args),
        [
          params.maxElements ?? 80,
          params.containingText ?? null,
          params.roleFilter ?? null,
          params.mode ?? "auto",
          params.query ?? null,
          params.delta === true,
        ] as unknown[],
      )) as unknown;
    case "screenshot": {
      const format = params.format === "jpeg" ? "jpeg" : "png";
      const buffer = await page.screenshot({ type: format });
      return { dataUrl: `data:image/${format};base64,${buffer.toString("base64")}`, tab: { url: page.url(), title: await page.title() } };
    }
    case "navigate": {
      const url = params.url as string;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      return { tab: { url: page.url(), title: await page.title() } };
    }
    case "scroll":
      await page.mouse.wheel(params.deltaX ? (params.deltaX as number) : 0, params.deltaY ? (params.deltaY as number) : 0);
      return { ok: true };
    case "key": {
      const key = params.key as string;
      if (params.ctrlKey) await page.keyboard.down("Control");
      if (params.altKey) await page.keyboard.down("Alt");
      if (params.shiftKey) await page.keyboard.down("Shift");
      if (params.metaKey) await page.keyboard.down("Meta");
      await page.keyboard.press(key);
      if (params.metaKey) await page.keyboard.up("Meta");
      if (params.shiftKey) await page.keyboard.up("Shift");
      if (params.altKey) await page.keyboard.up("Alt");
      if (params.ctrlKey) await page.keyboard.up("Control");
      return { ok: true };
    }
    case "evaluate":
      return await page.evaluate((params.expression as string) ?? "undefined");
    default:
      // click/type/fill/hover/drag/upload：依赖 uid 句柄，重连后需重新解析，
      // 直接重跑 handleForUid 即可（acquire 已返回新 page）。
      throw new Error("连接中断后该动作需重试：请重新 browser({action:\"snapshot\"}) 后再次操作。");
  }
}
