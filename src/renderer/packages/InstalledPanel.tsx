import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { GitBranch, Loader2, RefreshCw } from "lucide-react";
import { usePackageStore } from "../store/package-store";
import PackageCard from "./PackageCard";
import styles from "./PackagesPage.module.css";

/** 已安装扩展列表（全局）+ Git 源安装入口 + 检查更新。 */
export default function InstalledPanel() {
  const { t } = useTranslation();
  const installed = usePackageStore((s) => s.installed);
  const loading = usePackageStore((s) => s.installedLoading);
  const error = usePackageStore((s) => s.error);
  const loadInstalled = usePackageStore((s) => s.loadInstalled);
  const install = usePackageStore((s) => s.install);
  const installPending = usePackageStore((s) => s.installPending);
  const updatesChecking = usePackageStore((s) => s.updatesChecking);
  const checkUpdates = usePackageStore((s) => s.checkUpdates);

  const [gitSource, setGitSource] = useState("");

  useEffect(() => {
    loadInstalled();
  }, [loadInstalled]);

  const handleGitInstall = () => {
    let src = gitSource.trim();
    if (!src) return;
    // 裸地址（无源前缀）默认按 git 源处理
    if (!/^(npm:|git:|[a-zA-Z]:[\\/]|\/)/.test(src)) {
      src = `git:${src}`;
    }
    install(src);
    setGitSource("");
  };

  return (
    <div className={styles.panel}>
      {/* Git 源安装入口 */}
      <div className={styles.gitRow}>
        <input
          className={styles.gitInput}
          type="text"
          placeholder={t("packages.gitPlaceholder")}
          value={gitSource}
          onChange={(e) => setGitSource(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleGitInstall();
          }}
        />
        <button
          type="button"
          className={styles.installBtn}
          onClick={handleGitInstall}
          disabled={!gitSource.trim()}
        >
          <GitBranch size={14} />
          <span>{t("packages.gitInstallBtn")}</span>
        </button>
      </div>

      {/* 检查更新 */}
      <div className={styles.updateBar}>
        <button
          type="button"
          className={styles.installBtn}
          onClick={checkUpdates}
          disabled={updatesChecking}
        >
          {updatesChecking ? (
            <Loader2 size={14} className={styles.spin} />
          ) : (
            <RefreshCw size={14} />
          )}
          <span>{t("packages.checkUpdates")}</span>
        </button>
      </div>

      {loading ? (
        <div className={styles.loading}>{t("packages.loading")}</div>
      ) : error ? (
        <div className={styles.error}>{error}</div>
      ) : installed.length === 0 ? (
        <div className={styles.empty}>{t("packages.noInstalled")}</div>
      ) : (
        <div className={styles.cardList}>
          {installed.map((pkg) => (
            <PackageCard key={pkg.source} pkg={pkg} showUninstall />
          ))}
        </div>
      )}

      {Object.values(installPending).some(Boolean) && (
        <div className={styles.loadMoreArea}>
          <span className={styles.loadMoreHint}>
            <Loader2 size={14} className={styles.spin} />
            {t("packages.loading")}
          </span>
        </div>
      )}
    </div>
  );
}
