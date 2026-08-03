# Pi Packages 管理 UI — 开发文档

> 为 pi-desktop 桌面壳添加 Pi 扩展包（Packages）的浏览、搜索、安装、卸载功能，对标 VS Code 扩展商店。

---

## 1. 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│  Renderer                                                    │
│  ┌────────────┐  ┌──────────────┐  ┌─────────────────────┐  │
│  │  Sidebar   │  │ PackagesPage │  │ PackageStore        │  │
│  │ +nav item  │──│ (header+tabs)│──│ (Zustand)           │  │
│  └────────────┘  │   ┌────────┐ │  │ packages/loading/   │  │
│                  │   │Market  │ │  │ installed/search/    │  │
│                  │   │(浏览)  │ │  │ fetchCatalog/        │  │
│                  │   │Installed│ │  │ install/uninstall   │  │
│                  │   │(已安装)│ │  └─────────────────────┘  │
│                  │   └────────┘ │           │               │
│                  └──────────────┘    window.piDesk.*        │
└─────────────────────────────────────────────────────────────┘
                        │  IPC (invoke)
┌───────────────────────▼─────────────────────────────────────┐
│  Main Process                                                │
│  ┌──────────────────┐  ┌──────────────────────────────────┐ │
│  │ ipc-handlers.ts  │  │ pi/package-manager.ts            │ │
│  │ pi:listPackages  │──│ • searchNpmPackages(keyword)     │ │
│  │ pi:installPkg    │  │ • getInstalledPackages()         │ │
│  │ pi:removePkg     │  │ • installPackage(source)         │ │
│  │ pi:getInstalled  │  │ • removePackage(source)          │ │
│  └──────────────────┘  │ • getCatalog()                   │ │
│                        └──────────────────────────────────┘ │
│                                    │                        │
│                           child_process.execFile             │
│                           npm registry API                   │
│                           ~/.pi/agent/settings.json          │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. 数据来源调研

### 2.1 包目录（Marketplace）

**方案 A：npm registry 搜索（推荐）**

所有 Pi packages 以 `pi-package` 为 keyword 发布到 npm：

```
GET https://registry.npmjs.org/-/v1/search?text=keywords:pi-package&size=50
```

返回格式示例：
```json
{
  "objects": [
    {
      "package": {
        "name": "pi-subagents",
        "version": "0.38.0",
        "description": "Delegate tasks to sub-agents...",
        "keywords": ["pi-package", "pi-extension"],
        "links": { "npm": "...", "repository": "github.com/..." },
        "publisher": { "username": "..." },
        "date": "2026-07-..."
      },
      "downloads": { "monthly": 166400 }
    }
  ],
  "total": 40
}
```

**方案 B：pi.dev 官方目录（可选增强）**

抓取 `https://pi.dev/packages` 页面，但官方目录依赖 npm 的 `pi-package` keyword，数据本质同源。

> **决定**：优先方案 A，npm registry 稳定、有下载量。

### 2.2 已安装包列表

读取 `~/.pi/agent/settings.json`（全局）和 `.pi/settings.json`（项目级）：

```json
{
  "packages": [
    "npm:simple-pkg",
    { "source": "git:github.com/user/repo@v1" },
    { "source": "/absolute/local/path" }
  ]
}
```

可以混合字符串（简写）和对象（带过滤配置）。

### 2.3 安装 / 卸载

执行 Pi CLI：

```bash
# 安装
pi install npm:@scope/pkg@1.0.0
pi install git:github.com/user/repo@v1

# 移除
pi remove npm:@scope/pkg
```

`pi` 命令本身会写 `settings.json`，所以我们不需要手动操作配置文件。

### 2.4 安装位置

```
全局：~/.pi/agent/npm/ 或 ~/.pi/agent/git/<host>/<path>
项目：.pi/npm/ 或 .pi/git/<host>/<path>
```

我们在 UI 中让用户选择全局安装还是项目级安装（`pi install` vs `pi install -l`）。

---

## 3. 详细实现

### 3.1 主进程：`src/main/pi/package-manager.ts`

**新建文件**。负责：
- 从 npm registry 搜索/获取包列表
- 读取已安装包
- 执行 pi CLI 安装/卸载

