/**
 * Browser guard — 动作级「默认拒绝」门禁。
 *
 * 分层：`auth.ts` 管「能不能用浏览器」；`policy.ts` 管「能去哪些站点」；
 * 本文件管「进了站之后哪些动作允许」。
 *
 * 为什么需要它：前两道闸门管的是"进这栋楼"，管不住"进了楼之后干什么"。以下三类
 * 操作**无法用普通点击/输入替代**（所以锁得住），而在你已登录的页面里执行它们
 * 等同于"以你的身份做危险的事" —— 网页里藏一段诱导性文字（提示注入）就可能让 AI 去用：
 *   - `page.evaluate`  ：在已登录上下文跑任意 JS → 可读取并外发页面全部数据
 *   - `page.upload`    ：接受本机绝对路径 → 可把电脑上的任意文件交给网页
 *   - `page.key + Ctrl/Meta/Alt`：Ctrl+W 关标签、Ctrl+Shift+Delete 清数据等
 * 故这三类**默认拒绝**，需要显式在 browser-config.json 的 `guard` 段放开。
 *
 * 刻意**不做**的两件事（2026-09-22 定的）：
 *  1. 不拦 `fill(submit:true)` —— 点一下提交按钮就能绕过，拦它只是徒增摩擦、拦不住。
 *  2. 不拦"访问新站点时问用户" —— 那会强迫用户在场确认，与"除了验证码/扫码登录之外
 *     不需要用户干预"的目标冲突；管站点交给 `allowedDomains` 白名单。
 */

import type { BrowserConfig } from "./browser-config";

/** 供 `browser({action:"status"})` 展示的门禁现状。 */
export function guardSummary(cfg: BrowserConfig): Record<string, unknown> {
  return {
    allowLocalFileUpload: cfg.guard.allowLocalFileUpload,
    allowEvaluate: cfg.guard.allowEvaluate,
    allowKeyCombos: cfg.guard.allowKeyCombos,
  };
}

function guardError(what: string, configKey: string, why: string): Error {
  return new Error(
    `${what}已被门禁拒绝。原因：${why} ` +
      `如果确实需要，请让用户在 browser-config.json 的 guard 段显式放开：` +
      `"guard": { "${configKey}": true }（改了立即生效，无需重启）。`,
  );
}

/** ctrl/meta/alt 任一按下即算组合键（单独 shift 不算：Shift+Enter 换行之类无害）。 */
function hasCommandModifier(params: Record<string, unknown>): boolean {
  const mods = (params.modifiers ?? {}) as Record<string, unknown>;
  return Boolean(mods.ctrlKey || mods.metaKey || mods.altKey);
}

/**
 * 动作级门禁：不通过即抛错（**默认拒绝**）。
 * @param action 线上动作名（`page.*` / `tab.*`）
 */
export function assertActionGuarded(
  action: string,
  params: Record<string, unknown>,
  cfg: BrowserConfig,
): void {
  switch (action) {
    case "page.upload":
      if (!cfg.guard.allowLocalFileUpload) {
        throw guardError(
          "上传本机文件（browser upload）",
          "allowLocalFileUpload",
          "该动作会把你指定的**本机任意文件**塞进网页的文件输入框；如果页面文本诱导 AI 传入敏感路径，就等于把电脑上的文件交出去。",
        );
      }
      return;
    case "page.evaluate":
      if (!cfg.guard.allowEvaluate) {
        throw guardError(
          "在页面里执行任意代码（browser evaluate）",
          "allowEvaluate",
          "它在**已登录的页面上下文**里运行任意脚本，可读取并外发页面上的全部数据。优先用 snapshot + click/type 完成任务。",
        );
      }
      return;
    case "page.key":
      if (!cfg.guard.allowKeyCombos && hasCommandModifier(params)) {
        throw guardError(
          "带 ctrl/meta/alt 的组合键（browser press_key）",
          "allowKeyCombos",
          "组合键能触发浏览器与系统的破坏性指令（如 Ctrl+W 关标签、Ctrl+Shift+Delete 清数据）。",
        );
      }
      return;
    default:
      return;
  }
}
