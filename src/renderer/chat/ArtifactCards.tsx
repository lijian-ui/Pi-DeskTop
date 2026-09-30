import { useEffect, useState } from "react";
import {
  ExternalLink,
  FileText,
  FileCode,
  FileSpreadsheet,
  Image,
  File,
  Files,
  ChevronRight,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUIStore } from "../store/ui-store";
import type { Artifact } from "../store/agent-store";
import styles from "./ArtifactCards.module.css";

// ── File-type icon mapping ───────────────────────────────────────────

const DOC_EXTS = new Set(["doc", "docx", "odt", "rtf"]);
const SHEET_EXTS = new Set(["xls", "xlsx", "csv", "ods"]);
const CODE_EXTS = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java",
  "c", "h", "cpp", "hpp", "cc", "cs",
  "php", "swift", "kt",
  "sh", "bash", "zsh", "ps1", "bat", "cmd",
  "css", "scss", "less",
  "html", "htm", "xml", "svg", "vue",
  "json", "yml", "yaml", "toml", "ini", "conf", "env",
  "sql", "md", "txt", "log",
]);
const IMG_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"]);

function extOf(p: string): string {
  const base = p.split(/[\\/]/).pop() || "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

function FileIcon({ filePath }: { filePath: string }) {
  const ext = extOf(filePath);
  if (IMG_EXTS.has(ext)) return <Image size={20} className={styles.iconImg} />;
  if (SHEET_EXTS.has(ext)) return <FileSpreadsheet size={20} className={styles.iconSheet} />;
  if (DOC_EXTS.has(ext)) return <FileText size={20} className={styles.iconDoc} />;
  if (CODE_EXTS.has(ext)) return <FileCode size={20} className={styles.iconCode} />;
  return <File size={20} className={styles.iconDefault} />;
}

// ── Size formatting ──────────────────────────────────────────────────

function formatSize(bytes: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Single card ──────────────────────────────────────────────────────

interface CardProps {
  artifact: Artifact;
}

function ArtifactCard({ artifact }: CardProps) {
  const { t } = useTranslation();
  const openFilePreview = useUIStore((s) => s.openFilePreview);
  const fileName = artifact.filePath.split(/[\\/]/).pop() || artifact.filePath;

  // Resolve file size on mount (main-process stat).
  const [size, setSize] = useState<number | null>(artifact.size);
  useEffect(() => {
    if (artifact.size != null) return;
    let cancelled = false;
    window.piDesk
      .statFile(artifact.filePath)
      .then((s) => { if (!cancelled) setSize(s?.size ?? null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [artifact.filePath, artifact.size]);

  return (
    <button
      className={styles.card}
      onClick={() => openFilePreview(artifact.filePath)}
      title={t("files.previewFile", { file: fileName })}
    >
      <FileIcon filePath={artifact.filePath} />
      <div className={styles.cardBody}>
        <span className={styles.fileName}>{fileName}</span>
        {size != null && <span className={styles.fileSize}>{formatSize(size)}</span>}
      </div>
      <ExternalLink size={14} className={styles.openIcon} />
    </button>
  );
}

// ── Card list ────────────────────────────────────────────────────────

interface Props {
  artifacts: Artifact[];
}

/**
 * 产物列表：
 *  - **只有 1 个产物** → 直接展示该产物卡片（不折叠，省一次点击）；
 *  - **多于 1 个** → 折叠成一张摘要卡片（文件束图标 + "产物文件" + 数量），
 *    点击才展开为单个文件卡片列表。一轮 agentic 任务可能创建几十个文件，
 *    全部平铺会把聊天区挤满。箭头样式与同区域的 ThinkingTools 折叠条保持一致。
 */
export default function ArtifactCards({ artifacts }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  if (!artifacts.length) return null;

  // 单产物：直接展示该产物卡片，不做「展开全部」折叠
  if (artifacts.length === 1) {
    return (
      <div className={styles.wrapper}>
        <ArtifactCard artifact={artifacts[0]} />
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      {expanded ? (
        <>
          <div className={styles.list}>
            {artifacts.map((a) => (
              <ArtifactCard key={a.filePath} artifact={a} />
            ))}
          </div>
          <button
            className={styles.moreBtn}
            onClick={() => setExpanded(false)}
          >
            {t("files.collapseArtifacts")}
          </button>
        </>
      ) : (
        <button
          className={styles.summaryCard}
          onClick={() => setExpanded(true)}
          aria-expanded={false}
          title={t("files.showMoreArtifacts", { count: artifacts.length })}
        >
          <Files size={20} className={styles.iconBundle} />
          <div className={styles.summaryBody}>
            <span className={styles.summaryTitle}>{t("files.artifacts")}</span>
            <span className={styles.summaryCount}>
              {t("files.showMoreArtifacts", { count: artifacts.length })}
            </span>
          </div>
          <ChevronRight size={14} className={styles.summaryChevron} />
        </button>
      )}
    </div>
  );
}
