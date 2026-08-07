/**
 * Prompt-cache hit-rate badge.
 *
 * Compact pill showing the cumulative cache-hit ratio for the focused session
 * (populated from `pi:getCacheStats`). Hovering reveals a richer breakdown:
 * cached tokens, missed tokens, miss count, estimated extra cost.
 *
 * Shown next to the context-usage ring in the composer toolbar so the user
 * can see at a glance whether the provider's KV cache is doing its job.
 */
import { useTranslation } from "react-i18next";
import styles from "./CacheHitBadge.module.css";

export interface CacheStats {
  missedTokens: number;
  missedCost: number;
  missCount: number;
  cacheRead: number;
  cacheWrite: number;
  cacheMiss: number;
  ttlMs: number;
}

/** Hit rate = cacheRead / (cacheRead + cacheWrite + input). `input` is the
 *  cache-missed part the provider re-billed as fresh tokens. */
function hitRate(stats: CacheStats | null): number | null {
  if (!stats) return null;
  const hit = stats.cacheRead ?? 0;
  const miss = (stats.cacheWrite ?? 0) + (stats.cacheMiss ?? 0);
  const total = hit + miss;
  if (total <= 0) return null;
  return (hit / total) * 100;
}

/** Map a hit-rate percentage to a colour tier. */
function tier(hitPct: number): "good" | "warn" | "bad" {
  if (hitPct >= 85) return "good";
  if (hitPct >= 60) return "warn";
  return "bad";
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toString();
}

export default function CacheHitBadge({ stats }: { stats: CacheStats | null }) {
  const { t } = useTranslation();
  const pct = hitRate(stats);
  if (pct == null) return null;
  const color = tier(pct);
  const cached = stats?.cacheRead ?? 0;
  const missed = (stats?.cacheWrite ?? 0) + (stats?.cacheMiss ?? 0);

  return (
    <div className={`${styles.wrap} ${styles[color]}`} title="">
      <span className={styles.dot} />
      <span className={styles.label}>{Math.round(pct)}%</span>
      <div className={styles.popover} role="tooltip">
        <div className={styles.popTitle}>{t("cache.title")}</div>
        <div className={styles.row}>
          <span className={styles.rowKey}>{t("cache.hitRate")}</span>
          <span className={`${styles.rowVal} ${styles[color]}`}>
            {pct.toFixed(1)}%
          </span>
        </div>
        <div className={styles.row}>
          <span className={styles.rowKey}>{t("cache.hit")}</span>
          <span className={styles.rowVal}>{formatTokens(cached)}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.rowKey}>{t("cache.missed")}</span>
          <span className={styles.rowVal}>{formatTokens(missed)}</span>
        </div>
      </div>
    </div>
  );
}