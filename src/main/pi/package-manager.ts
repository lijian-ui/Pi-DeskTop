import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

/**
 * Pi Packages 管理（主进程）。
 *
 * 市场数据来自 npm registry（keyword: pi-package）；安装/卸载/已安装列表
 * 直接复用 SDK 的 DefaultPackageManager（installAndPersist / removeAndPersist /
 * listConfiguredPackages），无需 `pi` CLI，也不用手动写 settings.json。
 *
 * 首期只做全局安装（per-session 工作区模型没有"当前项目"概念，项目级 `-l`
 * 留待后续）：包写入 ~/.pi/agent/settings.json 并下载到 ~/.pi/agent/npm/。
 */

export interface PiPackageInfo {
  name: string;
  description: string;
  version: string;
  author: string;
  monthlyDownloads: number;
  updatedAt: string;
  repository: string;
  npmUrl: string;
  /** 安装源："npm:<name>" */
  source: string;
  /** npm keywords（含 pi-extension / pi-skill / pi-prompt / pi-theme，用于类别筛选） */
  keywords: string[];
}

export interface InstalledPackage {
  source: string;
  /** 展示名（去掉 npm:/git: 前缀） */
  name: string;
  scope: "global" | "project";
}

/** 详情页数据：packument + 下载量 API 聚合（对标 pi.dev 详情页）。 */
export interface PiPackageDetail extends PiPackageInfo {
  license: string;
  /** 最新版发布时间（ISO） */
  publishedAt: string;
  /** 解包体积（字节） */
  unpackedSize: number;
  dependencyCount: number;
  peerDependencyCount: number;
  downloadsWeek: number;
  homepage: string;
  /** README 全文（npm packument 的 readme 字段） */
  readme: string;
}

/** Global-only package manager. cwd 只影响项目级配置，这里用 chat 兜底目录。 */
function createPackageManager(): DefaultPackageManager {
  const agentDir = getAgentDir();
  const cwd = join(agentDir, "chat");
  const settingsManager = SettingsManager.create(cwd, agentDir);
  return new DefaultPackageManager({ cwd, agentDir, settingsManager });
}

// ── npm registry 搜索（市场，分页） ──

export interface SearchResult {
  packages: PiPackageInfo[];
  /** npm 搜索总匹配数（用于"是否有更多"判断） */
  total: number;
}

export async function searchNpmPackages(
  keyword?: string,
  from = 0,
  size = 50,
  category?: string,
): Promise<SearchResult> {
  // 类别筛选放服务端：category → keywords:pi-<cat>（"all" 用 pi-package；
  // "package"（其他）无对应关键字，退回 pi-package 后由客户端过滤类型）。
  const base =
    category && category !== "all" && category !== "package"
      ? `keywords:pi-${category}`
      : "keywords:pi-package";
  // 有关键字时与类别关键字拼接（不能出现两个 text 参数，registry 会 400）
  const text = keyword && keyword.trim()
    ? `${keyword.trim()} ${base}`
    : base;
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(
    text,
  )}&size=${size}&from=${from}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`npm registry returned ${res.status}`);
  }
  const data = (await res.json()) as {
    objects: Array<{
      package: {
        name: string;
        version: string;
        description?: string;
        date: string;
        links?: { npm?: string; repository?: string };
        publisher?: { username?: string };
        keywords?: string[];
      };
      downloads?: { monthly?: number };
    }>;
    total?: number;
  };

  const packages = (data.objects ?? []).map((obj) => ({
    name: obj.package.name,
    description: obj.package.description ?? "",
    version: obj.package.version,
    author: obj.package.publisher?.username ?? "",
    monthlyDownloads: obj.downloads?.monthly ?? 0,
    updatedAt: obj.package.date,
    repository: obj.package.links?.repository ?? "",
    npmUrl: obj.package.links?.npm ?? `https://www.npmjs.com/package/${obj.package.name}`,
    source: `npm:${obj.package.name}`,
    keywords: obj.package.keywords ?? [],
  }));

  return { packages, total: data.total ?? packages.length };
}

// ── 包详情（packument + 下载量 API，对标 pi.dev 详情页） ──

