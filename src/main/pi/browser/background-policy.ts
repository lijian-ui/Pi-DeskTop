/**
 * Background policy — 「不主动抢焦点 / 不激活标签」的策略（纯逻辑，可单测）。
 *
 * 语义澄清：这不是隐身、也不是 OS 级沙箱，只是一个「别去动用户正在看的东西」的开关。
 * 浏览器由本应用自己启动（独立 profile、默认无头、用户根本看不见），所以"后台静默"在这里
 * 指的是**别把它切到前台** —— 多数任务应在后台静默跑完，只有需要用户登录时才显式弹窗。
 */

export interface BackgroundParams {
  background?: boolean;
  foreground?: boolean;
}

/**
 * 计算本次调用是否走后台。
 * - 会话锁 background=true（默认）：硬策略，忽略调用方的 background:false / foreground:true。
 * - 会话未锁：允许调用方显式 background:true。
 *
 * @param params 工具参数
 * @param sessionBackgroundOn 会话是否处于后台静默（config.background）
 */
export function effectiveBackground(params: BackgroundParams, sessionBackgroundOn: boolean): boolean {
  const requested = params.background ?? (params.foreground !== undefined ? !params.foreground : false);
  return sessionBackgroundOn || requested;
}

/** 后台模式下禁止的动作（明确报错，而不是静默忽略）。 */
export function assertActionAllowed(action: string, background: boolean): void {
  if (background && action === "tab.activate") {
    throw new Error("后台静默模式下禁止激活标签页。如需前台观察，请把 browser-config.json 的 background 设为 false。");
  }
}
