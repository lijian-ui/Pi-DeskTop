/**
 * Browser auth — 浏览器控制的授权闸门（安全边界）。
 *
 * M0 采用**配置驱动授权**（无 IPC 依赖，因为本项目的扩展 slash command 不执行）：
 *  - 用户在「设置 → 可用工具」开启「office（浏览器操作）」即视为**知情授权**
 *    （写 `browser-config.json` 的 `enabled`）。
 *  - 定时任务（无人值守）额外要求 `allowUnattended`；`allowedDomains` 为可选
 *    的额外收窄（非强制）。
 *
 * ⚠️ 未来增强：按会话、限时的「/browser authorize」授权需要接 IPC（五落盘点）。
 *    届时在此叠加 session grant（globalThis 存 until），与配置授权取交/或。
 */
import type { BrowserConfig } from "./browser-config";

/**
 * 工具调用前的授权闸门。
 *
 * @param unattended 该扩展实例是否服务无人值守（定时任务）会话
 * @param cfg        当前 browser-config.json
 */
export function assertBrowserAuthorized(unattended: boolean, cfg: BrowserConfig): void {
  if (!cfg.enabled) {
    throw new Error(
      "浏览器控制未授权。请先在「设置 → 可用工具」开启「浏览器操作（office）」，或在 browser-config.json 设 enabled=true。",
    );
  }
  if (!unattended) return;

  if (!cfg.allowUnattended) {
    throw new Error("无人值守浏览器操作未开启。请在 browser-config.json 设 allowUnattended=true。");
  }
}

/** 一行授权状态摘要（设置页/日志用）。 */
export function authSummary(cfg: BrowserConfig): string {
  if (!cfg.enabled) return "未授权（enabled=false）";
  if (cfg.allowUnattended) return "已授权（含无人值守）";
  return "已授权（仅交互会话）";
}
