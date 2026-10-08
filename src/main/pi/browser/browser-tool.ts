/**
 * Browser tool — 第一方 InlineExtension，注册单个 `browser` 工具。
 *
 * 与 todo / web-search 同机制：常驻 app（非可安装包），元数据走
 * promptSnippet / promptGuidelines（**不用** before_agent_start 改写系统提示词，
 * 那会破 prompt-cache）。
 *
 * 设计：对外只暴露 **1 个 `browser` 工具**，用 `action` 参数区分操作
 * （status / tabs / snapshot / screenshot / navigate / click / type / fill /
 * press_key / hover / scroll / evaluate / drag / upload / get_cookie / window），对标
 * OpenClaw 的单一 `browser` 工具。内核 `send(action, params)` 薄壳把请求交给 `ManagedCdp`：
 * 浏览器由 pi-desktop **自己启动**（独立 profile、默认不可见），用 CDP 直连操作 ——
 * **不需要在浏览器里安装任何扩展**。
 *
 * 用户唯一需要动手的地方：撞到业务系统的验证码 / 扫码登录页时，系统自动弹出可见窗口，
 * 由用户自己登录，登录完继续干活。凭据永不交给模型。
 * 登录态存在独立 profile 里，下次不用重登。
 *
 * 两个实例（对应 session-manager 的两个 extensionFactories 数组）：
 *  - `browserTool`           → 普通/空间会话
 *  - `browserToolUnattended` → 定时任务会话（需 allowUnattended）
 *
 * ⚠️ 文件名里的 "extension" 指 **Pi 自己的插件机制**（InlineExtension），与浏览器扩展无关。
 * 本工具已彻底不依赖任何浏览器扩展（2026-09-22 移除 existing 驱动与其回环桥）。
 */
