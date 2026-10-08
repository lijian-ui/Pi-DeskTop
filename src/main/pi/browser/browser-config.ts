/**
 * Browser config — read/write of `browser-config.json` (agent dir).
 *
 * 与 `todo-config.json` / `websearch-config.json` 同目录（`getAgentDir()`）。
 * 扩展工厂读 `enabled`（关 → 不注册任何工具）；execute 里会重读，改了不用重启。
 *
 * ⚠️ 写配置必须「读-改-写」整对象（参照 tool-catalog.ts 对 web-search 的处理），
 *    禁止用裸 `{ enabled }` 覆盖，否则会冲掉 allowedDomains / screenshot 等字段。
 */
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface BrowserScreenshotConfig {
  enabled: boolean;
  format: "png" | "jpeg";
  quality: number;
}

/**
 * 动作级门禁配置（fail-closed，详见 `browser-guard.ts`）。
 *
 * 分层：`auth.ts` 管「能不能用浏览器」，`allowedDomains` 管「能去哪些站点」，
 * 本段管「进了站之后哪些动作允许」。
 *
 * ⚠️ 这里锁住的三类操作，**都能被网页里的一段文字诱导 AI 去执行**（提示注入），
 * 且都**无法用普通点击/输入替代**（所以锁它们不是刁难、是真拦得住）：
 *   - 在你已登录的页面里跑任意代码 → 可读取并外发页面全部数据
 *   - 上传本机文件 → 可把本机上的任意文件交给网页
 *   - 按浏览器快捷键（Ctrl+W 等）→ 可关标签、清数据
 * 它们**不会打扰用户**（只是静默拒绝并告诉 AI 原因），需要时在这里显式放开。
 */
export interface BrowserGuardConfig {
  /** 允许 `upload` 上传本机文件（默认 **false**）。 */
  allowLocalFileUpload: boolean;
  /** 允许 `evaluate` 在页面上下文执行任意 JS（默认 **false**）。 */
  allowEvaluate: boolean;
  /** 允许 `press_key` 使用 ctrl/meta/alt 组合键（默认 **false**）。 */
  allowKeyCombos: boolean;
}

function defaultGuardConfig(): BrowserGuardConfig {
  return {
    allowLocalFileUpload: false,
    allowEvaluate: false,
    allowKeyCombos: false,
  };
}

export interface BrowserManagedConfig {
  /** true = `--headless=new`（完全不可见）；false = 可见窗口（首次登录/扫码用）。 */
  headless: boolean;
  /** Chrome/Edge 可执行文件绝对路径；空 = 自动探测。 */
  executablePath: string;
  /** 追加启动参数（escape hatch）。 */
  extraArgs: string[];
  /**
   * 托管 Chrome 的 **CDP 调试端口**：启动时带 `--remote-debugging-port`，
   * 主进程用 playwright-core 直连，**无需安装任何浏览器扩展**。
   */
  cdpPort: number;
}

export interface BrowserConfig {
  /** 总开关。默认 **false**（安全默认：需显式开启）。 */
  enabled: boolean;
  /** managed 模式的启动参数。 */
  managed: BrowserManagedConfig;
  /** 后台静默：不主动抢焦点/激活标签。默认 **true**。 */
  background: boolean;
  /**
   * 定时任务（无人值守）下是否允许浏览器操作，默认 **true**；allowedDomains 为可选额外收窄。
   * 默认放开是为了「定时任务开箱即用」：总开关 `enabled` 仍默认 false（用户须在设置里显式授权），
   * 三类高危动作（upload / evaluate / 组合键）也仍是 fail-closed，故该默认值不构成静默越权。
   * 需要收紧时在配置里显式写 false。
   */
  allowUnattended: boolean;
  /**
   * 无人值守下是否单独放行**只读**动作（tabs / snapshot / screenshot），默认 **true**。
   * 与 allowUnattended 分层：读操作不改页面、无副作用 —— 当 allowUnattended 被显式收紧为 false 时，
   * 仍可单独保留只读能力（巡检类定时任务「只看不点」）。写操作仍由 allowUnattended 管辖。
   */
  allowUnattendedRead: boolean;
  /** 业务系统域名白名单。空数组 = 不限制（生产强烈建议填）。 */
  allowedDomains: string[];
  /** 黑名单（优先于白名单）。 */
  blockedDomains: string[];
  screenshot: BrowserScreenshotConfig;
  /** 动作级门禁（fail-closed）。缺省 = 四类高危动作全关 + 新站点需确认。 */
  guard: BrowserGuardConfig;
}

