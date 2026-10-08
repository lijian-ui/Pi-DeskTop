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

/**
 * 元素点击的等待上限。过去硬编码 30s：元素已消失时模型要干等 30 秒才拿到超时，
 * 白白浪费一轮。5s 足够覆盖正常的渲染/动画延迟。
 */
const CLICK_TIMEOUT_MS = 5_000;

/**
 * 动作后的「观察窗」：等 URL 变化或新网络请求出现即提前结束，否则最多等这么久。
 * 目的是给 click/fill/type 一个廉价的后验信号——过去 click 只回 ok:true，页面
 * 毫无反应也报成功，模型只能靠额外调用去自证「它没坏」。
 */
const SETTLE_BUDGET_MS = 600;

/** waitFor 的默认超时（模型没显式给 timeout 时）。 */
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;

/**
 * 动作前采样的目标元素：句柄 + 写值类动作的控件状态指纹。
 * watchState=false 的动作（如 click）只借它判断元素是否还在 DOM 里。
 */
interface TargetProbe {
  handle: ElementHandle;
  /** 是否把「控件状态变化」计入 valueChanged —— 仅 fill/type 这类写值动作。 */
  watchState?: boolean;
  /** 动作前的状态指纹（watchState 时必填）。 */
  before?: string;
}

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
  /**
   * 「当前标签页」粘性。未指定 targetId 时所有 page.* 动作都复用它，保证
   * snapshot / screenshot / click 永远作用于同一个 tab——过去每次调用都各自
   * 重新解析（回退到「第一个非 blank 页」），多标签页时会操作到错误页面，
   * 现象就是「DOM 是当前页、截图却是前一天那张」。
   */
  private pinned?: Page;
  /** 每个 page 的请求计数（用于判断动作是否真的触发了网络）。 */
  private readonly requestCounts = new WeakMap<Page, number>();
  /** 已挂上 request 监听的 page（避免重复挂载）。 */
  private readonly observed = new WeakSet<Page>();

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
    this.pinned = undefined;
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
      const { page } = await this.acquire(targetId);
      switch (name) {
        case "snapshot":
          return this.doSnapshot(page, params);
        case "screenshot":
          return this.doScreenshot(page, params);
        case "navigate":
          return this.doNavigate(page, params);
        case "click":
          return this.doClick(page, params);
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
        params.excludeOccluded === true,
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
    // 导航是最明确的「这就是当前 tab」信号：粘住它，后续 page.* 默认都作用于它。
    this.pinned = page;
    // goto 触发新文档 → init script 已重置快照 map；导航后可选等待目标 URL/selector。
    const waited = await applyWaitFor(page, params);
    const result: Record<string, unknown> = { ok: true, tab: { url: page.url(), title: await page.title() } };
    if (waited) result.waitFor = waited;
    return result;
  }

  /**
   * 动作后的收尾：跑观察窗 → 应用可选 waitFor → 组装后验结果。
   * click / type / fill / press_key 共用，保证「动作是否真的生效」有统一、廉价的判断依据。
   */
  private async afterAction(
    page: Page,
    before: { url: string; requests: number },
    params: Record<string, unknown>,
    probes: TargetProbe[] = [],
  ): Promise<Record<string, unknown>> {
    await this.settle(page, before.url, before.requests);
    const waited = await applyWaitFor(page, params);
    return this.postAction(page, before, probes, waited);
  }

  /**
   * 观察窗：URL 变化或出现新网络请求即提前结束，否则最多等 budget。
   * 页面中途被关闭/导航时直接结束（动作本身已经发出，不该被观察失败掩盖）。
   */
  private async settle(
    page: Page,
    beforeUrl: string,
    beforeReq: number,
    budget = SETTLE_BUDGET_MS,
  ): Promise<void> {
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
      try {
        if (page.url() !== beforeUrl) return;
        if ((this.requestCounts.get(page) ?? 0) > beforeReq) return;
        await page.waitForTimeout(50);
      } catch {
        return;
      }
    }
  }

  /**
   * 一次往返读出元素的「存活 + 控件状态指纹」。
   * 表单填充类动作（fill/type）的预期效果是控件值/勾选/选中项变化，而不是
   * URL 变化或发新请求——只看后者会把一次成功的密码填充误报成 effective:false，
   * 反而诱导模型重试或换定位方式。句柄失效（元素已移除）返回 undefined。
   */
  private async probeTarget(
    handle: ElementHandle,
  ): Promise<{ connected: boolean; state: string } | undefined> {
    try {
      // 主进程 tsconfig 不含 DOM lib，不能引用 HTMLInputElement 等类型 —— 用结构化断言。
      return await handle.evaluate((el) => {
        const node = el as unknown as {
          isConnected?: boolean;
          tagName?: string;
          type?: string;
          value?: unknown;
          checked?: boolean;
          selectedIndex?: number;
          textContent?: string | null;
        };
        const tag = (node.tagName ?? "").toLowerCase();
        const type = (node.type ?? "").toLowerCase();
        let state: string;
        if (type === "checkbox" || type === "radio") {
          state = `checked:${node.checked === true}`;
        } else if (tag === "select") {
          state = `selectedIndex:${node.selectedIndex ?? -1}`;
        } else if ("value" in node) {
          state = `value:${String(node.value ?? "")}`;
        } else {
          state = `text:${node.textContent ?? ""}`;
        }
        return { connected: node.isConnected !== false, state };
      });
    } catch {
      return undefined; // 句柄失效通常意味着元素已被移除
    }
  }

  /**
   * 组装动作后验结果：url 是否变、是否产生新请求、目标元素是否已脱离 DOM、控件值是否变。
   * effective 只要任一项成立即为真——写值类动作靠 valueChanged 兜底，避免「填成功了却报没生效」。
   */
  private async postAction(
    page: Page,
    before: { url: string; requests: number },
    probes: TargetProbe[] = [],
    waited?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const url = page.url();
    const newRequests = (this.requestCounts.get(page) ?? 0) - before.requests;
    const navigated = url !== before.url;
    // 只有在「URL 没变且没有新请求」时才回查元素 —— 省掉导航/请求场景下的多余往返。
    const settled =
      probes.length > 0 && !navigated && newRequests === 0
        ? await Promise.all(probes.map((p) => this.probeTarget(p.handle)))
        : undefined;
    let elementDetached: boolean | undefined;
    let stateChanges = 0;
    if (settled) {
      elementDetached = settled.some((r) => r === undefined || r.connected === false);
      stateChanges = probes.filter(
        (p, i) => p.watchState === true && p.before !== undefined && settled[i]?.state !== p.before,
      ).length;
    }
    const watchingState = probes.some((p) => p.watchState === true);
    const valueChanged = stateChanges > 0;
    const effective = navigated || newRequests > 0 || elementDetached === true || valueChanged;
    const result: Record<string, unknown> = { ok: true, url, navigated, newRequests, effective };
    if (elementDetached !== undefined) result.elementDetached = elementDetached;
    if (watchingState) {
      result.valueChanged = valueChanged;
      if (probes.length > 1) result.fieldsChanged = stateChanges;
    }
    if (waited) result.waitFor = waited;
    if (!effective) {
      result.note =
        "动作已执行，但未观察到任何变化（URL 未变、无新请求、控件值未变、目标元素仍在原位）。" +
        "若这一步本应有反应，请用 browser({action:\"snapshot\", delta:true}) 确认，" +
        "或换其它定位方式/动作，不要盲目重复同一个动作。";
    }
    return result;
  }

  private async doClick(page: Page, params: Record<string, unknown>): Promise<unknown> {
    const handle = await this.handleForUid(page, params);
    const before = { url: page.url(), requests: this.requestCounts.get(page) ?? 0 };
    await handle.click({ timeout: CLICK_TIMEOUT_MS });
    return await this.afterAction(page, before, params, [{ handle }]);
  }

  private async doType(page: Page, params: Record<string, unknown>): Promise<unknown> {
    const text = typeof params.text === "string" ? params.text : "";
    const handle = await this.handleForUid(page, params);
    const before = { url: page.url(), requests: this.requestCounts.get(page) ?? 0 };
    // type 是写值动作：记下填充前的控件状态，后验时对比 value/checked/selectedIndex。
    const probe: TargetProbe = { handle, watchState: true, before: (await this.probeTarget(handle))?.state };
    await handle.focus();
    await handle.type(text, { delay: params.perCharacter === true ? 30 : 0 });
    if (params.pressEnter === true) await page.keyboard.press("Enter");
    return await this.afterAction(page, before, params, [probe]);
  }

  private async doFill(page: Page, params: Record<string, unknown>): Promise<unknown> {
    const before = { url: page.url(), requests: this.requestCounts.get(page) ?? 0 };
    // 批量填表：一次调用写多个字段（fields: [{uid|selector, text}]），
    // 省掉「每个字段一次 fill」的往返——登录这类多字段表单能少 3 次调用。
    const fields = Array.isArray(params.fields) ? (params.fields as Array<Record<string, unknown>>) : null;
    if (fields && fields.length > 0) {
      const probes: TargetProbe[] = [];
      for (const field of fields) {
        const text = typeof field.text === "string" ? field.text : "";
        const handle = await this.handleForUid(page, field);
        probes.push({ handle, watchState: true, before: (await this.probeTarget(handle))?.state });
        await handle.fill(text);
      }
      if (params.submit === true) await page.keyboard.press("Enter");
      const result = await this.afterAction(page, before, params, probes);
      result.filled = fields.length;
      return result;
    }
    const text = typeof params.text === "string" ? params.text : "";
    const handle = await this.handleForUid(page, params);
    const probe: TargetProbe = { handle, watchState: true, before: (await this.probeTarget(handle))?.state };
    await handle.fill(text);
    if (params.submit === true) await handle.press("Enter");
    return await this.afterAction(page, before, params, [probe]);
  }

  private async doKey(page: Page, params: Record<string, unknown>): Promise<unknown> {
    const key = typeof params.key === "string" ? params.key : "";
    const before = { url: page.url(), requests: this.requestCounts.get(page) ?? 0 };
    const modifiers = this.modifiers(params);
    for (const m of modifiers) await page.keyboard.down(m);
    try {
      await page.keyboard.press(key);
    } finally {
      for (let i = modifiers.length - 1; i >= 0; i--) await page.keyboard.up(modifiers[i]);
    }
    // 按键常常是「提交」动作（Enter 提交表单）：同样给 navigated/newRequests 后验信号，
    // 与 click/fill 保持一致，省掉模型额外一次 evaluate 去确认页面有没有跳。
    return await this.afterAction(page, before, params);
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
      return this.describeTabs(ctx);
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
    this.observe(page);
    return { ctx, page };
  }

  /** 给 page 挂一次 request 监听，累计请求数——动作后验（是否真的发起了网络请求）依赖它。 */
  private observe(page: Page): void {
    if (this.observed.has(page)) return;
    this.observed.add(page);
    this.requestCounts.set(page, 0);
    page.on("request", () => {
      this.requestCounts.set(page, (this.requestCounts.get(page) ?? 0) + 1);
    });
  }

  /** 列出当前所有标签页（id/url/title），用于歧义报错与 tab.list。 */
  private async describeTabs(ctx: BrowserContext): Promise<Array<{ id: string; url: string; title: string }>> {
    return Promise.all(
      ctx.pages().map(async (p) => ({
        id: this.pageId(p),
        url: p.url(),
        title: await p.title().catch(() => ""),
      })),
    );
  }

  /**
   * 解析目标页（P0-2）：
   *  - 显式 targetId：按 id → url/title 子串匹配；命中即「粘住」；无命中 → 报错并列出标签页。
   *  - 未指定：优先复用上次粘住的页（同一 tab 内连续操作）；否则仅有一张非 blank 页时选它；
   *    多张非 blank 页且无从判断 → 明确报错，要求先用 tabs 取 targetId。
   *    过去这里回退到「第一个非 blank 页」，多标签页时会 snapshot 看 A、screenshot 拍 B。
   */
  private async resolvePage(ctx: BrowserContext, targetId?: string): Promise<Page> {
    const pages = ctx.pages();
    if (targetId) {
      const byId = pages.find((p) => this.pageId(p) === targetId);
      let matched = byId;
      if (!matched) {
        for (const p of pages) {
          if (p.url().includes(targetId) || (await p.title().catch(() => "")).includes(targetId)) {
            matched = p;
            break;
          }
        }
      }
      if (!matched) {
        const tabs = await this.describeTabs(ctx);
        throw new Error(
          `targetId "${targetId}" 未匹配到任何标签页。当前标签页：${JSON.stringify(tabs)}。` +
          '请用 browser({action:"tabs"}) 取正确的 targetId。',
        );
      }
      this.pinned = matched;
      return matched;
    }

    // 未指定 targetId：复用上次粘住的页（仍存活时）。
    if (this.pinned) {
      let alive = false;
      try {
        alive = !this.pinned.isClosed();
      } catch {
        alive = false;
      }
      if (alive) return this.pinned;
      this.pinned = undefined;
    }

    const nonBlank = pages.filter((p) => p.url() && p.url() !== "about:blank");
    if (nonBlank.length === 1) {
      this.pinned = nonBlank[0];
      return nonBlank[0];
    }
    if (nonBlank.length === 0) {
      const page = pages[0] ?? (await ctx.newPage());
      this.pinned = page;
      return page;
    }
    // 多张非 blank 页：拒绝猜测。
    const tabs = await this.describeTabs(ctx);
    throw new Error(
      `存在 ${nonBlank.length} 个非空白标签页，无法确定操作目标。当前标签页：${JSON.stringify(tabs)}。` +
      '请先 browser({action:"tabs"}) 查看，并在后续动作里带上 targetId。',
    );
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
 * 可选等待原语：动作后等到 URL 命中正则、或 selector 出现为止。
 * 让「点一下 → 等结果」收敛成一次调用，模型不用自己写 evaluate 轮询。
 * 返回 undefined = 未请求等待；否则回 { matched, timeout, url, title }。
 */
async function applyWaitFor(
  page: Page,
  params: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const raw = params.waitFor;
  if (!raw || typeof raw !== "object") return undefined;
  const wf = raw as { url?: unknown; selector?: unknown; timeout?: unknown };
  let urlRe: RegExp | null = null;
  if (typeof wf.url === "string" && wf.url) {
    try {
      urlRe = new RegExp(wf.url);
    } catch {
      throw new Error(`waitFor.url 不是合法正则：${wf.url}`);
    }
  }
  const selector = typeof wf.selector === "string" && wf.selector ? wf.selector : null;
  if (!urlRe && !selector) return undefined;
  const timeout = typeof wf.timeout === "number" && wf.timeout > 0 ? wf.timeout : DEFAULT_WAIT_TIMEOUT_MS;
  const deadline = Date.now() + timeout;
  let matched = false;
  for (;;) {
    if (urlRe?.test(page.url())) {
      matched = true;
      break;
    }
    if (selector && (await page.$(selector))) {
      matched = true;
      break;
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(100);
  }
  return { matched, timeout, url: page.url(), title: await page.title().catch(() => "") };
}

/**
 * 重连后的重试：重连拿到的页面对象是新实例，需重新 acquire。
 * 这里对"无 uid 依赖"的动作（snapshot/screenshot/navigate/scroll/key/evaluate）直接重试；
 * 依赖 uid 句柄的写操作（click/type/fill/hover/drag/upload）**不自动重试**——
 * 首次可能已部分生效，重跑会重复执行，交由模型重新 snapshot 后再操作。
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
          params.excludeOccluded === true,
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
      const waited = await applyWaitFor(page, params);
      const result: Record<string, unknown> = { ok: true, tab: { url: page.url(), title: await page.title() } };
      if (waited) result.waitFor = waited;
      return result;
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
