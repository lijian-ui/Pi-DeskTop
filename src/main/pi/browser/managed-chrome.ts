/**
 * Managed Chrome — pi-desktop 自建一个 Chrome 实例（OpenClaw 同款思路）。
 *
 * 现在**只有这一条路**（2026-09-22 起，附着"用户日常 Chrome"的那条已随浏览器扩展一起移除）。
 * 自建实例用 `--headless=new` + 独立 profile：
 *  - 过程**完全不可见**（没有窗口），不打扰用户
 *  - 渲染正常 → **截图/看图稳定**
 *  - 登录态存在**独立持久 profile** 里（`<agentDir>/browser-profile`），跨次启动保留
 *  - 与用户的日常浏览器**完全隔离**，不需要在浏览器里装任何扩展
 *
 * 首次登录：把 `managed.headless` 设为 false（或用 browser({action:"window", windowAction:"show"})）
 * 打开**可见窗口**，用户扫码/短信验证登录；登录完切回 headless 即可，profile 复用。
 */
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readBrowserConfigSync, type BrowserConfig } from "./browser-config";
import { managedProfileDir } from "./paths";
import { decorateManagedProfile, ensureProfileCleanExit } from "./profile-decoration";

interface ManagedChromeState {
  child?: ChildProcess;
  headless?: boolean;
  launchedAt?: number;
  executablePath?: string;
}

export interface ManagedChromeResult {
  /** 本次是否**新启动/重启**了实例（用于判断要不要等 CDP 重连）。 */
  launchedAt?: number;
  running: boolean;
  headless?: boolean;
  executablePath?: string;
  profileDir: string;
  /** 托管 Chrome 的 CDP 调试端口（主进程用 playwright-core 直连）。 */
  cdpPort: number;
}

const holder = globalThis as unknown as { __piDeskManagedChrome?: ManagedChromeState };