import { Type } from "typebox";
import {
  defineTool,
  getAgentDir,
  type AgentToolResult,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { readBrowserConfigSync, type BrowserConfig } from "./browser-config";
import { ManagedCdp } from "./cdp-client";
import { assertBrowserAuthorized, authSummary } from "./auth";
import { assertActionAllowed, effectiveBackground } from "./background-policy";
import { assertUrlAllowed } from "./policy";
import { assertActionGuarded, guardSummary } from "./browser-guard";
import { appendBrowserAudit, browserAuditFile, summarizeParams } from "./browser-audit";
import { ensureManagedChrome, managedChromeInfo } from "./managed-chrome";
import { managedProfileDir } from "./paths";
import { formatBrowserSnapshot, type BrowserSnapshot } from "./snapshot-format";

/** 托管 Chrome 的 CDP 传输单例（按端口缓存；managed 模式主进程直连，无需扩展）。 */
function getManagedCdp(cfg: BrowserConfig): ManagedCdp {
  const holder = globalThis as unknown as { __piDeskManagedCdp?: ManagedCdp };
  const url = `http://127.0.0.1:${cfg.managed.cdpPort || 17319}`;
  if (!holder.__piDeskManagedCdp) holder.__piDeskManagedCdp = new ManagedCdp(url);
  return holder.__piDeskManagedCdp;
}

/** 连接/重连托管 Chrome 的 CDP（Chrome 冷启动可能稍慢，重试若干次）。返回是否成功。 */
async function connectManagedCdp(cfg: BrowserConfig): Promise<boolean> {
  const cdp = getManagedCdp(cfg);
  for (let i = 0; i < 12; i++) {
    try {
      await cdp.connect();
      return true;
    } catch {
      await sleep(800);
    }
  }
  return false;
}

type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image"; data: string; mimeType: string };
type ContentBlock = TextBlock | ImageBlock;

export interface BrowserToolOptions {
  /** 服务无人值守（定时任务）会话：授权改走配置常驻授权（需 allowUnattended）。 */
  unattended?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 确保托管 Chrome 已就绪，并连接 CDP（playwright-core 直连）。
 * 已运行且模式一致时立即返回（不等待）；新启动/模式切换后等 CDP 可达（连接幂等、可重试）。
 */
async function ensureBrowserReady(cfg: BrowserConfig): Promise<void> {
  // **运行时模式优先**：实例已在跑时保持它当前的模式（例如用户刚用 browser window
  // 切到可见窗口登录），不要按配置把它又切回无头，否则登录窗口会中途消失。
  const current = managedChromeInfo();
  const desiredHeadless =
    current.running && current.headless !== undefined ? current.headless : cfg.managed.headless;
  await ensureManagedChrome(desiredHeadless, cfg);
  // 新启动或模式切换后，等 CDP 就绪（连接本身幂等、失败可重试）。
  const ok = await connectManagedCdp(cfg);
  if (!ok) console.warn("[browser] 托管 Chrome 已启动，但 CDP 暂时未连上；命令会重试连接。");
}

/** 运行时模式优先：实例已在跑就用它的实际模式，否则用配置默认。 */
function effectiveHeadless(cfg: BrowserConfig): boolean {
  const runtime = managedChromeInfo().headless;
  return runtime !== undefined && managedChromeInfo().running ? runtime : cfg.managed.headless;
}

// ---------------------------------------------------------------------------
// 「最近访问的页面」记忆
//
// 存在的理由：切换可见性（headless ↔ headed）**必然重启浏览器**，页面随之丢失。
// show 时若不带 url，用户看到的就只有一张空白页（体验上等于"弹出个新标签页"）。
// 记住最近一次 http(s) 页面后，show 可以自动把它恢复出来。
// 存 globalThis：同一进程内所有会话共享。
// ---------------------------------------------------------------------------

function rememberLastUrl(url: unknown): void {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return; // 忽略 about:blank / chrome:// 等
  (globalThis as unknown as { __piDeskBrowserLastUrl?: string }).__piDeskBrowserLastUrl = url;
}

/** 最近一次访问过的 http(s) 页面 URL。 */
function lastVisitedUrl(): string | undefined {
  return (globalThis as unknown as { __piDeskBrowserLastUrl?: string }).__piDeskBrowserLastUrl;
}

/** 从任意工具返回里尽力提取页面 URL 并记忆（`{url}` 或 `{tab:{url}}` 两种形态）。 */
function rememberFromResult(result: unknown): void {
  if (!result || typeof result !== "object") return;
  const r = result as { url?: unknown; tab?: { url?: unknown } };
  rememberLastUrl(r.tab?.url ?? r.url);
}

/**
 * 是否"看起来需要登录"。命中任一信号即认为是登录页：
 *  - URL 里有 login / sso / oauth / auth / passport / challenge 等
 *  - 标题含「登录 / 身份认证 / sign in」等
 *  - 表单里有 password 字段
 *  - 页面文本里出现「扫码登录 / 二维码 / 短信验证码」等
 */
function looksLikeLogin(input: { url?: string; title?: string; snapshot?: BrowserSnapshot }): boolean {
  const url = input.url ?? input.snapshot?.url ?? "";
  const title = input.title ?? input.snapshot?.title ?? "";
  if (/(login|signin|sign-in|sso|oauth2?|passport|challenge|\/auth|authenticate)/i.test(url)) return true;
  if (/登录|登陆|身份认证|统一登录|sign\s?in|log\s?in|authenticate/i.test(title)) return true;
  const fields = input.snapshot?.forms?.fields ?? [];
  if (fields.some((field) => String(field.role ?? "").toLowerCase() === "password")) return true;
  const text = (input.snapshot?.textSnippets ?? []).map((snippet) => snippet.text).join(" ");
  return /扫码登录|二维码|手机号登录|短信验证码|请登录|未登录/.test(text);
}

/**
 * 是否是**需要人工介入**的登录页（扫码/验证码/短信等无法靠账号密码自动填的场景）。
 * 与 looksLikeLogin 的区别：looksLikeLogin 覆盖所有登录形态（含纯用户名密码登录），
 * 本函数只识别"自动填不了"的情况 —— 工具据此决定是否自动弹窗。
 *
 * 信号优先级：URL 关键词（challenge/captcha/sms/qrcode）> 标题关键词 > 页面文本关键词。
 */
function isCaptchaLoginPage(input: { url?: string; title?: string; snapshot?: BrowserSnapshot }): boolean {
  const url = input.url ?? input.snapshot?.url ?? "";
  const title = input.title ?? input.snapshot?.title ?? "";
  // URL 里带 challenge / captcha / sms / qrcode 等暗示有验证码或扫码
  if (/(challenge|captcha|sms|qrcode|qr-?code|wechat|alipay|dingtalk|lark|飞书|钉钉|二维码)/i.test(url)) return true;
  // 标题里有扫码 / 验证码 / 短信
  if (/扫码|验证码|短信|二维码|飞书|微信|钉钉/.test(title)) return true;
  // snapshot 文本里有（doNavigate 时 snapshot 为 undefined，snapshot 调用时才会命中）
  const text = (input.snapshot?.textSnippets ?? []).map((snippet) => snippet.text).join(" ");
  if (/扫码登录|二维码|短信验证码|微信登录|钉钉登录|飞书登录|验证码/.test(text)) return true;
  return false;
}

/**
 * 登录页追加的强指令。分三种情况引导模型：
 *   ① 用户已在对话里给了账号密码 → 自动填（密码框 value=[已掩码] 是正常的安全遮蔽）。
 *   ② 密码错/出验证码/扫码 → 弹窗让用户介入。
 *   ③ 用户还没给凭据 → 弹窗让用户手动登。
 * 工具本身拿不到对话历史，所以把条件判断写进返回值让模型自己结合上下文走分支。
 */
const LOGIN_HINT =
  '\n\n⚠️ 这是一个**登录页**。请按以下顺序处理：\n' +
  '① 如果你从对话历史里已经拿到了用户明确提供的账号和密码 → 先调 browser({action:"snapshot"}) 定位表单字段（密码框会显示 value=[已掩码]，这是安全遮蔽、正常现象），' +
  '然后用 browser({action:"fill", uid:<密码框uid>, text:<密码>}) 填写。**注意：密码框 value=[已掩码] 是设计行为，填完不会回显密码，也不要在对话里复述密码**。' +
  '提交后再 snapshot 判断是否登录成功（URL 变了 / 登录框消失 / 出现业务页面元素）。\n' +
  '② 如果仍有登录错误提示（如"账号密码错误"）、或出现验证码/扫码/短信验证 → 立即调 browser({action:"window", windowAction:"show"}) 弹窗让用户手动介入。\n' +
  '③ 如果你还没拿到凭据 → 直接调 browser({action:"window", windowAction:"show"}) 弹窗让用户扫码/验证码登录。' +
  '用户确认登录完成后调 browser({action:"window", windowAction:"hide"}) 切回后台，再 browser({action:"navigate"}) 到目标页继续干活。';

/** 登录页 + 窗口**已可见**时的提示：不要再让模型调 show（重复切换会重启浏览器、页面丢失）。 */
const LOGIN_HINT_VISIBLE =
  '\n\n⚠️ 这是一个**登录页**，且托管浏览器窗口**当前已可见**（无需再调 browser window show）。\n' +
  '① 如果用户已在对话里给了账号密码 → 可以直接在这个可见窗口里 fill 填写；密码框 value=[已掩码] 是正常安全遮蔽，填完不会回显，也不要在对话里复述密码。\n' +
  '② 如果仍有错误提示或出验证码 → 告知用户就在该窗口手动完成登录。\n' +
  '③ 如果还没拿到凭据 → 也告知用户在该窗口手动登录。\n' +
  '用户确认登录完成后调 browser({action:"window", windowAction:"hide"}) 切回后台。';

/**
 * 命中登录页时追加强指令。
 * @param visible 托管窗口当前是否已可见（已可见则不应再让模型 show）
 */
function withLoginHint(
  text: string,
  input: { url?: string; title?: string; snapshot?: BrowserSnapshot },
  visible = false,
): string {
  if (!looksLikeLogin(input)) return text;
  return text + (visible ? LOGIN_HINT_VISIBLE : LOGIN_HINT);
}

/** 把任意结果序列化为文本块（undefined 特殊处理）。 */
function asText(result: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: result === undefined ? "undefined" : JSON.stringify(result) }],
    details: { result },
  };
}