/** npm downloads API：月/周下载量（并行两个 point 请求）。 */
async function fetchDownloads(name: string): Promise<{ month: number; week: number }> {
  const [m, w] = await Promise.all([
    fetch(`https://api.npmjs.org/downloads/point/last-month/${name}`),
    fetch(`https://api.npmjs.org/downloads/point/last-week/${name}`),
  ]);
  const mj = m.ok ? ((await m.json().catch(() => ({}))) as { downloads?: number }) : {};
  const wj = w.ok ? ((await w.json().catch(() => ({}))) as { downloads?: number }) : {};
  return { month: mj.downloads ?? 0, week: wj.downloads ?? 0 };
}

export async function getPackageDetail(name: string): Promise<PiPackageDetail> {
  const [packumentRes, downloads] = await Promise.all([
    fetch(`https://registry.npmjs.org/${name}`),
    fetchDownloads(name),
  ]);
  if (!packumentRes.ok) {
    throw new Error(`npm registry returned ${packumentRes.status}`);
  }
  const pack = (await packumentRes.json()) as any;
  const version = pack["dist-tags"]?.latest ?? "";
  const pkgJson = (pack.versions?.[version] ?? pack) as any;
  const author =
    typeof pkgJson.author === "string"
      ? pkgJson.author
      : (pkgJson.author?.name ?? pack.maintainers?.[0]?.name ?? "");
  const license =
    typeof pkgJson.license === "string"
      ? pkgJson.license
      : (pkgJson.license?.type ?? "");
  const repository =
    typeof pkgJson.repository === "string"
      ? pkgJson.repository
      : (pkgJson.repository?.url ?? "");
  const publishedAt = pack.time?.[version] ?? "";

  return {
    name,
    description: pkgJson.description ?? "",
    version,
    author,
    license,
    publishedAt,
    unpackedSize: pkgJson.dist?.unpackedSize ?? 0,
    dependencyCount: Object.keys(pkgJson.dependencies ?? {}).length,
    peerDependencyCount: Object.keys(pkgJson.peerDependencies ?? {}).length,
    monthlyDownloads: downloads.month,
    downloadsWeek: downloads.week,
    updatedAt: publishedAt,
    repository,
    homepage: pkgJson.homepage ?? "",
    npmUrl: `https://www.npmjs.com/package/${name}`,
    source: `npm:${name}`,
    keywords: pkgJson.keywords ?? [],
    readme: typeof pack.readme === "string" ? pack.readme : "",
  };
}

// ── 已安装列表 ──

export async function getInstalledPackages(): Promise<InstalledPackage[]> {
  const configured = createPackageManager().listConfiguredPackages();
  // 首期只展示全局（scope: user）。
  return configured
    .filter((p) => p.scope === "user")
    .map((p) => ({
      source: p.source,
      name: p.source.replace(/^npm:/, "").replace(/^git:/, ""),
      scope: "global" as const,
    }));
}

// ── 安装 / 卸载（全局） ──

export async function installPackage(
  source: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    await createPackageManager().installAndPersist(source, { local: false });
    return { ok: true, message: `installed: ${source}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }
}

export async function removePackage(
  source: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const ok = await createPackageManager().removeAndPersist(source, {
      local: false,
    });
    return ok
      ? { ok: true, message: `removed: ${source}` }
      : { ok: false, message: `not found: ${source}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }
}

// ── 更新检查 / 更新（检查后由用户决定是否执行） ──

export interface PackageUpdateInfo {
  source: string;
  /** 展示名（去掉 npm:/git: 前缀） */
  name: string;
  type: "npm" | "git";
  scope: "user" | "project";
}

/** 检查已配置包有哪些可更新（SDK 对比已装版本 vs 最新；pinned/本地源跳过）。 */
export async function checkForPackageUpdates(): Promise<PackageUpdateInfo[]> {
  const updates = await createPackageManager().checkForAvailableUpdates();
  return updates.map((u) => ({
    source: u.source,
    name: u.displayName,
    type: u.type,
    scope: u.scope,
  }));
}

/** 更新单个包（按 source 匹配）。 */
export async function updatePackage(
  source: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    await createPackageManager().update(source);
    return { ok: true, message: `updated: ${source}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }
}
