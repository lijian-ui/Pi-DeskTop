import { useEffect } from "react";
import { Download, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUIStore } from "../store/ui-store";
import { usePackageStore } from "../store/package-store";
import MarketplacePanel from "./MarketplacePanel";
import InstalledPanel from "./InstalledPanel";
import PackageDetailModal from "./PackageDetailModal";
import UpdateModal from "./UpdateModal";
import PackageToasts from "./PackageToasts";
import styles from "./PackagesPage.module.css";

/** Pi 扩展商店：头部（标题 + 市场/已安装 tab 切换）+ 内容区。 */
export default function PackagesPage() {
  const { t } = useTranslation();
  const setMainView = useUIStore((s) => s.setMainView);
  const activeView = usePackageStore((s) => s.activeView);
  const setActiveView = usePackageStore((s) => s.setActiveView);
  const catalog = usePackageStore((s) => s.catalog);
  const search = usePackageStore((s) => s.search);
  const loadInstalled = usePackageStore((s) => s.loadInstalled);

  // 挂载即拉取已安装列表：市场页的"安装/已安装"按钮状态依赖它
  useEffect(() => {
    loadInstalled();
  }, [loadInstalled]);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <Download size={18} className={styles.titleIcon} />
          <h1 className={styles.title}>{t("packages.title")}</h1>
          <span className={styles.subtitle}>{t("packages.subtitle")}</span>
        </div>
        <div className={styles.headerActions}>
          <div className={styles.tabs}>
            <button
              className={`${styles.tab} ${activeView === "marketplace" ? styles.tabActive : ""}`}
              onClick={() => {
                setActiveView("marketplace");
                if (catalog.length === 0) search();
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
          <button
            className={styles.closeBtn}
            onClick={() => setMainView("chat")}
            title={t("close")}
          >
            <X size={16} />
          </button>
        </div>
      </header>

      <div className={styles.contentBody}>
        {activeView === "marketplace" ? <MarketplacePanel /> : <InstalledPanel />}
      </div>

      {/* 详情弹窗挂公共父级：市场/已安装两个 tab 下都能弹出 */}
      <PackageDetailModal />
      {/* 更新确认弹窗 */}
      <UpdateModal />
      {/* 安装/卸载进度 toast */}
      <PackageToasts />
    </div>
  );
}