const BROWSER_CONFIG_FILE = "browser-config.json";

function defaultConfig(): BrowserConfig {
  return {
    enabled: false,
    managed: { headless: true, executablePath: "", extraArgs: [], cdpPort: 17319 },
    background: true,
    allowUnattended: true,
    allowUnattendedRead: true,
    allowedDomains: [],
    blockedDomains: [],
    screenshot: { enabled: true, format: "png", quality: 80 },
    guard: defaultGuardConfig(),
  };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

function normalize(raw: unknown): BrowserConfig {
  const base = defaultConfig();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const shot = (r.screenshot && typeof r.screenshot === "object" ? r.screenshot : {}) as Record<string, unknown>;
  const managed = (r.managed && typeof r.managed === "object" ? r.managed : {}) as Record<string, unknown>;
  const guard = (r.guard && typeof r.guard === "object" ? r.guard : {}) as Record<string, unknown>;
  return {
    enabled: r.enabled === true,
    managed: {
      headless: managed.headless !== false,
      executablePath: typeof managed.executablePath === "string" ? managed.executablePath : "",
      extraArgs: asStringArray(managed.extraArgs),
      cdpPort: typeof managed.cdpPort === "number" && managed.cdpPort > 0 ? managed.cdpPort : 17319,
    },
    background: r.background !== false,
    // 默认放开：缺字段 = true（`!== false`），只有显式写 false 才收紧。
    // （与 guard 三项的「严格 === true 才放开」相反：那三项是高危动作，必须 fail-closed。）
    allowUnattended: r.allowUnattended !== false,
    allowUnattendedRead: r.allowUnattendedRead !== false,
    allowedDomains: asStringArray(r.allowedDomains),
    blockedDomains: asStringArray(r.blockedDomains),
    screenshot: {
      enabled: shot.enabled !== false,
      format: shot.format === "jpeg" ? "jpeg" : "png",
      quality: typeof shot.quality === "number" ? Math.min(100, Math.max(0, shot.quality)) : base.screenshot.quality,
    },
    // ⚠️ 三项高危动作一律「严格等于 true 才放开」（缺字段 / 写错类型 / 笔误 → 保持拒绝）。
    guard: {
      allowLocalFileUpload: guard.allowLocalFileUpload === true,
      allowEvaluate: guard.allowEvaluate === true,
      allowKeyCombos: guard.allowKeyCombos === true,
    },
  };
}

export function readBrowserConfigSync(): BrowserConfig {
  try {
    // 先剥掉 UTF-8 BOM：Windows 记事本「另存为 UTF-8」会写入 BOM，而 JSON.parse 对 BOM
    // 直接抛错 → 被下面 catch 吞掉 → 静默回退默认值（enabled 变回 false，浏览器工具整个消失）。
    const text = readFileSync(configPath(), "utf-8").replace(/^\uFEFF/, "");
    return normalize(JSON.parse(text));
  } catch {
    return defaultConfig();
  }
}

export async function writeBrowserConfig(patch: Partial<BrowserConfig>): Promise<void> {
  const current = readBrowserConfigSync();
  const next: BrowserConfig = {
    ...current,
    ...patch,
    screenshot: { ...current.screenshot, ...(patch.screenshot ?? {}) },
    guard: { ...current.guard, ...(patch.guard ?? {}) },
  };
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2), "utf-8");
}

function configPath(): string {
  return join(getAgentDir(), BROWSER_CONFIG_FILE);
}
