import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  X,
  Download,
  ExternalLink,
  Globe,
  Github,
  Loader2,
} from "lucide-react";
import Markdown from "../chat/Markdown";
import { usePackageStore } from "../store/package-store";
import styles from "./PackagesPage.module.css";

function formatBytes(n: number): string {
  if (!n) return "-";
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function formatDownloads(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function formatDate(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString();
}

/** 包详情弹窗：对标 pi.dev 详情页（完整元信息 + README）。 */
export default function PackageDetailModal() {
  const { t } = useTranslation();
  const detailName = usePackageStore((s) => s.detailName);
  const detail = usePackageStore((s) => s.detail);
  const detailLoading = usePackageStore((s) => s.detailLoading);
  const detailError = usePackageStore((s) => s.detailError);
  const installPending = usePackageStore((s) => s.installPending);
  const installed = usePackageStore((s) => s.installed);
  const closeDetail = usePackageStore((s) => s.closeDetail);
  const install = usePackageStore((s) => s.install);

  useEffect(() => {
    if (!detailName) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDetail();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailName, closeDetail]);

  if (!detailName) return null;

  const p = detail;
  const pending = p ? installPending[p.source] ?? false : false;
  const isInstalled = p ? installed.some((i) => i.source === p.source) : false;

  const metaItems: Array<{ label: string; value: string }> = p
    ? [
        { label: t("packages.version"), value: p.version },
        { label: t("packages.published"), value: formatDate(p.publishedAt) },
        { label: t("packages.author"), value: p.author || "-" },
        { label: t("packages.license"), value: p.license || "-" },
        { label: t("packages.size"), value: formatBytes(p.unpackedSize) },
        {
          label: t("packages.deps"),
          value: `${p.dependencyCount} deps${p.peerDependencyCount ? ` · ${p.peerDependencyCount} peers` : ""}`,
        },
        { label: t("packages.downloads"), value: formatDownloads(p.monthlyDownloads) },
        { label: t("packages.downloadsWeek"), value: formatDownloads(p.downloadsWeek) },
      ]
    : [];

  return (
    <div className={styles.detailOverlay} onClick={closeDetail}>
      <div
        className={styles.detailModal}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.detailHeader}>
          <div className={styles.detailTitleBlock}>
            <h2 className={styles.detailTitle}>{detailName}</h2>
            {p && <span className={styles.detailVersion}>v{p.version}</span>}
          </div>
          <button
            type="button"
            className={styles.detailClose}
            onClick={closeDetail}
            title={t("close")}
          >
            <X size={16} />
          </button>
        </div>

        {detailLoading ? (
          <div className={styles.detailLoading}>
            <Loader2 size={18} className={styles.spin} />
            <span>{t("packages.loading")}</span>
          </div>
        ) : detailError ? (
          <div className={styles.detailError}>{detailError}</div>
        ) : p ? (
          <>
            <div className={styles.detailBody}>
              {p.description && (
                <p className={styles.detailDesc}>{p.description}</p>
              )}

              <div className={styles.detailMetaGrid}>
                {metaItems.map((item) => (
                  <div key={item.label} className={styles.detailMetaItem}>
                    <span className={styles.detailMetaLabel}>{item.label}</span>
                    <span className={styles.detailMetaValue}>{item.value}</span>
                  </div>
                ))}
              </div>

              <div className={styles.detailActions}>
                {isInstalled ? (
                  <button type="button" className={styles.installBtn} disabled>
                    <Download size={14} />
                    <span>{t("packages.installedBtn")}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className={styles.installBtn}
                    onClick={() => install(p.source)}
                    disabled={pending}
                  >
                    {pending ? (
                      <Loader2 size={14} className={styles.spin} />
                    ) : (
                      <Download size={14} />
                    )}
                    <span>{t("packages.install")}</span>
                  </button>
                )}
                {p.npmUrl && (
                  <a
                    className={styles.detailLink}
                    href={p.npmUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="npm"
                  >
                    <ExternalLink size={14} />
                    <span>npm</span>
                  </a>
                )}
                {p.homepage && (
                  <a
                    className={styles.detailLink}
                    href={p.homepage}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={t("packages.home")}
                  >
                    <Globe size={14} />
                    <span>{t("packages.home")}</span>
                  </a>
                )}
                {p.repository && (
                  <a
                    className={styles.detailLink}
                    href={p.repository}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="GitHub"
                  >
                    <Github size={14} />
                    <span>GitHub</span>
                  </a>
                )}
              </div>

              <div className={styles.detailReadme}>
                <h3 className={styles.detailReadmeTitle}>{t("packages.readme")}</h3>
                {p.readme ? (
                  <Markdown content={p.readme} />
                ) : (
                  <p className={styles.detailReadmeEmpty}>
                    {t("packages.noReadme")}
                  </p>
                )}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
