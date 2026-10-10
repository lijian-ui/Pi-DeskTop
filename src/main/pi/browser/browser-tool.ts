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
import { createHash } from "node:crypto";
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

/** 替换历史里被裁掉的浏览器截图（模型可见，按约定走英文）。 */
const BROWSER_SHOT_OMITTED =
  "[screenshot omitted] An earlier browser screenshot was dropped from history to keep the request within the provider size limit. " +
  'If you need to look at the page again, call browser({action:"screenshot"}).';

/** 是否是「带图片的 browser 工具结果」——即一次截图（tabResult 不含 image 块）。 */
function isBrowserShot(m: unknown): boolean {
  const r = m as { role?: unknown; toolName?: unknown; content?: unknown };
  return (
    r?.role === "toolResult" &&
    r.toolName === "browser" &&
    Array.isArray(r.content) &&
    (r.content as any[]).some((b) => b?.type === "image")
  );
}

/**
 * 上一次截图的内容哈希（按 tab URL 缓存）。
 * 用途：页面未变化时不再重复附图 —— 每张图都会永久留在上下文里（正是长会话爆掉的根因），
 * 「截图看一眼有没有变」这种调用若原样重发，纯属浪费。拿不到 URL（如 about:blank）时不缓存。
 */
const lastShotHash = new Map<string, string>();

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
       * 历史截图瘦身（`context` 钩子）。
       *
       * 背景：screenshot 的返回带 image 块（base64，单张可达数百 KB），SDK 会把
       * **整段历史**原样发给模型，于是长会话里每次请求都在重发历史中的每一张截图。
       * 累计到一定程度后服务端多模态处理直接失败（`400 Param Incorrect /
       * failed during process multi-modal data`），表现为「发完消息停止按钮闪一下、
       * 模型不回复、也没有报错」；新建会话则正常 —— 正因为历史里没有截图。
       *
       * 处理：只在**发往模型前**把「除最近一张外」的浏览器截图替换成一行文字占位，
       * 最近一张（通常是本轮刚截的）保持可见。注意：
       *  - 只动 role==="toolResult" 且 toolName==="browser" 的消息；用户在对话里
       *    自己粘贴/上传的图片在 user 消息中，**绝不触碰**；
       *  - 这是请求级副本：Pi 在钩子返回后会恢复会话状态（见 SDK docs/extensions.md），
       *    界面历史与磁盘会话文件都保持原样。
       */
      pi.on("context", (event) => {
        const messages = event.messages as any[];
        // 定位最后一条「含图片」的浏览器工具结果 —— 它之前的截图都要被替换。
        let lastShot = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (isBrowserShot(messages[i])) {
            lastShot = i;
            break;
          }
        }
        if (lastShot < 0) return; // 历史里没有浏览器截图，无需处理
        let changed = false;
        const next = messages.map((m, i) => {
          if (i >= lastShot || !isBrowserShot(m)) return m;
          changed = true;
          return {
            ...m,
            content: (m.content as any[]).map((b) =>
              b?.type === "image" ? { type: "text", text: BROWSER_SHOT_OMITTED } : b,
            ),
          };
        });
        return changed ? { messages: next } : undefined;
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
            "**不要再用同样的方式重试**：换一个策略（换 uid / 先 snapshot({mode:\"text\"}) 看版式与正文 / 换新思路），或直接停下向用户说明你卡住了。";
        }
        return { content: [{ type: "text", text }], details: { snapshot } };
      };

      const doScreenshot = async (
        rest: Record<string, unknown>,
        signal: AbortSignal | undefined,
        cfg: BrowserConfig,
      ): Promise<AgentToolResult<unknown>> => {
        const result = (await send("page.screenshot", rest, signal, cfg)) as {
          dataUrl?: string;
          tab?: { url?: string; title?: string };
        };
        if (!result.dataUrl) throw new Error("截图失败：浏览器未返回 dataUrl。");
        const tab = result.tab;
        // 页面身份写进文字里：模型据此确认截的是哪一页，无需额外再调 tabs/snapshot。
        const where = tab?.url ? `页面：${tab.title || "(无标题)"}（${tab.url}）` : "";
        // 内容去重：同一 URL 的截图字节完全相同 → 页面没变，省略重复图片（除非显式 force）。
        const hash = createHash("sha1").update(result.dataUrl).digest("hex");
        const key = tab?.url ?? "";
        const unchanged = rest.force !== true && !!key && lastShotHash.get(key) === hash;
        if (key) lastShotHash.set(key, hash);
        if (unchanged) {
          return {
            content: [
              {
                type: "text",
                text:
                  `截图与上一张完全相同：页面无变化，已省略重复图片以节省上下文。${where}\n` +
                  "确实需要这张图时请传 force: true。",
              },
            ],
            details: { tab, omitted: true },
          };
        }
        const image = toImageContent(result.dataUrl);
        const content: ContentBlock[] = [
          { type: "text", text: `已捕获当前业务系统截图（见附图）。${where}` },
          image,
        ];
        return { content, details: { tab } };
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
            "Control the browser to operate business systems (single entry point; the action field selects the operation). " +
            "Observe: snapshot (structure + element uid; add delta:true for a diff against the last snapshot; mode:\"text\" also returns the whole page text — the safe way to read tables/lists instead of evaluate) / screenshot (image) / tabs (tab list) / status (connection diagnostics). " +
            "Interact: navigate (open URL) / click / type (append) / fill (clear then write; accepts a fields array for batch) / press_key / hover / scroll. " +
            "click/type/fill/press_key/navigate return post-action signals: navigated (URL changed) / newRequests (new requests fired) / effective (whether the action really took effect); " +
            "fill/type also return valueChanged (whether the control's value/checked/selectedIndex actually changed), and batch fill returns fieldsChanged. " +
            "effective=false means the action produced no visible effect — do not blindly retry. Add waitFor:{url|selector,timeout} to wait for an outcome before returning. " +
            "Advanced: evaluate (run JS) / drag / upload (upload a file) / get_cookie (export cookies for a given site, including HttpOnly). " +
            "Window: window show pops a visible window so the user can complete a CAPTCHA/QR login themselves; window hide returns to the background afterwards. " +
            "The browser is launched by this app itself (separate profile, hidden by default, login state persists across sessions) — **no browser extension is required**.",
          promptSnippet:
            "Control the browser to operate the business system via one tool: snapshot/screenshot to see, navigate/click/type/fill to act, window to show/hide for login, status to diagnose. Pick the action, not a separate tool name.",
          promptGuidelines: [
            'Before operating a business system, first call browser({action:"snapshot"}) to observe the page and get element uids, or browser({action:"tabs"}) to find the target tab id; always locate elements with uid / targetId afterwards.',
            'When the user gives you a URL to work on, first call browser({action:"navigate", url}) to open it, then snapshot to see the content.',
            'Click/type with uid (from the latest snapshot); if a uid is stale, snapshot again — do not blindly retry.',
            'In the return of click/type/fill/press_key/navigate, effective=false means the URL did not change, no new requests fired, the control value did not change, and the element stayed in place — i.e. the action had no effect; snapshot again to re-check instead of retrying as-is. fill/type explicitly report valueChanged: true means the value really was written, so it is a success even if other effective fields are false — do not retry. To wait for an outcome, pass waitFor:{url:"..."} or {selector:"..."} in the action (default wait 5s).',
            'For multi-field forms (e.g. login), use browser({action:"fill", fields:[{uid,text},…], submit:true}) to write the whole form in one call, saving round-trips.',
            'On the error "N non-blank tabs exist": first call browser({action:"tabs"}) to see the list, then pass targetId in the action to pick the target tab; do not assume it lands on the tab you want.',
            'When a snapshot is flooded by occluded overlays/hidden forms, add excludeOccluded:true to omit occluded nodes (the result reports an occludedSkipped count).',
            'browser({action:"type"}) **appends** input; when a field already has a value, use browser({action:"fill"}) instead (clear then write); fill\'s submit:true should only be used when you really want to submit the form, to avoid accidentally submitting business documents.',
            "After the page structure changes (navigation/dialog/submit), snapshot again to get fresh uids; old uids may be stale.",
            'To merely confirm "did anything react" after an action, use browser({action:"snapshot", delta:true}): if the page did not substantively change it returns a condensed result that explicitly tells you "no reaction", saving context; if it changed it lists the diff first, then the full list. Only use a snapshot without delta when you need to re-check the complete element list.',
            'Observation priority: default to browser({action:"snapshot"}) to understand the page and verify an action\'s effect (add delta:true to compare against the last snapshot). To read long page content such as tables/lists, use browser({action:"snapshot", mode:"text"}) — it returns the whole page text (## 页面全文); never detour through evaluate for that. Reserve browser({action:"screenshot"}) for things only an image can convey — pictures/charts/layout, or a login QR code — and **do not screenshot a page that has not changed**: every image stays in the context permanently, and an identical one is dropped with a notice (pass force:true only when you genuinely need the image again).',
            'For an element you cannot click, first browser({action:"press_key", key:"Tab"}) to move focus then Enter to trigger it — this often bypasses overlay layers.',
            'For menus that only appear on hover: first browser({action:"hover"}) then snapshot to get the new uids.',
            'If snapshot + click can do it, do not detour through browser({action:"evaluate"}) to run JS (that action is denied by the guard by default). To extract page text/data, use browser({action:"snapshot", mode:"text"}) or snapshot + containingText, not evaluate.',
            'For API automation (HTTP calls that need the login state), use browser({action:"get_cookie", url:"<business site URL>"}) to get the full Cookie string (including HttpOnly); only the specified site is exported per call, bound by the allowlist. The return includes valid=yes/no/unknown session probing: valid=no (401/403 or redirect to login) means the login state has expired — **do not blindly retry**; immediately browser({action:"window", windowAction:"show"}) to pop the window and ask the user to log in again via QR/captcha, then hide to switch back; when valid=unknown, do the real work first and take the API\'s 401 as the source of truth. A full Cookie is equivalent to account session credentials: use it only for automation within the authorized scope, and never leak it to third parties or write it to public files.',
            'When you hit a login page: the system only auto-pops the window for **captcha/QR/SMS login**; a pure username/password login page will not auto-pop, leaving you to snapshot → fill → submit yourself. Three cases: ① the account and password from the user are already in the conversation history → first snapshot to locate the form fields (the password box showing value=[masked] is **normal secure masking**, not an empty box or an anomaly; after filling the system keeps masking it and will not echo the password, **and do not repeat the password in the conversation**), then fill with browser({action:"fill", uid:<password box uid>, text:<password>}); after submitting, snapshot again to see whether login succeeded (URL changed / login box gone / business page elements appeared). ② If a captcha/QR/SMS/password-error prompt appears → immediately browser({action:"window", windowAction:"show"}) to pop the window and let the user take over. ③ If you do not yet have credentials → prompt the user for account/password, then go to ①. Do not call window again when the auto-pop notice appears; after the user finishes logging in, browser({action:"window", windowAction:"hide"}) to switch back to the background.',
            'Three high-risk actions are denied by the guard by default: upload (upload a local file) / evaluate (run arbitrary JS) / press_key with ctrl·meta·alt combos. When denied, the error message explains why and points to which item to enable in the guard section of browser-config.json — **leave that decision to the user; do not find your own way around it** (e.g. using evaluate instead of upload).',
            'When other browser calls error or misbehave, first browser({action:"status"}) to check the connection and config.',
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
                { description: "Operation type." },
              ),
              // 窗口
              windowAction: Type.Optional(
                Type.Union([Type.Literal("show"), Type.Literal("hide"), Type.Literal("status")], {
                  description: "Only for action=window: show=visible window (for login), hide=switch back to headless, status=view state.",
                }),
              ),
              // 导航 / 目标选择
              url: Type.Optional(Type.String({ description: "Target URL for action=navigate / window(show), or the business site URL to export for action=get_cookie (bound by the allowlist)." })),
              targetId: Type.Optional(Type.String({ description: "Target tab id (from tabs / snapshot)." })),
              // 元素定位
              uid: Type.Optional(Type.String({ description: "Element uid (from snapshot). Used by click/type/fill/hover/drag." })),
              selector: Type.Optional(Type.String({ description: "CSS selector (when there is no uid)." })),
              // 文本输入
              text: Type.Optional(Type.String({ maxLength: 4000, description: "Input text for type / fill." })),
              fields: Type.Optional(
                Type.Array(
                  Type.Object({
                    uid: Type.Optional(Type.String()),
                    selector: Type.Optional(Type.String()),
                    text: Type.String(),
                  }),
                  {
                    description:
                      "Only for action=fill: batch-fill multiple fields to write the whole form in one call (e.g. login). Each item is {uid|selector, text}; with submit:true it also submits.",
                  },
                ),
              ),
              perCharacter: Type.Optional(Type.Boolean({ description: "Type character by character (slower but closer to a human)." })),
              pressEnter: Type.Optional(Type.Boolean({ description: "Press Enter after type." })),
              submit: Type.Optional(Type.Boolean({ description: "Submit the enclosing form after fill." })),
              includeSnapshot: Type.Optional(Type.Boolean({ description: "Attach a fresh snapshot after click." })),
              waitFor: Type.Optional(
                Type.Object(
                  {
                    url: Type.Optional(Type.String({ description: "URL regex; waiting ends as soon as it matches." })),
                    selector: Type.Optional(Type.String({ description: "CSS selector; waiting ends as soon as it appears." })),
                    timeout: Type.Optional(Type.Number({ description: "Max wait in milliseconds (default 5000)." })),
                  },
                  {
                    description:
                      'Optional: after the action, wait until the condition holds before returning (applies to click/type/fill/press_key/navigate), collapsing "act → wait for result" into one call. e.g. {url:"/home"}.',
                  },
                ),
              ),
              // 按键
              key: Type.Optional(Type.String({ description: "Key name for press_key, e.g. Enter/Tab/Escape/ArrowDown/a." })),
              ctrlKey: Type.Optional(Type.Boolean()),
              altKey: Type.Optional(Type.Boolean()),
              shiftKey: Type.Optional(Type.Boolean()),
              metaKey: Type.Optional(Type.Boolean()),
              // 滚动
              deltaX: Type.Optional(Type.Number()),
              deltaY: Type.Optional(Type.Number()),
              // 快照选项
              mode: Type.Optional(
                Type.Union(
                  [
                    Type.Literal("auto"),
                    Type.Literal("interactive"),
                    Type.Literal("forms"),
                    Type.Literal("text"),
                  ],
                  {
                    description:
                      'Snapshot mode. "text" additionally returns the whole page body text (## 页面全文), which is the safe way to read tables/lists/long content instead of evaluate. Default auto.',
                  },
                ),
              ),
              maxElements: Type.Optional(Type.Number({ minimum: 1, maximum: 400 })),
              containingText: Type.Optional(Type.String({ description: "Return only elements whose label text contains this string." })),
              roleFilter: Type.Optional(Type.String({ description: "Return only elements with this role/tag name, e.g. button." })),
              delta: Type.Optional(
                Type.Boolean({
                  description:
                    "Only for action=snapshot: return a structured diff against the last snapshot (element added/removed/changed / form value changed / text changed / focus / navigation); " +
                    "when the page did not substantively change, output a condensed form (omit the element list to save context). Suited to polling scenarios like \"act once and see if anything reacts\". Default false.",
                }),
              ),
              excludeOccluded: Type.Optional(
                Type.Boolean({
                  description:
                    "Only for action=snapshot: omit nodes whose center is covered by an overlay (occluded-by-*), reporting only an occludedSkipped count in the result. " +
                    "Use it to filter out hidden forms/duplicate controls masked by an overlay. Default false (keep them and mark [occluded-by-…]).",
                }),
              ),
              // 截图选项
              format: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg")])),
              quality: Type.Optional(Type.Number({ minimum: 0, maximum: 100, description: "JPEG quality 0-100." })),
              force: Type.Optional(
                Type.Boolean({
                  description:
                    "Only for action=screenshot: force-return the image even if it is byte-identical to the previous screenshot of the same page. By default an identical screenshot is skipped (text only) to save context. Default false.",
                }),
              ),
              // 求值
              expression: Type.Optional(Type.String({ maxLength: 4000, description: "JS expression for evaluate." })),
              // get_cookie 会话探活
              probe: Type.Optional(
                Type.Boolean({
                  description:
                    "Only for action=get_cookie: whether to make a side-effect-free GET probe to the site to judge whether the session has expired (default true). Returns valid=yes/no/unknown.",
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
              paths: Type.Optional(Type.Array(Type.String(), { description: "Array of absolute local paths for upload." })),
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
