import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, ChevronDown } from "lucide-react";
import { usePackageStore, type PackageCategory } from "../store/package-store";
import type { PiPackageInfo } from "../../preload/api";
import PackageCard from "./PackageCard";
import styles from "./PackagesPage.module.css";

/** 类别筛选（按 npm keywords 中的 pi-* 类型标签；主题包已在 store 全局剥离，不提供入口）。 */
const CATEGORIES: Array<{ key: PackageCategory; labelKey: string }> = [
  { key: "all", labelKey: "packages.catAll" },
  { key: "extension", labelKey: "packages.catExtension" },
  { key: "skill", labelKey: "packages.catSkill" },
  { key: "prompt", labelKey: "packages.catPrompt" },
  { key: "package", labelKey: "packages.catPackage" },
];

const TYPE_KEYWORDS = ["pi-extension", "pi-skill", "pi-prompt", "pi-theme"];

function matchCategory(pkg: PiPackageInfo, cat: PackageCategory): boolean {
  if (cat === "all") return true;
  const kws = pkg.keywords ?? [];
  if (cat === "package") {
    return !kws.some((k) => TYPE_KEYWORDS.includes(k));
  }
  return kws.includes(`pi-${cat}`);
}

/** 包市场：搜索框 + 按下载量排序的卡片列表（无限滚动翻页）。 */
export default function MarketplacePanel() {
  const { t } = useTranslation();
  const catalog = usePackageStore((s) => s.catalog);
  const loading = usePackageStore((s) => s.catalogLoading);
  const error = usePackageStore((s) => s.catalogError);
  const searchKeyword = usePackageStore((s) => s.searchKeyword);
  const setSearchKeyword = usePackageStore((s) => s.setSearchKeyword);
  const search = usePackageStore((s) => s.search);
  const loadMore = usePackageStore((s) => s.loadMore);
  const loadingMore = usePackageStore((s) => s.loadingMore);
  const total = usePackageStore((s) => s.total);
  const category = usePackageStore((s) => s.category);
  const setCategory = usePackageStore((s) => s.setCategory);

  const sentinelRef = useRef<HTMLDivElement>(null);

  // 首次进入自动拉取市场
  useEffect(() => {
    if (catalog.length === 0 && !loading) {
      search();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 滚动触底自动加载下一页
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: "200px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [loadMore, catalog.length]);

  // 按下载量排序
  const sorted = useMemo(
    () => [...catalog].sort((a, b) => b.monthlyDownloads - a.monthlyDownloads),
    [catalog],
  );

  // 类别筛选（客户端过滤已加载目录）
  const filtered = useMemo(
    () => sorted.filter((p) => matchCategory(p, category)),
    [sorted, category],
  );

  const hasMore = catalog.length < total;

  return (
    <div className={styles.panel}>
      <div className={styles.searchBar}>
        <input
          className={styles.searchInput}
          type="text"
          placeholder={t("packages.searchPlaceholder")}
          value={searchKeyword}
          onChange={(e) => {
            const kw = e.target.value;
            setSearchKeyword(kw);
            search(kw);
          }}
        />
      </div>

      <div className={styles.filterRow}>
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            type="button"
            className={`${styles.filterChip} ${category === c.key ? styles.filterChipActive : ""}`}
            onClick={() => setCategory(c.key)}
          >
            {t(c.labelKey)}
          </button>
        ))}
      </div>

      {total > 0 && !loading && (
        <div className={styles.resultMeta}>{t("packages.resultCount", { n: total })}</div>
      )}

      {loading ? (
        <div className={styles.loading}>{t("packages.loading")}</div>
      ) : error ? (
        <div className={styles.error}>{error}</div>
      ) : filtered.length === 0 ? (
        <div className={styles.empty}>{t("packages.empty")}</div>
      ) : (
        <>
          <div className={styles.cardList}>
            {filtered.map((pkg) => (
              <PackageCard key={pkg.name} pkg={pkg} />
            ))}
          </div>

          {/* 触底哨兵 + 手动加载更多兜底 */}
          <div ref={sentinelRef} className={styles.loadMoreArea}>
            {loadingMore ? (
              <span className={styles.loadMoreHint}>
                <Loader2 size={14} className={styles.spin} />
                {t("packages.loading")}
              </span>
            ) : hasMore ? (
              <button
                type="button"
                className={styles.loadMoreBtn}
                onClick={loadMore}
              >
                <ChevronDown size={14} />
                {t("packages.loadMore")}
              </button>
            ) : (
              <span className={styles.loadMoreHint}>{t("packages.allLoaded")}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