```ts
// src/main/pi/package-manager.ts

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR
  || join(homedir(), ".pi", "agent");

const NPM_SEARCH_URL =
  "https://registry.npmjs.org/-/v1/search?text=keywords:pi-package&size=50";

// ── 类型定义 ──

export interface PiPackageInfo {
  /** npm 包名 */
  name: string;
  /** 简短描述 */
  description: string;
  /** 最新版本 */
  version: string;
  /** 作者 */
  author: string;
  /** 月下载量 */
  monthlyDownloads: number;
  /** 更新时间 (ISO) */
  updatedAt: string;
  /** GitHub / npm 链接 */
  repository: string;
  npmUrl: string;
  /** 安装源格式："npm:<name>" */
  source: string;
}

export interface InstalledPackage {
  source: string;        // "npm:pi-subagents" / "git:github.com/..." / 本地路径
  name: string;          // 展示名
  scope: "global" | "project";
}

// ── npm registry 搜索 ──

export async function searchNpmPackages(
  keyword?: string
): Promise<PiPackageInfo[]> {
  let url = NPM_SEARCH_URL;
  if (keyword) {
    // 追加 keyword 过滤
    url += `&text=${encodeURIComponent(`${keyword} keywords:pi-package`)}`;
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`npm registry returned ${res.status}`);
  }
  const data = await res.json() as {
    objects: Array<{
      package: {
        name: string;
        version: string;
        description?: string;
        keywords?: string[];
        date: string;
        links?: { npm?: string; repository?: string };
        publisher?: { username?: string };
      };
      downloads?: { monthly?: number };
    }>;
  };

  return (data.objects ?? []).map((obj) => ({
    name: obj.package.name,
    description: obj.package.description ?? "",
    version: obj.package.version,
    author: obj.package.publisher?.username ?? "",
    monthlyDownloads: obj.downloads?.monthly ?? 0,
    updatedAt: obj.package.date,
    repository: obj.package.links?.repository ?? "",
    npmUrl: obj.package.links?.npm ?? `https://www.npmjs.com/package/${obj.package.name}`,
    source: `npm:${obj.package.name}`,
  }));
}

// ── 已安装包列表 ──

export async function getInstalledPackages(): Promise<{
  global: InstalledPackage[];
  project: InstalledPackage[];
}> {
  const global = await readInstalledFromSettings(
    join(PI_AGENT_DIR, "settings.json")
  );
  // 项目级暂时不做，预留接口
  return { global, project: [] };
}

async function readInstalledFromSettings(
  path: string
): Promise<InstalledPackage[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return [];
  }
  let settings: { packages?: Array<string | { source: string }> };
  try {
    settings = JSON.parse(raw);
  } catch {
    return [];
  }

  return (settings.packages ?? []).map((entry) => {
    const source = typeof entry === "string" ? entry : entry.source;
    // 从 source 提取展示名："npm:pi-subagents" → "pi-subagents"
    const name = source.replace(/^npm:/, "").replace(/^git:/, "");
    return { source, name, scope: "global" as const };
  });
}

// ── 安装 / 卸载 ──

export async function installPackage(
  source: string,
  scope: "global" | "project" = "global"
): Promise<{ ok: boolean; message: string }> {
  const args = ["install", source];
  if (scope === "project") args.push("-l");

  return execPi(args);
}

export async function removePackage(
  source: string,
  scope: "global" | "project" = "global"
): Promise<{ ok: boolean; message: string }> {
  const args = ["remove", source];
  if (scope === "project") args.push("-l");

  return execPi(args);
}

function execPi(
  args: string[]
): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    execFile("pi", args, { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, message: stderr || err.message });
      } else {
        resolve({ ok: true, message: stdout.trim() || "ok" });
      }
    });
  });
}
```

---

### 3.2 IPC 注册：`src/main/ipc-handlers.ts`

在 `registerIpcHandlers` 函数中追加：

```ts
import {
  searchNpmPackages,
  getInstalledPackages,
  installPackage,
  removePackage,
} from "./pi/package-manager";

// 追加在 registerIpcHandlers 函数体内 ↓

