/**
 * 环形上下文用量的点击明细面板。
 *
 * 结构照 CacheHitBadge 的 .popover 先例，区别是这里靠点击开合（信息量大，悬停容易
 * 误触）。两套读数分行展示：估算明细（system prompt / 工具定义 / 各分桶）与
 * provider 报称值之间不互相换算、不相减（BC issue #18 纪律）；拿不到读数的字段
 * 显示 n/a，绝不当成 0。
 */
import { useTranslation } from "react-i18next";
import type { ContextBreakdown } from "../../shared/context-breakdown";
import styles from "./ContextBreakdown.module.css";

/** 与 CacheHitBadge 同一套紧凑读数格式。 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function Row({
  k,
  v,
  strong,
}: {
  k: string;
  v: string;
  strong?: boolean;
}) {
  return (
    <div className={`${styles.row} ${strong ? styles.rowStrong : ""}`}>
      <span className={styles.rowKey}>{k}</span>
      <span className={styles.rowVal}>{v}</span>
    </div>
  );
}

export default function ContextBreakdownPanel({
  breakdown,
}: {
  breakdown: ContextBreakdown;
}) {
  const { t } = useTranslation();
  const na = t("chat.breakdownUnavailable");
  const value = (n: number | null) => (n == null ? na : formatTokens(n));

  return (
    <div className={styles.popover} role="dialog" aria-label={t("chat.contextBreakdown")}>
      <div className={styles.popTitle}>{t("chat.contextBreakdown")}</div>
      <Row k={t("chat.breakdownSystem")} v={value(breakdown.systemPrompt)} />
      <Row k={t("chat.breakdownToolDefs")} v={value(breakdown.toolDefs)} />
      <Row k={t("chat.breakdownToolResults")} v={value(breakdown.tool)} />
      <Row k={t("chat.breakdownText")} v={value(breakdown.text)} />
      <Row k={t("chat.breakdownCode")} v={value(breakdown.code)} />
      <Row k={t("chat.breakdownSummaries")} v={value(breakdown.summaries)} />
      <Row k={t("chat.breakdownTotal")} v={value(breakdown.total)} strong />
      {breakdown.providerTokens != null && (
        <Row k={t("chat.breakdownProviderReported")} v={value(breakdown.providerTokens)} />
      )}
    </div>
  );
}
