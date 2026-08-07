import { create } from "zustand";
import i18n from "../../shared/i18n";
import type {
  PiPackageInfo,
  PiPackageDetail,
  InstalledPackage,
  PackageUpdateInfo,
} from "../../preload/api";

export type PackagesView = "marketplace" | "installed";

export type PackageCategory = "all" | "extension" | "skill" | "prompt" | "package";

export interface ToastState {
  type: "info" | "success" | "error";
  text: string;
}

const PAGE_SIZE = 50;

/** 主题扩展包为 Pi TUI 专用，桌面端不生效 → 市场里完全剥离。 */
function stripThemePackages(pkgs: PiPackageInfo[]): PiPackageInfo[] {
  return pkgs.filter((p) => !(p.keywords ?? []).includes("pi-theme"));
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

interface PackageState {
  // ── 市场 ──
  catalog: PiPackageInfo[];
  catalogLoading: boolean;
  catalogError: string | null;
  searchKeyword: string;
  /** npm 总匹配数，用于"加载更多"判断 */
  total: number;
  loadingMore: boolean;
  /** 服务端已拉取条数（过滤掉主题包后与展示列表长度不同，翻页用它当 from） */
  serverOffset: number;
  /** 类别筛选（客户端过滤已加载目录） */
  category: PackageCategory;

  // ── 已安装 ──
  installed: InstalledPackage[];
  installedLoading: boolean;

  // ── 详情弹窗 ──
  detailName: string | null;
  detail: PiPackageDetail | null;
  detailLoading: boolean;
  detailError: string | null;

  // ── UI 状态 ──
  activeView: PackagesView;
  installPending: Record<string, boolean>;
  error: string | null;
  toast: ToastState | null;

  // ── 更新检查 ──
  updatesChecking: boolean;
  /** 可更新的包（检查结果，由用户决定是否更新） */
  pendingUpdates: PackageUpdateInfo[];
  updateModalOpen: boolean;

  // ── Actions ──
  search: (keyword?: string) => Promise<void>;
  loadMore: () => Promise<void>;
  loadInstalled: () => Promise<void>;
  openDetail: (name: string) => Promise<void>;
  closeDetail: () => void;
  checkUpdates: () => Promise<void>;
  closeUpdates: () => void;
  updateOne: (source: string) => Promise<void>;
  updateAll: () => Promise<void>;
  install: (source: string) => Promise<void>;
  remove: (source: string) => Promise<void>;
  setSearchKeyword: (kw: string) => void;
  setCategory: (cat: PackageCategory) => void;
  setActiveView: (view: PackagesView) => void;
  showToast: (type: ToastState["type"], text: string) => void;
  clearError: () => void;
}

export const usePackageStore = create<PackageState>((set, get) => ({
  catalog: [],
  catalogLoading: false,
  catalogError: null,
  searchKeyword: "",
  total: 0,
  loadingMore: false,
  serverOffset: 0,
  category: "all",
  installed: [],
  installedLoading: false,
  detailName: null,
  detail: null,
  detailLoading: false,
  detailError: null,
  activeView: "marketplace",
  installPending: {},
  error: null,
  toast: null,
  updatesChecking: false,
  pendingUpdates: [],
  updateModalOpen: false,

  search: async (keyword) => {
    set({
      catalogLoading: true,
      catalogError: null,
      searchKeyword: keyword ?? "",
      total: 0,
      serverOffset: 0,
    });
    try {
      const res = await window.piDesk.searchPackages(
        keyword || undefined,
        0,
        PAGE_SIZE,
        get().category,
      );
      if (res.ok) {
        set({
          catalog: stripThemePackages(res.packages ?? []),
          serverOffset: (res.packages ?? []).length,
          total: res.total ?? 0,
        });
      } else {
        set({ catalogError: res.error ?? "搜索失败" });
      }
    } catch (err) {
      set({ catalogError: err instanceof Error ? err.message : "网络错误" });
    } finally {
      set({ catalogLoading: false });
    }
  },

  loadMore: async () => {
    const { loadingMore, catalogLoading, catalog, total, searchKeyword, category, serverOffset } = get();
    if (loadingMore || catalogLoading || serverOffset >= total) return;
    set({ loadingMore: true });
    try {
      const res = await window.piDesk.searchPackages(
        searchKeyword || undefined,
        serverOffset,
        PAGE_SIZE,
        category,
      );
      if (res.ok) {
        const fetched = res.packages ?? [];
        const fresh = stripThemePackages(fetched);
        // 去重（npm 搜索翻页偶尔返回已见过的包）
        const seen = new Set(catalog.map((p) => p.name));
        const added = fresh.filter((p) => !seen.has(p.name));
        set({
          catalog: [...catalog, ...added],
          serverOffset: serverOffset + fetched.length,
          total: res.total ?? total,
        });
      } else {
        set({ error: res.error ?? "加载失败" });
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "加载失败" });
    } finally {
      set({ loadingMore: false });
    }
  },

  loadInstalled: async () => {
    set({ installedLoading: true });
    try {
      const res = await window.piDesk.getInstalledPackages();
      if (res.ok) {
        set({ installed: res.packages ?? [] });
      } else {
        set({ error: res.error ?? "加载失败" });
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "加载失败" });
    } finally {
      set({ installedLoading: false });
    }
  },

  openDetail: async (name) => {
    set({ detailName: name, detail: null, detailLoading: true, detailError: null });
    try {
      const res = await window.piDesk.getPackageDetail(name);
      if (res.ok) {
        set({ detail: res.detail ?? null });
      } else {
        set({ detailError: res.error ?? "加载失败" });
      }
    } catch (err) {
      set({ detailError: err instanceof Error ? err.message : "加载失败" });
    } finally {
      set({ detailLoading: false });
    }
  },

  closeDetail: () =>
    set({ detailName: null, detail: null, detailLoading: false, detailError: null }),

  checkUpdates: async () => {
    set({ updatesChecking: true });
    get().showToast("info", i18n.t("packages.checkingUpdates"));
    try {
      const res = await window.piDesk.checkPackageUpdates();
      if (res.ok) {
        const updates = res.updates ?? [];
        if (updates.length === 0) {
          get().showToast("success", i18n.t("packages.upToDate"));
        } else {
          set({ pendingUpdates: updates, updateModalOpen: true });
          get().showToast("info", i18n.t("packages.updatesFound", { n: updates.length }));
        }
      } else {
        get().showToast("error", i18n.t("packages.updateCheckFailed", { msg: res.error ?? "" }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "检查更新失败";
      get().showToast("error", i18n.t("packages.updateCheckFailed", { msg }));
    } finally {
      set({ updatesChecking: false });
    }
  },

  closeUpdates: () => set({ updateModalOpen: false, pendingUpdates: [] }),

  updateOne: async (source) => {
    const name = source.replace(/^npm:/, "").replace(/^git:/, "");
    get().showToast("info", i18n.t("packages.updating", { name }));
    try {
      const res = await window.piDesk.updatePackage(source);
      if (res.ok) {
        get().showToast("success", i18n.t("packages.updatedOk", { name }));
      } else {
        get().showToast("error", i18n.t("packages.updateFailed", { msg: res.message }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "更新失败";
      get().showToast("error", i18n.t("packages.updateFailed", { msg }));
    }
    // 从待更新列表移除并刷新已安装
    set((s) => ({
      pendingUpdates: s.pendingUpdates.filter((u) => u.source !== source),
    }));
    await get().loadInstalled();
    if (get().pendingUpdates.length === 0) {
      set({ updateModalOpen: false });
    }
  },

  updateAll: async () => {
    const sources = get().pendingUpdates.map((u) => u.source);
    if (sources.length === 0) return;
    for (const source of sources) {
      await get().updateOne(source);
    }
    if (get().pendingUpdates.length === 0) {
      set({ updateModalOpen: false });
      get().showToast("success", i18n.t("packages.updatedAll", { n: sources.length }));
    }
  },

  install: async (source) => {
    const name = source.replace(/^npm:/, "").replace(/^git:/, "");
    set((s) => ({
      installPending: { ...s.installPending, [source]: true },
      error: null,
    }));
    get().showToast("info", i18n.t("packages.installing", { name }));
    try {
      const res = await window.piDesk.installPackage(source);
      if (res.ok) {
        get().showToast("success", i18n.t("packages.installedOk", { name }));
      } else {
        set({ error: res.message });
        get().showToast("error", i18n.t("packages.installFailed", { msg: res.message }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "安装失败";
      set({ error: msg });
      get().showToast("error", i18n.t("packages.installFailed", { msg }));
    } finally {
      await get().loadInstalled();
      set((s) => {
        const next = { ...s.installPending };
        delete next[source];
        return { installPending: next };
      });
    }
  },

  remove: async (source) => {
    const name = source.replace(/^npm:/, "").replace(/^git:/, "");
    set((s) => ({
      installPending: { ...s.installPending, [source]: true },
      error: null,
    }));
    get().showToast("info", i18n.t("packages.uninstalling", { name }));
    try {
      const res = await window.piDesk.removePackage(source);
      if (res.ok) {
        get().showToast("success", i18n.t("packages.uninstalledOk", { name }));
      } else {
        set({ error: res.message });
        get().showToast("error", i18n.t("packages.uninstallFailed", { msg: res.message }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "卸载失败";
      set({ error: msg });
      get().showToast("error", i18n.t("packages.uninstallFailed", { msg }));
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
  setCategory: (cat) => {
    set({ category: cat });
    // 类别筛选在服务端生效 → 切换类别后立即按新类别重搜
    void get().search(get().searchKeyword);
  },
  setActiveView: (view) => set({ activeView: view }),
  showToast: (type, text) => {
    if (toastTimer) clearTimeout(toastTimer);
    set({ toast: { type, text } });
    toastTimer = setTimeout(() => {
      set({ toast: null });
      toastTimer = null;
    }, 3000);
  },
  clearError: () => set({ error: null }),
}));
