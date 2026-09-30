/**
 * Browser policy — 业务域名围栏。
 *
 * 在**主进程**做前置校验：只要调用方给了 `url`（browser navigate / window show 等），就先查一遍。
 * 规则：黑名单优先；白名单非空时只允许白名单（支持 `example.com` 与 `*.example.com`）。
 * 空 host（about:blank / chrome:// 等）放行。
 *
 * ⚠️ 边界：以前的"动作发生点二次校验"由浏览器扩展在页面侧执行（只有它知道目标标签的真实
 * URL）。该扩展已于 2026-09-22 移除，随之取消 —— 因此**页面内部跳转、点链接到达的站点
 * 不经过这道围栏**，拦得住的只有"调用方显式给出 URL 的动作"。
 * 若需要按页面真实 URL 兜底，应在 CDP 层（`cdp-client.ts`）补一次校验。
 */
import type { BrowserConfig } from "./browser-config";

function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function hostMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase().replace(/^\*\./, "").replace(/^\./, "");
  if (!h || !d) return false;
  return h === d || h.endsWith(`.${d}`);
}

/** 前置校验：不在白名单/命中黑名单则抛错。空 host（about:blank 等）放行。 */
export function assertUrlAllowed(url: string | undefined, cfg: BrowserConfig): void {
  const host = hostOf(url);
  if (!host) return;
  if (cfg.blockedDomains.some((domain) => hostMatches(host, domain))) {
    throw new Error(`域名 ${host} 在黑名单内，拒绝操作。`);
  }
  if (cfg.allowedDomains.length > 0 && !cfg.allowedDomains.some((domain) => hostMatches(host, domain))) {
    throw new Error(`域名 ${host} 不在业务系统白名单内，拒绝操作。`);
  }
}