// ── Pi Packages ──
ipcMain.handle("pi:searchPackages", async (_, { keyword }) => {
  try {
    return { ok: true, packages: await searchNpmPackages(keyword) };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("pi:getInstalledPackages", async () => {
  try {
    return { ok: true, ...await getInstalledPackages() };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("pi:installPackage", async (_, { source, scope }) => {
  return await installPackage(source, scope);
});

ipcMain.handle("pi:removePackage", async (_, { source, scope }) => {
  return await removePackage(source, scope);
});
```

---

### 3.3 Preload：`src/preload/index.ts`

在 `piAPI` 对象中追加：

```ts
// ── Pi Packages ──
searchPackages: (keyword?: string) =>
  ipcRenderer.invoke("pi:searchPackages", { keyword }),
getInstalledPackages: () =>
  ipcRenderer.invoke("pi:getInstalledPackages"),
installPackage: (source: string, scope?: "global" | "project") =>
  ipcRenderer.invoke("pi:installPackage", { source, scope }),
removePackage: (source: string, scope?: "global" | "project") =>
  ipcRenderer.invoke("pi:removePackage", { source, scope }),
```

---

### 3.4 类型声明：`src/preload/api.d.ts`

追加接口类型：

```ts
// ── Pi Packages ──

export interface PiPackageInfo {
  name: string;
  description: string;
  version: string;
  author: string;
  monthlyDownloads: number;
  updatedAt: string;
  repository: string;
  npmUrl: string;
  source: string;
}

export interface InstalledPackage {
  source: string;
  name: string;
  scope: "global" | "project";
}

// 在 PiDeskAPI 接口中追加：
export interface PiDeskAPI {
  // ... 已有方法 ...

  // Pi Packages
  searchPackages(keyword?: string): Promise<{
    ok: boolean;
    packages?: PiPackageInfo[];
    error?: string;
  }>;
  getInstalledPackages(): Promise<{
    ok: boolean;
    global: InstalledPackage[];
    project: InstalledPackage[];
    error?: string;
  }>;
  installPackage(
    source: string,
    scope?: "global" | "project"
  ): Promise<{ ok: boolean; message: string }>;
  removePackage(
    source: string,
    scope?: "global" | "project"
  ): Promise<{ ok: boolean; message: string }>;
}
```

---

### 3.5 Zustand Store：`src/renderer/store/package-store.ts`

**新建文件**：

```ts
// src/renderer/store/package-store.ts

import { create } from "zustand";
import type { PiPackageInfo, InstalledPackage } from "../../preload/api";

export type PackagesView = "marketplace" | "installed";

interface PackageState {
  // ── 目录（marketplace） ──
  catalog: PiPackageInfo[];
  catalogLoading: boolean;
  catalogError: string | null;
  searchKeyword: string;

  // ── 已安装 ──
  installed: InstalledPackage[];
  installedLoading: boolean;

  // ── UI 状态 ──
  activeView: PackagesView;
  installPending: Record<string, boolean>;  // source → loading
  error: string | null;

  // ── Actions ──
  search: (keyword?: string) => Promise<void>;
  loadInstalled: () => Promise<void>;
  install: (source: string) => Promise<void>;
  remove: (source: string) => Promise<void>;
  setSearchKeyword: (kw: string) => void;
  setActiveView: (view: PackagesView) => void;
  clearError: () => void;
}

export const usePackageStore = create<PackageState>((set, get) => ({
  catalog: [],
  catalogLoading: false,
  catalogError: null,
  searchKeyword: "",
  installed: [],
  installedLoading: false,
  activeView: "marketplace",
  installPending: {},
  error: null,

  search: async (keyword) => {
    set({ catalogLoading: true, catalogError: null, searchKeyword: keyword ?? "" });
    try {
      const res = await window.piDesk.searchPackages(keyword || undefined);
      if (res.ok) {
        set({ catalog: res.packages ?? [] });
      } else {
        set({ catalogError: res.error ?? "搜索失败" });
      }
    } catch (err: any) {
      set({ catalogError: err.message ?? "网络错误" });
    } finally {
      set({ catalogLoading: false });
    }
  },

  loadInstalled: async () => {
    set({ installedLoading: true });
    try {
      const res = await window.piDesk.getInstalledPackages();
      if (res.ok) {
        set({ installed: [...res.global, ...res.project] });
      }
    } catch (err) {
      console.error("Failed to load installed packages:", err);
    } finally {
      set({ installedLoading: false });
    }
  },

  install: async (source) => {
    // 设置 pending 状态
    set((s) => ({
      installPending: { ...s.installPending, [source]: true },
    }));
    try {
      const res = await window.piDesk.installPackage(source);
      if (!res.ok) {
        set({ error: res.message });
      }
    } catch (err: any) {
      set({ error: err.message ?? "安装失败" });
    } finally {
      // 刷新已安装列表
      await get().loadInstalled();
      set((s) => {
        const next = { ...s.installPending };
        delete next[source];
        return { installPending: next };
      });
    }
  },

  remove: async (source) => {
    set((s) => ({
      installPending: { ...s.installPending, [source]: true },
    }));
    try {
      const res = await window.piDesk.removePackage(source);
      if (!res.ok) {
        set({ error: res.message });
      }
    } catch (err: any) {
      set({ error: err.message ?? "卸载失败" });
    } finally {
      await get().loadInstalled();
      set((s) => {
        const next = { ...s.installPending };
        delete next[source];
        return { installPending: next };
      });
    }
  },

  setSearchKeyword: (kw) => set({ searchKeyword: kw }),
  setActiveView: (view) => set({ activeView: view }),
  clearError: () => set({ error: null }),
}));
```

---

### 3.6 组件：`src/renderer/packages/PackagesPage.tsx`

**新建文件**。页面包装器 — header + view 切换 + 内容区：

```tsx
// src/renderer/packages/PackagesPage.tsx

import { useTranslation } from "../../i18n/useTranslation";
import { useUIStore } from "../store/ui-store";
import { usePackageStore } from "../store/package-store";
import { Package, Download, RefreshCw, X } from "lucide-react";
import MarketplacePanel from "./MarketplacePanel";
import InstalledPanel from "./InstalledPanel";
import styles from "./PackagesPage.module.css";

export default function PackagesPage() {
  const { t } = useTranslation();
  const setMainView = useUIStore((s) => s.setMainView);
  const activeView = usePackageStore((s) => s.activeView);
  const setActiveView = usePackageStore((s) => s.setActiveView);
  const search = usePackageStore((s) => s.search);
  const loadInstalled = usePackageStore((s) => s.loadInstalled);

  const handleClose = () => setMainView("chat");

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <Package size={18} className={styles.titleIcon} />
          <h1 className={styles.title}>{t("packages.title")}</h1>
          <span className={styles.subtitle}>{t("packages.subtitle")}</span>
        </div>
        <div className={styles.headerActions}>
          {/* Tab 切换：市场 / 已安装 */}
          <div className={styles.tabs}>
            <button
              className={`${styles.tab} ${activeView === "marketplace" ? styles.tabActive : ""}`}
              onClick={() => {
                setActiveView("marketplace");
                if (usePackageStore.getState().catalog.length === 0) search();
              }}
            >
              <Download size={14} />
              <span>{t("packages.marketplace")}</span>
            </button>
            <button
              className={`${styles.tab} ${activeView === "installed" ? styles.tabActive : ""}`}
              onClick={() => {
                setActiveView("installed");
                loadInstalled();
              }}
            >
              <RefreshCw size={14} />
              <span>{t("packages.installed")}</span>
            </button>
          </div>
          <button className={styles.closeBtn} onClick={handleClose} title={t("close")}>
            <X size={16} />
          </button>
        </div>
      </header>

      <div className={styles.contentBody}>
        {activeView === "marketplace" ? <MarketplacePanel /> : <InstalledPanel />}
      </div>
    </div>
  );
}
```

---

### 3.7 组件：`src/renderer/packages/MarketplacePanel.tsx`

**新建文件**。包市场 — 搜索 + 卡片列表：

```tsx
// src/renderer/packages/MarketplacePanel.tsx

import { useEffect, useMemo, useCallback } from "react";
import { useTranslation } from "../../i18n/useTranslation";
import { usePackageStore } from "../store/package-store";
import PackageCard from "./PackageCard";
import type { PiPackageInfo } from "../../../preload/api";
import styles from "./PackagesPage.module.css";

export default function MarketplacePanel() {
  const { t } = useTranslation();
  const catalog = usePackageStore((s) => s.catalog);
  const loading = usePackageStore((s) => s.catalogLoading);
  const error = usePackageStore((s) => s.catalogError);
  const searchKeyword = usePackageStore((s) => s.searchKeyword);
  const setSearchKeyword = usePackageStore((s) => s.setSearchKeyword);
  const search = usePackageStore((s) => s.search);

  // 首次加载
  useEffect(() => {
    if (catalog.length === 0 && !loading) {
      search();
    }
  }, []);

  // 搜索防抖
  const handleSearch = useCallback(
    (kw: string) => {
      setSearchKeyword(kw);
      search(kw);
    },
    [search, setSearchKeyword]
  );

  // 按下载量排序
  const sorted = useMemo(
    () => [...catalog].sort((a, b) => b.monthlyDownloads - a.monthlyDownloads),
    [catalog]
  );

  return (
    <div className={styles.panel}>
      {/* 搜索框 */}
      <div className={styles.searchBar}>
        <input
          className={styles.searchInput}
          type="text"
          placeholder={t("packages.searchPlaceholder")}
          value={searchKeyword}
          onChange={(e) => handleSearch(e.target.value)}
        />
      </div>

      {/* 列表 */}
      {loading ? (
        <div className={styles.loading}>{t("packages.loading")}</div>
      ) : error ? (
        <div className={styles.error}>{error}</div>
      ) : sorted.length === 0 ? (
        <div className={styles.empty}>{t("packages.empty")}</div>
      ) : (
        <div className={styles.cardList}>
          {sorted.map((pkg) => (
            <PackageCard key={pkg.name} pkg={pkg} />
          ))}
        </div>
      )}
    </div>
  );
}
```

---

### 3.8 组件：`src/renderer/packages/InstalledPanel.tsx`

**新建文件**。已安装包列表：

```tsx
// src/renderer/packages/InstalledPanel.tsx

import { useEffect } from "react";
import { useTranslation } from "../../i18n/useTranslation";
import { usePackageStore } from "../store/package-store";
import PackageCard from "./PackageCard";
import styles from "./PackagesPage.module.css";

export default function InstalledPanel() {
  const { t } = useTranslation();
  const installed = usePackageStore((s) => s.installed);
  const loading = usePackageStore((s) => s.installedLoading);
  const loadInstalled = usePackageStore((s) => s.loadInstalled);

  useEffect(() => {
    loadInstalled();
  }, [loadInstalled]);

  return (
    <div className={styles.panel}>
      {loading ? (
        <div className={styles.loading}>{t("packages.loading")}</div>
      ) : installed.length === 0 ? (
        <div className={styles.empty}>{t("packages.noInstalled")}</div>
      ) : (
        <div className={styles.cardList}>
          {installed.map((pkg) => (
            <PackageCard key={pkg.source} pkg={pkg} showUninstall />
          ))}
        </div>
      )}
    </div>
  );
}
```

---

### 3.9 组件：`src/renderer/packages/PackageCard.tsx`

**新建文件**。单张包卡片 — 在市场和已安装列表中共用：

```tsx
// src/renderer/packages/PackageCard.tsx

import { Download, Trash2, ExternalLink, Loader2 } from "lucide-react";
import { usePackageStore } from "../store/package-store";
import type { PiPackageInfo, InstalledPackage } from "../../../preload/api";
import styles from "./PackagesPage.module.css";

interface Props {
  pkg: PiPackageInfo | InstalledPackage;
  showUninstall?: boolean;
}

// 判断是否为市场包（有完整信息）
function isPiPackageInfo(pkg: any): pkg is PiPackageInfo {
  return "version" in pkg && "monthlyDownloads" in pkg;
}

function formatDownloads(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

export default function PackageCard({ pkg, showUninstall }: Props) {
  const install = usePackageStore((s) => s.install);
  const remove = usePackageStore((s) => s.remove);
  const installPending = usePackageStore((s) => s.installPending);

  const isInstalling = installPending[pkg.source ?? (pkg as PiPackageInfo).source] ?? false;

  // 已安装包（InstalledPackage）
  if (!isPiPackageInfo(pkg)) {
    return (
      <div className={styles.card}>
        <div className={styles.cardBody}>
          <div className={styles.cardIcon}>
            <Download size={18} />
          </div>
          <div className={styles.cardInfo}>
            <div className={styles.cardName}>{pkg.name}</div>
            <div className={styles.cardSource}>{pkg.source}</div>
          </div>
        </div>
        {showUninstall && (
          <button
            className={styles.installBtn}
            onClick={() => remove(pkg.source)}
            disabled={isInstalling}
          >
            {isInstalling ? <Loader2 size={14} className={styles.spin} /> : <Trash2 size={14} />}
            <span>卸载</span>
          </button>
        )}
      </div>
    );
  }

  // 市场包（PiPackageInfo）
  const p = pkg as PiPackageInfo;
  return (
    <div className={styles.card}>
      <div className={styles.cardBody}>
        <div className={styles.cardIcon}>
          <Download size={18} />
        </div>
        <div className={styles.cardInfo}>
          <div className={styles.cardName}>{p.name}</div>
          <div className={styles.cardDesc}>{p.description}</div>
          <div className={styles.cardMeta}>
            <span>v{p.version}</span>
            {p.monthlyDownloads > 0 && <span>{formatDownloads(p.monthlyDownloads)}/月</span>}
            {p.author && <span>{p.author}</span>}
          </div>
        </div>
      </div>
      <div className={styles.cardActions}>
        <button
          className={styles.installBtn}
          onClick={() => install(p.source)}
          disabled={isInstalling}
        >
          {isInstalling ? <Loader2 size={14} className={styles.spin} /> : <Download size={14} />}
          <span>安装</span>
        </button>
        {p.npmUrl && (
          <a
            className={styles.linkBtn}
            href={p.npmUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="npm"
          >
            <ExternalLink size={14} />
          </a>
        )}
      </div>
    </div>
  );
}
```

---

### 3.10 样式：`src/renderer/packages/PackagesPage.module.css`

**新建文件**。参照 SettingsPage 的 CSS 模式：

```css
/* src/renderer/packages/PackagesPage.module.css */

.page {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-primary);
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid var(--border-neutral-l1);
  flex-shrink: 0;
}

.titleBlock {
  display: flex;
  align-items: center;
  gap: 10px;
}

.titleIcon {
  color: var(--accent);
}

.title {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

.subtitle {
  font-size: 13px;
  color: var(--text-secondary);
}

.headerActions {
  display: flex;
  align-items: center;
  gap: 16px;
}

.tabs {
  display: flex;
  background: var(--bg-secondary);
  border-radius: 8px;
  padding: 3px;
}

.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text-secondary);
  background: transparent;
  transition: all 0.15s;
}

.tab:hover {
  color: var(--text-primary);
}

.tabActive {
  background: var(--bg-primary);
  color: var(--text-primary);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.closeBtn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  color: var(--text-secondary);
  background: transparent;
}

.closeBtn:hover {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.contentBody {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

.panel {
  max-width: 720px;
  margin: 0 auto;
}

/* 搜索栏 */
.searchBar {
  margin-bottom: 20px;
}

.searchInput {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid var(--border-neutral-l1);
  border-radius: 10px;
  font-size: 14px;
  background: var(--bg-primary);
  color: var(--text-primary);
  outline: none;
  transition: border-color 0.15s;
}

.searchInput:focus {
  border-color: var(--accent);
}

.searchInput::placeholder {
  color: var(--text-tertiary);
}

/* 卡片列表 */
.cardList {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 卡片 */
.card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  min-height: 56px;
  border: 1px solid var(--border-neutral-l1);
  border-radius: 10px;
  background: var(--bg-primary);
  transition: border-color 0.15s;
}

.card:hover {
  border-color: var(--border-neutral-l2);
}

.cardBody {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
}

.cardIcon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--accent);
  flex-shrink: 0;
}

.cardInfo {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.cardName {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.cardDesc {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cardMeta {
  display: flex;
  gap: 12px;
  font-size: 11px;
  color: var(--text-tertiary);
}

.cardSource {
  font-size: 11px;
  color: var(--text-tertiary);
  font-family: monospace;
}

.cardActions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.installBtn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: transparent;
  color: var(--accent);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.installBtn:hover:not(:disabled) {
  background: var(--accent);
  color: #fff;
}

.installBtn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.linkBtn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--border-neutral-l1);
  border-radius: 6px;
  color: var(--text-secondary);
  background: transparent;
  cursor: pointer;
}

.linkBtn:hover {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

/* 加载/空/错误状态 */
.loading,
.empty,
.error {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 60px 0;
  color: var(--text-tertiary);
  font-size: 14px;
}

.error {
  color: var(--danger);
}

/* 旋转动画 */
.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
```

---

### 3.11 侧边栏导航：`src/renderer/layout/Sidebar.tsx`

在 `NavKey`、`NAV_ITEMS`、`handleNavClick` 三处追加：

```tsx
// 1. 导入图标
import { Package } from "lucide-react";

// 2. NavKey 联合类型追加
type NavKey = "chat" | "agents" | "projects" | "skills" | "automate" | "packages" | "settings";

// 3. NAV_ITEMS 数组追加
const NAV_ITEMS: NavItem[] = [
  // ... 已有项 ...
  { key: "packages", icon: Package, labelKey: "nav.packages" },
  { key: "settings", icon: Settings, labelKey: "nav.settings" },
];

// 4. handleNavClick 中追加
const handleNavClick = (key: NavKey) => {
  setActiveNav(key);
  if (key === "settings") {
    setMainView("settings");
  } else if (key === "skills") {
    setMainView("skills");
  } else if (key === "automate") {
    setMainView("automate");
  } else if (key === "packages") {
    setMainView("packages");        // ← 新增
  } else {
    setMainView("chat");
  }
};
```

---

### 3.12 主视图路由：`src/renderer/layout/MainPanel.tsx`

追加条件渲染：

```tsx
// 1. 导入
import PackagesPage from "../packages/PackagesPage";

// 2. 在视图渲染链中追加
// 位置：{mainView === "automate" ? <AutomatePage /> : null} 之后
{mainView === "packages" ? <PackagesPage /> : null}
```

---

### 3.13 UI Store：`src/renderer/store/ui-store.ts`

```tsx
// mainView 类型联合追加 "packages"
mainView: "chat" | "settings" | "skills" | "automate" | "packages";
```

---

### 3.14 i18n 翻译

在翻译文件中追加（中/英）：

```ts
// zh-CN
{
  "nav.packages": "扩展",
  "packages.title": "Pi 扩展",
  "packages.subtitle": "浏览和安装社区扩展",
  "packages.marketplace": "市场",
  "packages.installed": "已安装",
  "packages.searchPlaceholder": "搜索扩展...",
  "packages.loading": "加载中...",
  "packages.empty": "没有找到匹配的扩展",
  "packages.noInstalled": "你还未安装任何扩展"
}

// en
{
  "nav.packages": "Extensions",
  "packages.title": "Pi Extensions",
  "packages.subtitle": "Browse and install community extensions",
  "packages.marketplace": "Marketplace",
  "packages.installed": "Installed",
  "packages.searchPlaceholder": "Search extensions...",
  "packages.loading": "Loading...",
  "packages.empty": "No extensions found",
  "packages.noInstalled": "No extensions installed yet"
}
```

---

## 4. 实现步骤

| 步骤 | 文件 | 操作 |
|------|------|------|
| 1 | `src/main/pi/package-manager.ts` | **新建** — 后端逻辑 |
| 2 | `src/main/ipc-handlers.ts` | **修改** — 追加 4 个 IPC handler |
| 3 | `src/preload/api.d.ts` | **修改** — 追加类型声明 |
| 4 | `src/preload/index.ts` | **修改** — 追加 preload API |
| 5 | `src/renderer/store/package-store.ts` | **新建** — Zustand store |
| 6 | `src/renderer/packages/PackagesPage.tsx` | **新建** — Page 包装器 |
| 7 | `src/renderer/packages/MarketplacePanel.tsx` | **新建** — 市场列表 |
| 8 | `src/renderer/packages/InstalledPanel.tsx` | **新建** — 已安装列表 |
| 9 | `src/renderer/packages/PackageCard.tsx` | **新建** — 卡片组件 |
| 10 | `src/renderer/packages/PackagesPage.module.css` | **新建** — 样式 |
| 11 | `src/renderer/store/ui-store.ts` | **修改** — mainView 追加 "packages" |
| 12 | `src/renderer/layout/Sidebar.tsx` | **修改** — 追加导航项 |
| 13 | `src/renderer/layout/MainPanel.tsx` | **修改** — 追加路由 |
| 14 | i18n 翻译文件 | **修改** — 追加翻译 key |

---

## 5. 包详情弹窗（后期增强）

当前设计提供了基础浏览 + 安装功能。后期可增加：

- **PackageDetailModal**：点击卡片展开详情（README 渲染、依赖项、安装量趋势）
- **版本选择**：安装指定版本（`pi install npm:pkg@1.0.0`）
- **类别筛选**：按 extension / skill / prompt / theme 分类
- **Git 安装**：UI 输入 git URL 安装私有仓库的包
- **本地路径安装**：文件对话框选本地目录安装
- **安装进度通知**：安装过程较长时 toast 提示