// 托管桥概念已移除（CDP 直连）；window 状态分支直接取 getManagedCdp(cfg)。

/**
 * 快照是否显示「页面毫无变化」——delta 优先，其次旧的粗粒度 diff。
 * 命中即认为模型刚做的动作没有生效，用于死循环判定。
 */
function snapshotUnchanged(snapshot: BrowserSnapshot): boolean {
  const delta = snapshot?.delta;
  if (delta && !delta.firstSnapshot && !delta.incomparable) return delta.substantive === false;
  const diff = snapshot?.diff;
  if (diff && !diff.firstSnapshot) return diff.changed === false;
  return false;
}

/** 连续「无变化快照」达此数量 → 追加警告式停止指令。 */
const SNAPSHOT_STALL_WARN = 3;
/** 连续「无变化快照」达此数量 → 标记为错误结果并强制结束本轮（死循环）。 */
const SNAPSHOT_STALL_STOP = 5;

/**
 * 只读动作集合：不改页面、无副作用，无人值守下可由 `allowUnattendedRead` 单独放行。
 * 刻意**不含** get_cookie（导出登录凭据）与 evaluate（可在页面跑任意 JS）。
 */
const READ_ONLY_ACTIONS = new Set<string>(["tab.list", "page.snapshot", "page.screenshot"]);

