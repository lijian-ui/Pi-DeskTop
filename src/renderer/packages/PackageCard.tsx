import { Download, Trash2, ExternalLink, Loader2, CheckCircle2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePackageStore } from "../store/package-store";
import type { PiPackageInfo, InstalledPackage } from "../../preload/api";
import styles from "./PackagesPage.module.css";

interface Props {
  pkg: PiPackageInfo | InstalledPackage;
  showUninstall?: boolean;
}

/** 市场包（有完整信息）与已安装包（仅 source/name）的判别。 */
function isPiPackageInfo(pkg: PiPackageInfo | InstalledPackage): pkg is PiPackageInfo {
  return "version" in pkg && "monthlyDownloads" in pkg;
}

function formatDownloads(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString();
}

/** 单张扩展卡片：市场与已安装共用。市场卡片整卡可点击打开详情。 */
export default function PackageCard({ pkg, showUninstall }: Props) {
  const { t } = useTranslation();
  const install = usePackageStore((s) => s.install);
  const remove = usePackageStore((s) => s.remove);
  const installPending = usePackageStore((s) => s.installPending);
  const openDetail = usePackageStore((s) => s.openDetail);
  const installed = usePackageStore((s) => s.installed);

  const pending = installPending[pkg.source] ?? false;

  if (!isPiPackageInfo(pkg)) {
    // npm 源的已安装包可以点开详情（packument 存在）；git/本地源没有 npm
    // 包信息，保持不可点。
    const clickable = pkg.source.startsWith("npm:");
    return (
      <div
        className={`${styles.card} ${clickable ? styles.cardClickable : ""}`}
        onClick={clickable ? () => openDetail(pkg.name) : undefined}
      >
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
          <div className={styles.cardActions}>
            <button
              className={`${styles.installBtn} ${styles.installBtnDanger}`}
              onClick={(e) => {
                e.stopPropagation();
                remove(pkg.source);
              }}
              disabled={pending}
            >
              {pending ? <Loader2 size={14} className={styles.spin} /> : <Trash2 size={14} />}
              <span>{t("packages.uninstall")}</span>
            </button>
          </div>
        )}
      </div>
    );
  }

  const p = pkg as PiPackageInfo;
  const isInstalled = installed.some((i) => i.source === p.source);
  return (
    <div
      className={`${styles.card} ${styles.cardClickable}`}
      onClick={() => openDetail(p.name)}
    >
      <div className={styles.cardBody}>
        <div className={styles.cardIcon}>
          <Download size={18} />
        </div>
        <div className={styles.cardInfo}>
          <div className={styles.cardName}>{p.name}</div>
          <div className={styles.cardDesc}>{p.description}</div>
          <div className={styles.cardMeta}>
            <span>v{p.version}</span>
            {p.updatedAt && <span>{formatDate(p.updatedAt)}</span>}
            {p.author && <span>{p.author}</span>}
            {p.monthlyDownloads > 0 && (
              <span>{formatDownloads(p.monthlyDownloads)}/mo</span>
            )}
          </div>
        </div>
      </div>
      <div className={styles.cardActions}>
        <button
          className={styles.installBtn}
          onClick={(e) => {
            e.stopPropagation();
            if (!isInstalled) install(p.source);
          }}
          disabled={pending || isInstalled}
        >
          {pending ? (
            <Loader2 size={14} className={styles.spin} />
          ) : isInstalled ? (
            <CheckCircle2 size={14} />
          ) : (
            <Download size={14} />
          )}
          <span>{isInstalled ? t("packages.installedBtn") : t("packages.install")}</span>
        </button>
        {p.npmUrl && (
          <a
            className={styles.linkBtn}
            href={p.npmUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="npm"
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink size={14} />
          </a>
        )}
      </div>
    </div>
  );
}