function state(): ManagedChromeState {
  return (holder.__piDeskManagedChrome ??= {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 探测 Chrome/Edge 可执行文件（覆盖非标准安装位置 + PATH 兜底）。 */
export function findChromeExecutable(override?: string): string | undefined {
  if (override && existsSync(override)) return override;
  const candidates: string[] = [];
  const programFiles = process.env["ProgramFiles"];
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  const localAppData = process.env["LOCALAPPDATA"];
  const home = process.env["USERPROFILE"] ?? process.env["HOME"];

  // Chrome 常见子目录。注意 `Bin` 不是笔误：部分部署把 chrome.exe 放在
  // `%LOCALAPPDATA%\Google\Chrome\Bin\`（本机实测就是这种），而非常见的 `Application`。
  const chromeSubdirs = [
    "Google/Chrome/Application",
    "Google/Chrome/Bin",
    "Google/Chrome Beta/Application",
    "Google/Chrome Dev/Application",
    "Google/Chrome SxS/Application",
  ];
  for (const root of [programFiles, programFilesX86, localAppData]) {
    if (!root) continue;
    for (const sub of chromeSubdirs) {
      candidates.push(join(root, ...sub.split("/"), "chrome.exe"));
    }
  }
  // Edge（含 per-user 安装）
  for (const root of [programFiles, programFilesX86, localAppData]) {
    if (!root) continue;
    candidates.push(join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
  }
  // macOS / Linux
  candidates.push(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  );
  if (home) candidates.push(join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // PATH 兜底：where (Windows) / which (POSIX)
  return lookupInPath(["chrome.exe", "chrome", "google-chrome", "msedge.exe", "msedge"]);
}

function lookupInPath(names: string[]): string | undefined {
  const finder = process.platform === "win32" ? "where" : "which";
  for (const name of names) {
    try {
      const output = execFileSync(finder, [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const first = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (first && existsSync(first)) return first;
    } catch {
      // 未找到，继续下一个
    }
  }
  return undefined;
}

export function stopManagedChrome(): void {
  const current = state();
  const child = current.child;
  current.child = undefined;
  current.headless = undefined;
  current.launchedAt = undefined;
  if (!child || child.killed) return;
  try {
    child.kill();
  } catch {
    // 已退出
  }
}

export function managedChromeInfo(): {
  running: boolean;
  external?: boolean;
  headless?: boolean;
  executablePath?: string;
  profileDir: string;
  launchedAt?: number;
  cdpPort: number;
} {
  const current = state();
  const owned = Boolean(current.child && !current.child.killed);
  let cdpPort = 17319;
  try {
    cdpPort = readBrowserConfigSync().managed.cdpPort;
  } catch {
    // 配置缺失用默认
  }
  return {
    // 判定"在跑"仅看本进程子进程句柄（CDP 模式下不再依赖扩展轮询探活）。
    running: owned,
    external: owned ? undefined : undefined,
    headless: current.headless,
    executablePath: current.executablePath,
    profileDir: managedProfileDir(),
    launchedAt: current.launchedAt,
    cdpPort,
  };
}

/**
 * 结束**遗留**的托管 Chrome（上次运行未收尾，句柄已丢）。
 *
 * 特征取 `--user-data-dir` 里的托管 profile 路径 —— 只有我们的托管实例会带它，
 * 用户日常 Chrome 不可能命中，因此不会误杀。
 * best-effort：安全软件/权限问题下失败即返回 false，由调用方降级为"复用或报错"。
 */
function tryKillOrphanManagedChrome(): Promise<boolean> {
  const marker = managedProfileDir();
  const command =
    process.platform === "win32"
      ? "powershell"
      : "pkill";
  const args =
    process.platform === "win32"
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
            `Where-Object { $_.CommandLine -like '*${marker}*' } | ` +
            `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
        ]
      : ["-f", marker];
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 8_000 }, (error) => {
      if (error) console.warn("[browser] 清理遗留托管 Chrome 失败：", error.message);
      resolve(!error);
    });
  });
}

/**
 * 确保托管 Chrome 以目标模式（headless / headed）运行；模式不一致则重启。
 * 已运行且模式一致时**不做事**（返回 launchedAt === undefined）。
 */
export async function ensureManagedChrome(headless: boolean, cfg: BrowserConfig): Promise<ManagedChromeResult> {
  const current = state();
  const alive = Boolean(current.child && !current.child.killed);
  const cdpPort = cfg.managed.cdpPort || 17319;

  if (alive && current.headless === headless) {
    return {
      running: true,
      headless,
      executablePath: current.executablePath,
      profileDir: managedProfileDir(),
      cdpPort,
    };
  }

  if (!alive) {
    // 没有进程句柄 → 同 profile 上若还有 chrome 在跑，那就是**遗留实例**（上次未收尾，
    // 或主进程刚重启）。必须结束它，否则随后 spawn 的进程会被 Chrome 单例「交接」后立即退出。
    // 按进程命令行（`--user-data-dir` 特征）判断结束，该特征只属于我们的托管实例，不会误杀日常 Chrome。
    console.log("[browser] 无本地句柄：清理同 profile 的遗留托管实例（若有）…");
    await tryKillOrphanManagedChrome();
    await sleep(1_200);
  }

  if (alive) {
    // 模式切换（headless ↔ headed）：运行中的实例无法原地生效 → 重启。
    stopManagedChrome();
    await sleep(500);
  }

  const executablePath = findChromeExecutable(cfg.managed.executablePath);
  if (!executablePath) {
    throw new Error(
      "找不到 Chrome（或 Edge）可执行文件。请在 browser-config.json 的 managed.executablePath 填写 chrome.exe 的绝对路径。",
    );
  }
  const profileDir = managedProfileDir();
  // 启动前修饰 profile（best-effort）：橙色+命名标识，避免用户误认；并清掉上次 kill
  // 留下的"异常退出"标记，免得每次 show/hide 重启都弹「恢复页面？」气泡。
  try {
    ensureProfileCleanExit(profileDir);
    decorateManagedProfile(profileDir);
  } catch {
    // Chrome 的 pref 键各版本不一，失败不影响启动。
  }
  // CDP 直连（OpenClaw 同款）：主进程用 playwright-core 连这个端口，无需扩展。
  // `--remote-debugging-port` 让 Chrome 暴露 DevTools 协议；主进程侧 `connectOverCDP` 即可驱控。
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${cdpPort}`,
    "--no-first-run",
    "--no-default-browser-check",
    // 双保险：就算 Local State 仍残留 Crashed 标记，也不弹「恢复页面？」气泡
    // （该气泡会触发崩溃恢复模式，导致启动变慢）。
    "--hide-crash-restore-bubble",
    "--window-size=1280,900",
    // Chrome 112+ 的新 headless：渲染正常（截图可靠）、无窗口（完全不可见）。
    ...(headless ? ["--headless=new"] : []),
    ...cfg.managed.extraArgs,
  ];

  const child = spawn(executablePath, args, { stdio: "ignore", windowsHide: false });
  child.on("exit", () => {
    const s = state();
    if (s.child === child) {
      s.child = undefined;
      s.headless = undefined;
      s.launchedAt = undefined;
    }
  });
  child.on("error", () => {
    const s = state();
    if (s.child === child) s.child = undefined;
  });

  // Chrome 是**单例**：同一 --user-data-dir 已有实例在跑时，新进程会把启动请求
  // 「交接」给旧实例并**立即退出**。这种交接我们拿不到可控句柄，若不识别就会：
  // 误判启动成功 → 句柄失效 → hide/show 切换静默无效、状态错乱。
  // 因此短暂等待后若发现已退出，回滚状态并明确报错。
  await sleep(1200);
  if (child.exitCode !== null || child.killed) {
    current.child = undefined;
    current.headless = undefined;
    current.launchedAt = undefined;
    throw new Error(
      `托管 Chrome 启动后立即退出：同一个 profile 目录（${profileDir}）已有 Chrome 实例在运行（Chrome 单例限制），` +
        `且未能自动结束它（可能是安全软件拦了进程清理）。请手动关闭那个托管 Chrome 窗口（橙色「Pi 自动化」）后重新调用。`,
    );
  }

  const launchedAt = Date.now();
  current.child = child;
  current.headless = headless;
  current.executablePath = executablePath;
  current.launchedAt = launchedAt;

  registerQuitHook();
  return { launchedAt, running: true, headless, executablePath, profileDir, cdpPort };
}

let quitHookRegistered = false;
function registerQuitHook(): void {
  if (quitHookRegistered) return;
  quitHookRegistered = true;
  void import("electron")
    .then(({ app }) => {
      app.on("before-quit", () => stopManagedChrome());
    })
    .catch(() => {
      // 非 Electron 环境（如单测）忽略
    });
}