export function createBrowserTool(options: BrowserToolOptions = {}): InlineExtension {
  const unattended = options.unattended === true;

  return {
    name: "browser",
    factory: (pi) => {
      const bootCfg = readBrowserConfigSync();
      if (!bootCfg.enabled) return; // 总开关关 → 不注册工具
      // **预热托管 Chrome**（后台、不阻塞、幂等）：Chrome 冷启动需要数秒，
      // 这里只 spawn 进程并连接 CDP，真正调用时通常已就绪。
      void ensureManagedChrome(bootCfg.managed.headless, bootCfg)
        .then(async () => {
          await connectManagedCdp(bootCfg);
          console.log("[browser] 托管 Chrome 预热完成（CDP 已连接）");
        })
        .catch((error) => console.warn("[browser] 托管 Chrome 预热失败：", (error as Error).message));

      // 连续「无变化快照」计数（本会话内）。任何**会改变页面**的动作都会把它清零，
      // 因此只有「模型反复 snapshot 而页面纹丝不动」才会累积 → 判定死循环。
      let stalledSnapshots = 0;
      // 死循环被强制终止后待补发的可见说明（terminate 之后模型已无法再发言）。
      let loopNotice: number | undefined;
      pi.on("agent_end", () => {
        if (loopNotice === undefined) return;
        const count = loopNotice;
        loopNotice = undefined;
        // 与宿主层兜底用同一个 customType，渲染层无需区分来源。
        pi.sendMessage({
          customType: "loop-guard",
          display: true,
          content:
            "⛔ 模型遇到问题，任务已被终止。\n\n" +
            `原因：连续 ${count} 次快照页面**毫无变化**，说明它在重复一个无效动作（死循环），系统已强制结束本轮。\n\n` +
            "建议：把目标拆得更具体，或直接告诉它你期望的下一步，然后重新发起。",
        });
      });

      /**
       * send() 的「检查 + 派发」主体。审计由外层 send() 包办（成功/失败各记一条）。
       *
       * 检查顺序（前一道不通过就不会走到后一道）：
       *  1. 授权总闸（auth.ts）—— 能不能用浏览器；
       *  2. 动作级门禁（browser-guard.ts）—— 这个动作允不允许（默认拒绝）；
       *  3. 域名围栏（policy.ts）—— 白/黑名单；
       *  4. 后台策略 —— 是否允许激活标签页。
       */
      const sendChecked = async (
        action: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        cfg: BrowserConfig,
      ): Promise<unknown> => {
        assertBrowserAuthorized(unattended, cfg, { readOnly: READ_ONLY_ACTIONS.has(action) }); // 授权闸门（未授权/无人值守越界即抛）
        // 动作级门禁：upload / evaluate / 组合键默认拒绝（详见 browser-guard.ts）。
        assertActionGuarded(action, params, cfg);
        // 后台策略：
        //  - 窗口可见时 → 强制前台：用户在场（扫码/登录），必须让他看见页面。
        //  - 无头时 → 走常规静默策略。
        // 注意用**运行时**模式（effectiveHeadless）而非配置：自动弹窗/手动 show 后
        // 实例已是可见窗口，此时不该再按"配置=无头"把它算成后台。
        const forceForeground = !effectiveHeadless(cfg);
        const background = forceForeground
          ? false
          : effectiveBackground(params as { background?: boolean; foreground?: boolean }, cfg.background);
        assertActionAllowed(action, background);
        // 域名围栏（前置）：能拿到 URL 的动作先查。
        if (typeof params.url === "string") assertUrlAllowed(params.url, cfg);
        // 按需启动/切换托管 Chrome，并连接 CDP（playwright-core 直连）。
        await ensureBrowserReady(cfg);
        const cdp = getManagedCdp(cfg);
        if (!cdp.connected) {
          const ok = await connectManagedCdp(cfg);
          if (!ok) {
            throw new Error(
              `托管 Chrome 的 CDP 未连接（${cdp.url}）。请调 browser({action:"status"}) 查看状态，` +
                `并确认 managed.executablePath 指向有效的 Chrome、且 Chrome 已成功启动（查看主进程日志）。`,
            );
          }
        }
        const result = await cdp.send(action, {
          ...params,
          background,
          foreground: !background,
        });
        rememberFromResult(result); // 供 browser window show 自动恢复页面
        // 非快照动作会改变页面（或至少代表换了策略）→ 清零停滞计数；
        // 只有连续 snapshot 才允许累积，避免把「边操作边观察」误判成死循环。
        if (action !== "page.snapshot") stalledSnapshots = 0;
        return result;
      };

      /**
       * 统一的「门禁 + 后台策略 + 连接自检 + 审计」出口，所有 action 都走这里。
       * 无论成功还是被拒，都往审计日志写一条（**拦截事件往往比成功事件更值得看**）。
       */
      const send = async (
        action: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
        cfgOverride?: BrowserConfig,
      ): Promise<unknown> => {
        const cfg = cfgOverride ?? readBrowserConfigSync();
        const url = typeof params.url === "string" ? params.url : undefined;
        try {
          const result = await sendChecked(action, params, signal, cfg);
          appendBrowserAudit({
            unattended,
            action,
            ok: true,
            ...(url ? { url } : {}),
            detail: summarizeParams(params),
          });
          return result;
        } catch (error) {
          appendBrowserAudit({
            unattended,
            action,
            ok: false,
            ...(url ? { url } : {}),
            error: (error as Error).message,
            detail: summarizeParams(params),
          });
          throw error;
        }
      };

      // ---- 各 action 的格式化助手（内核 send 不变，这里只处理返回呈现）----

      const doStatus = async (cfg: BrowserConfig): Promise<AgentToolResult<unknown>> => {
        const cdp = getManagedCdp(cfg);
        let browserInfo: unknown = null;
        if (cdp.connected) {
          browserInfo = await cdp
            .send("tab.version", {})
            .catch((error) => ({ error: String((error as Error).message) }));
        }
        const info = {
          enabled: cfg.enabled,
          managed: cfg.managed,
          managedChrome: managedChromeInfo(),
          background: cfg.background,
          allowUnattended: cfg.allowUnattended,
          allowUnattendedRead: cfg.allowUnattendedRead,
          allowedDomains: cfg.allowedDomains,
          blockedDomains: cfg.blockedDomains,
          guard: guardSummary(cfg),
          auditFile: browserAuditFile(),
          authorization: authSummary(cfg),
          unattendedSession: unattended,
          transport: { mode: "cdp", url: cdp.url, connected: cdp.connected },
          profileDir: managedProfileDir(),
          agentDir: getAgentDir(),
          browser: browserInfo,
        };
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }], details: info };
      };

      const doSnapshot = async (
        rest: Record<string, unknown>,
        signal: AbortSignal | undefined,
        cfg: BrowserConfig,
      ): Promise<AgentToolResult<unknown>> => {
        const snapshot = (await send("page.snapshot", rest, signal, cfg)) as BrowserSnapshot;
        const visible = !effectiveHeadless(cfg);
        let text = withLoginHint(formatBrowserSnapshot(snapshot), { snapshot }, visible);
        // 死循环止损：连续多份「页面毫无变化」的快照 = 模型的动作没生效却在硬试。
        // 把提示从陈述句升级为祈使句/强制停止，并在更严重时按错误结果终止本轮
        // （terminate 由 SDK agent-loop 强制结束该 tool batch，模型无法继续。
        //  兜底之外还有宿主层 tool_call 的通用同参重复拦截）。
        stalledSnapshots = snapshotUnchanged(snapshot) ? stalledSnapshots + 1 : 0;
        if (stalledSnapshots >= SNAPSHOT_STALL_STOP) {
          text +=
            `\n\n⛔ 已连续 ${stalledSnapshots} 次快照，页面**毫无变化**：你正在重复一个无效动作（死循环）。` +
            "本轮已被系统强制结束。请立即停止调用 browser，基于你已经掌握的信息直接回答用户；" +
            "若信息确实不足，明确告诉用户你卡在哪里、需要什么帮助，不要再用同样方式重试。";
          loopNotice = stalledSnapshots; // 待 agent_end 补发可见说明（见上方 pi.on）
          return { content: [{ type: "text", text }], details: { snapshot }, isError: true, terminate: true };
        }
        if (stalledSnapshots >= SNAPSHOT_STALL_WARN) {
          text +=
            `\n\n⚠️ 已连续 ${stalledSnapshots} 次快照，页面**毫无变化**——你重复的动作没有生效。` +
            "**不要再用同样的方式重试**：换一个策略（换 uid / 先 screenshot 看版式 / 换新思路），或直接停下向用户说明你卡住了。";
        }
        return { content: [{ type: "text", text }], details: { snapshot } };
      };

      const doScreenshot = async (
        rest: Record<string, unknown>,
        signal: AbortSignal | undefined,
        cfg: BrowserConfig,
      ): Promise<AgentToolResult<unknown>> => {
        const result = (await send("page.screenshot", rest, signal, cfg)) as { dataUrl?: string };
        if (!result.dataUrl) throw new Error("截图失败：浏览器未返回 dataUrl。");
        const image = toImageContent(result.dataUrl);
        const content: ContentBlock[] = [
          { type: "text", text: "已捕获当前业务系统截图（见附图）。" },
          image,
        ];
        return { content, details: { tab: (result as { tab?: unknown }).tab } };
      };

      const doClick = async (
        rest: Record<string, unknown>,
        signal: AbortSignal | undefined,
        cfg: BrowserConfig,
      ): Promise<AgentToolResult<unknown>> => {
        const result = await send("page.click", rest, signal, cfg);
        if (rest.includeSnapshot) {
          const snapshot = (await send(
            "page.snapshot",
            { targetId: rest.targetId },
            signal,
            cfg,
          )) as BrowserSnapshot;
          return {
            content: [
              { type: "text", text: `${JSON.stringify(result)}\n\n${formatBrowserSnapshot(snapshot)}` },
            ],
            details: { result, snapshot },
          };
        }
        return asText(result);
      };

      const doNavigate = async (
        rest: Record<string, unknown>,
        signal: AbortSignal | undefined,
        cfg: BrowserConfig,
      ): Promise<AgentToolResult<unknown>> => {
        let navigated = (await send("page.navigate", rest, signal, cfg)) as {
          tab?: { url?: string; title?: string };
        };
        // 主流程：撞到登录页 + 需要人工介入（验证码/扫码/短信）+ 当前无头 → **自动弹出可见窗口**。
        // 纯用户名密码登录页不自动弹窗：让模型自己 snapshot → fill → submit，不需要用户介入。
        const needsLogin = looksLikeLogin({ url: navigated?.tab?.url, title: navigated?.tab?.title });
        const captchaLogin = isCaptchaLoginPage({ url: navigated?.tab?.url, title: navigated?.tab?.title });
        let autoShown = false;
        if (needsLogin && captchaLogin && effectiveHeadless(cfg)) {
          try {
            // 切换可见性会重启 Chrome → 旧 CDP 连接失效，重启后重连（connectManagedCdp 会重试）。
            await ensureManagedChrome(false, cfg);
            await connectManagedCdp(cfg);
            // 切换会重启浏览器、页面回到空白 → 重新打开同一 URL（此时 send 会因
            // 运行时已是可见窗口而自动前台化，标签被激活，用户能看到二维码）。
            navigated = (await send("page.navigate", rest, signal, cfg)) as typeof navigated;
            autoShown = true;
          } catch {
            // 弹窗失败（如上次运行遗留的托管窗口占用句柄）：不影响本次结果，
            // 下面的 LOGIN_HINT 会引导模型调 browser window，那里有明确报错。
          }
        }
        const payload = JSON.stringify(navigated);
        const text = autoShown
          ? `${payload}\n\n⚠️ 已**自动弹出托管浏览器窗口**（橙色「Pi 自动化」），因为检测到这是需要人工介入的登录页（验证码/扫码/短信）。` +
            `请告知用户在该窗口完成登录；用户确认登录完成后，调 ` +
            `browser({action:"window", windowAction:"hide"}) 切回后台，再 browser({action:"navigate"}) 继续干活。`
          : withLoginHint(
              payload,
              { url: navigated?.tab?.url, title: navigated?.tab?.title },
              !effectiveHeadless(cfg),
            );
        return { content: [{ type: "text", text }], details: { result: navigated } };
      };

      const doWindow = async (
        windowAction: string | undefined,
        rest: Record<string, unknown>,
        signal: AbortSignal | undefined,
        cfg: BrowserConfig,
      ): Promise<AgentToolResult<unknown>> => {
        const cdp = getManagedCdp(cfg);
        if (!windowAction || windowAction === "status") {
          const info = {
            managed: cfg.managed,
            managedChrome: managedChromeInfo(),
            transport: { mode: "cdp", url: cdp.url, connected: cdp.connected },
          };
          return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }], details: info };
        }
        assertBrowserAuthorized(unattended, cfg);
        const headless = windowAction === "hide";
        // 切换可见性必然重启 Chrome → 旧 CDP 连接失效，重启后重连（connectManagedCdp 会重试）。
        await ensureManagedChrome(headless, cfg);
        await connectManagedCdp(cfg);
        let navigated: unknown = null;
        // 切换模式会重启浏览器 → 页面丢失。show 未显式给 url 时自动恢复「最近访问的页面」，
        // 否则用户看到的只是一张空白页（体验上就变成了"弹出个新标签页"）。
        const targetUrl =
          typeof rest.url === "string" ? rest.url : windowAction === "show" ? lastVisitedUrl() : undefined;
        if (targetUrl) {
          assertUrlAllowed(targetUrl, cfg);
          navigated = await cdp
            // foreground:true —— show 的目的是让用户看见（扫码/登录），必须激活标签。
            .send("page.navigate", { url: targetUrl, foreground: true, background: false })
            .catch((error) => ({ error: String((error as Error).message) }));
          // 这条路径直连 CDP（不走 send()），故自行补一条审计：window show 触发的导航
          // 也是一次真实的页面跳转，不该在审计里缺席。
          const navError = (navigated as { error?: string } | null)?.error;
          appendBrowserAudit({
            unattended,
            action: "page.navigate",
            ok: !navError,
            url: targetUrl,
            ...(navError ? { error: String(navError) } : {}),
            detail: { via: "window " + windowAction },
          });
        }
        const info = {
          action: windowAction,
          headless,
          managedChrome: managedChromeInfo(),
          transport: { mode: "cdp", url: cdp.url, connected: cdp.connected },
          navigated,
          note: headless
            ? "已切回无头后台（完全不可见）。"
            : `已打开可见窗口${targetUrl ? `并打开页面：${targetUrl}` : "（无历史页面可恢复，请再 browser({action:\"navigate\"})）"}，` +
              "请让用户完成登录；完成后调 browser({action:\"window\", windowAction:\"hide\"}) 切回后台。",
        };
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }], details: info };
      };

      // ---- 单一工具注册 ----
      pi.registerTool(
        defineTool({
          name: "browser",
          label: "浏览器控制",
          description:
            "控制浏览器操作业务系统（单一入口，靠 action 区分操作）。" +
            "观察：snapshot(结构+元素uid，加 delta:true 只取与上次的差异) / screenshot(图片) / tabs(标签列表) / status(连接诊断)。" +
            "交互：navigate(打开URL) / click / type(追加输入) / fill(清空再写，支持 fields 数组批量) / press_key / hover / scroll。" +
            "click/type/fill/press_key/navigate 会返回后验信号：navigated(URL是否变) / newRequests(是否发出新请求) / effective(是否真的生效)；" +
            "fill/type 还有 valueChanged(控件值/勾选/选中项是否真的写入)，批量 fill 另给 fieldsChanged。" +
            "effective=false 说明动作没产生可见效果，别盲目重试。可加 waitFor:{url|selector,timeout} 等结果再返回。" +
            "高级：evaluate(跑JS) / drag(拖拽) / upload(上传文件) / get_cookie(导出指定站点 Cookie，含 HttpOnly)。" +
            "窗口：window show 弹出可见窗口让用户自己完成验证码/扫码登录，登录完 window hide 切回后台。" +
            "浏览器由本应用自己启动（独立 profile、默认不可见、登录态跨会话保留），**不需要安装任何浏览器扩展**。",
          promptSnippet:
            "Control the browser to operate the business system via one tool: snapshot/screenshot to see, navigate/click/type/fill to act, window to show/hide for login, status to diagnose. Pick the action, not a separate tool name.",
          promptGuidelines: [
            '操作业务系统前，先 browser({action:"snapshot"}) 观察页面、拿元素 uid，或 browser({action:"tabs"}) 找目标标签页 id；后续定位一律用 uid / targetId。',
            '用户给网址让你干活时，先 browser({action:"navigate", url}) 打开，再 snapshot 看内容。',
            '点击/输入用 uid（来自最近一次 snapshot）；uid 失效就重新 snapshot，不要盲目重试。',
            'click/type/fill/press_key/navigate 的返回里 effective=false 表示 URL 未变、无新请求、控件值未变、元素仍在原位——即这一步没生效；应重新 snapshot 核对，而不是原样重试。fill/type 会明确给 valueChanged：为 true 就说明值确实写进去了，即使 effective 里其它项都为 false 也算成功，不要再重试。要等结果可在动作里带 waitFor:{url:"..."} 或 {selector:"..."}（默认等 5s）。',
            '填多字段表单（登录等）用 browser({action:"fill", fields:[{uid,text},…], submit:true}) 一次写完，省往返调用。',
            '报错「存在 N 个非空白标签页」时：先 browser({action:"tabs"}) 看列表，再在动作里带 targetId 指定目标标签页；不要假设自动落在你要的那个 tab。',
            'snapshot 被大量被遮挡的浮层/隐藏表单淹没时，加 excludeOccluded:true 直接略去被遮挡节点（结果里会给 occludedSkipped 计数）。',
            'browser({action:"type"}) 是**追加**输入；输入框已有值时应改用 browser({action:"fill"})（先清空再写）；fill 的 submit:true 只在确实要提交表单时使用，避免误提交业务单据。',
            "页面结构变化（跳转/弹窗/提交）后要重新 snapshot 取新 uid，旧 uid 可能已失效。",
            '动作之后只想确认「有没有反应」时，用 browser({action:"snapshot", delta:true})：页面没实质变化会返回精简结果并明确告诉你「没反应」，省上下文；有变化会先列出差异、再给全量清单。需要重新核对完整元素清单时才用不带 delta 的 snapshot。',
            '需要看图片/图表/版式时用 browser({action:"screenshot"})；截图仅用于视觉确认，不作为点击坐标依据。',
            '点不到的元素可先 browser({action:"press_key", key:"Tab"}) 移焦点再 Enter 触发，常能绕过遮挡层。',
            'hover 才出现的菜单：先 browser({action:"hover"}) 再 snapshot 拿新 uid。',
            '能用 snapshot + click 完成的，不要绕道 browser({action:"evaluate"}) 跑 JS（该动作默认被门禁拒绝）。',
            '接口自动化（HTTP 调用需要带登录态）时用 browser({action:"get_cookie", url:"<业务站点URL>"}) 获取完整 Cookie 字符串（含 HttpOnly）；一次只导指定站点、受白名单约束。返回值含 valid=yes/no/unknown 会话探活：valid=no（401/403 或重定向到登录页）说明登录态已失效，**不要盲目重试**，应立即 browser({action:"window", windowAction:"show"}) 弹出窗口，请用户扫码/验证码重新登录后再 hide 切回；valid=unknown 时先办正事、以接口 401 为准。完整 Cookie 等同账号会话凭据：只用于授权范围内的自动化，不要泄露给第三方或写入公开文件。',
            '撞到登录页：系统只在**验证码/扫码/短信登录**场景自动弹窗；纯用户名密码登录页不会自动弹窗，让你自己 snapshot → fill → submit。分三种情况：① 对话历史里已有用户给的账号密码 → 先用 snapshot 定位表单字段（密码框显示 value=[已掩码] 是**安全遮蔽、正常现象**，不是空框也不是异常，填完后系统继续遮蔽、不会回显密码，**也不要在对话里复述密码**），再 browser({action:"fill", uid:<密码框uid>, text:<密码>}) 填写；提交后再 snapshot 看登录是否成功（URL 变了 / 登录框消失 / 出现业务页面元素）。② 出现验证码/扫码/短信/密码错误提示 → 立即 browser({action:"window", windowAction:"show"}) 弹窗让用户介入。③ 还没拿到凭据 → prompt 用户提供账号密码，再走 ①。自动弹窗提示出现时不要重复调 window；用户登录完成后 browser({action:"window", windowAction:"hide"}) 切回后台。',
            '三类高危动作默认被门禁拒绝：upload 上传本机文件 / evaluate 跑任意 JS / press_key 带 ctrl·meta·alt 组合键。被拒时错误消息会说清原因、并指出要在 browser-config.json 的 guard 段放开哪一项 —— **把这个决定交给用户，不要自己想办法绕过**（例如用 evaluate 顶替 upload）。',
            '其他 browser 调用报错或异常时，先 browser({action:"status"}) 查连接与配置。',
          ],
          parameters: Type.Object(
            {
              // 核心操作选择
              action: Type.Union(
                [
                  Type.Literal("status"),
                  Type.Literal("tabs"),
                  Type.Literal("snapshot"),
                  Type.Literal("screenshot"),
                  Type.Literal("navigate"),
                  Type.Literal("get_cookie"),
                  Type.Literal("click"),
                  Type.Literal("type"),
                  Type.Literal("fill"),
                  Type.Literal("press_key"),
                  Type.Literal("hover"),
                  Type.Literal("scroll"),
                  Type.Literal("evaluate"),
                  Type.Literal("drag"),
                  Type.Literal("upload"),
                  Type.Literal("window"),
                ],
                { description: "操作类型。" },
              ),
              // 窗口
              windowAction: Type.Optional(
                Type.Union([Type.Literal("show"), Type.Literal("hide"), Type.Literal("status")], {
                  description: "仅 action=window 时：show=可见窗口(登录用)，hide=切回无头，status=查看状态。",
                }),
              ),
              // 导航 / 目标选择
              url: Type.Optional(Type.String({ description: "action=navigate、window(show) 时的目标 URL，或 action=get_cookie 时要导出的业务站点 URL（受白名单约束）。" })),
              targetId: Type.Optional(Type.String({ description: "目标标签页 id（来自 tabs / snapshot）。" })),
              // 元素定位
              uid: Type.Optional(Type.String({ description: "元素 uid（来自 snapshot）。click/type/fill/hover/drag 用。" })),
              selector: Type.Optional(Type.String({ description: "CSS 选择器（无 uid 时）。" })),
              // 文本输入
              text: Type.Optional(Type.String({ maxLength: 4000, description: "type / fill 的输入文本。" })),
              fields: Type.Optional(
                Type.Array(
                  Type.Object({
                    uid: Type.Optional(Type.String()),
                    selector: Type.Optional(Type.String()),
                    text: Type.String(),
                  }),
                  {
                    description:
                      "仅 action=fill：批量填多个字段，一次调用写完整张表单（登录等）。每项 {uid|selector, text}；配 submit:true 可一并提交。",
                  },
                ),
              ),
              perCharacter: Type.Optional(Type.Boolean({ description: "逐字符输入（较慢但更接近真人）。" })),
              pressEnter: Type.Optional(Type.Boolean({ description: "type 后回车。" })),
              submit: Type.Optional(Type.Boolean({ description: "fill 后提交所在表单。" })),
              includeSnapshot: Type.Optional(Type.Boolean({ description: "click 后附带一份新快照。" })),
              waitFor: Type.Optional(
                Type.Object(
                  {
                    url: Type.Optional(Type.String({ description: "URL 正则，命中即结束等待。" })),
                    selector: Type.Optional(Type.String({ description: "CSS 选择器，出现即结束等待。" })),
                    timeout: Type.Optional(Type.Number({ description: "最长等待毫秒数（默认 5000）。" })),
                  },
                  {
                    description:
                      '可选：动作后等待条件成立再返回（click/type/fill/press_key/navigate 适用），把「动作→等结果」收敛成一次调用。例：{url:"/home"}。',
                  },
                ),
              ),
              // 按键
              key: Type.Optional(Type.String({ description: "press_key 的键名，如 Enter/Tab/Escape/ArrowDown/a。" })),
              ctrlKey: Type.Optional(Type.Boolean()),
              altKey: Type.Optional(Type.Boolean()),
              shiftKey: Type.Optional(Type.Boolean()),
              metaKey: Type.Optional(Type.Boolean()),
              // 滚动
              deltaX: Type.Optional(Type.Number()),
              deltaY: Type.Optional(Type.Number()),
              // 快照选项
              mode: Type.Optional(
                Type.Union([
                  Type.Literal("auto"),
                  Type.Literal("interactive"),
                  Type.Literal("forms"),
                  Type.Literal("text"),
                ]),
              ),
              maxElements: Type.Optional(Type.Number({ minimum: 1, maximum: 400 })),
              containingText: Type.Optional(Type.String({ description: "只返回标签文本包含该串的元素。" })),
              roleFilter: Type.Optional(Type.String({ description: "只返回该 role/标签名的元素，如 button。" })),
              delta: Type.Optional(
                Type.Boolean({
                  description:
                    "仅 action=snapshot：返回与上次快照的结构化差异（元素增删改 / 表单值变 / 文本变 / 焦点 / 跳转）；" +
                    "页面无实质变化时输出精简形态（省略元素清单，省上下文）。适合「操作一下再看有没有反应」的轮询场景。默认 false。",
                }),
              ),
              excludeOccluded: Type.Optional(
                Type.Boolean({
                  description:
                    "仅 action=snapshot：略去中心被浮层遮挡的节点（occluded-by-*），只在结果里回 occludedSkipped 计数。" +
                    "用于挡掉被遮罩盖住的隐藏表单/重复控件。默认 false（保留并标记 [occluded-by-…]）。",
                }),
              ),
              // 截图选项
              format: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg")])),
              quality: Type.Optional(Type.Number({ minimum: 0, maximum: 100, description: "JPEG 质量 0-100。" })),
              // 求值
              expression: Type.Optional(Type.String({ maxLength: 4000, description: "evaluate 的 JS 表达式。" })),
              // get_cookie 会话探活
              probe: Type.Optional(
                Type.Boolean({
                  description:
                    "仅 action=get_cookie：是否对该站点做一次无副作用 GET 探活以判断会话是否失效（默认 true）。返回 valid=yes/no/unknown。",
                }),
              ),
              // 拖拽
              fromUid: Type.Optional(Type.String()),
              toUid: Type.Optional(Type.String()),
              fromX: Type.Optional(Type.Number()),
              fromY: Type.Optional(Type.Number()),
              toX: Type.Optional(Type.Number()),
              toY: Type.Optional(Type.Number()),
              steps: Type.Optional(Type.Number({ minimum: 4, maximum: 60 })),
              // 上传
              paths: Type.Optional(Type.Array(Type.String(), { description: "upload 的本地绝对路径数组。" })),
              // 后台策略
              background: Type.Optional(Type.Boolean()),
              foreground: Type.Optional(Type.Boolean()),
            },
            { additionalProperties: true },
          ),
          execute: async (_id, params, signal): Promise<AgentToolResult<unknown>> => {
            const { action, windowAction, ...rest } = params as Record<string, unknown> & {
              action: string;
              windowAction?: string;
            };
            const cfg: BrowserConfig = readBrowserConfigSync();

            switch (action) {
              case "status":
                return doStatus(cfg);
              case "tabs":
                return asText(await send("tab.list", rest, signal, cfg));
              case "snapshot":
                return doSnapshot(rest, signal, cfg);
              case "screenshot":
                return doScreenshot(rest, signal, cfg);
              case "navigate":
                return doNavigate(rest, signal, cfg);
              case "get_cookie": {
                const url = typeof rest.url === "string" ? rest.url : undefined;
                if (!url) throw new Error("get_cookie 需要 url 参数（要导出的业务站点 URL，受白名单约束）。");
                return asText(await send("tab.get_cookie", { url, probe: rest.probe === false ? false : true }, signal, cfg));
              }
              case "click":
                return doClick(rest, signal, cfg);
              case "type":
                return asText(await send("page.type", rest, signal, cfg));
              case "fill":
                return asText(await send("page.fill", rest, signal, cfg));
              case "press_key": {
                const payload = {
                  key: rest.key,
                  modifiers: {
                    ctrlKey: rest.ctrlKey,
                    altKey: rest.altKey,
                    shiftKey: rest.shiftKey,
                    metaKey: rest.metaKey,
                  },
                  targetId: rest.targetId,
                };
                return asText(await send("page.key", payload, signal, cfg));
              }
              case "hover":
                return asText(await send("page.hover", rest, signal, cfg));
              case "scroll":
                return asText(await send("page.scroll", rest, signal, cfg));
              case "evaluate":
                return asText(await send("page.evaluate", rest, signal, cfg));
              case "drag":
                return asText(await send("page.drag", rest, signal, cfg));
              case "upload":
                return asText(await send("page.upload", rest, signal, cfg));
              case "window":
                return doWindow(windowAction, rest, signal, cfg);
              default:
                throw new Error(
                  `未知 action: ${action}。可选：status / tabs / snapshot / screenshot / navigate / click / type / ` +
                    "fill / press_key / hover / scroll / evaluate / drag / upload / window。",
                );
            }
          },
        }),
      );
    },
  };
}

/** 普通/空间会话。 */
export const browserTool = createBrowserTool();

/** 定时任务会话：无人值守常驻授权（需 allowUnattended）。 */
export const browserToolUnattended = createBrowserTool({ unattended: true });

/** "data:image/png;base64,AAAA…" → { type:"image", data:"AAAA…", mimeType:"image/png" } */
function toImageContent(dataUrl: string): ImageBlock {
  const comma = dataUrl.indexOf(",");
  const meta = comma >= 0 ? dataUrl.slice(0, comma) : "";
  const data = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const mimeType = /data:(image\/[a-z0-9.+-]+)/i.exec(meta)?.[1] ?? "image/png";
  return { type: "image", data, mimeType };
}
