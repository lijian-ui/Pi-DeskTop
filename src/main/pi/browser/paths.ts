/**
 * Browser paths — 浏览器资源的路径解析。
 *
 * 单独成文件是为了让 managed-chrome.ts / cdp-client.ts 都能引用，而不产生循环依赖。
 *
 * 架构（2026-09-22 收敛）：浏览器由 pi-desktop **自己启动**（托管 Chrome，独立 profile），
 * 主进程用 CDP 直连操作它 —— **不需要、也不依赖任何浏览器扩展**。
 * `browserResourceDir()` 指向托管驱动注入页面的那个用户脚本（读页面结构 + 给元素编号）。
 */
import { app } from "electron";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * 浏览器资源目录（页面脚本源码）。
 *
 * 打包后 electron-builder 把 `resources/browser/**` 解包到 app.asar.unpacked，
 * 这里把 app.asar 换成 app.asar.unpacked 以读到真实文件。
 */
export function browserResourceDir(): string {
  const root = app.getAppPath().replace(/app\.asar$/, "app.asar.unpacked");
  return join(root, "resources", "browser");
}

/** 托管 Chrome 的持久化 profile 目录（登录态存在这里，跨会话保留）。 */
export function managedProfileDir(): string {
  return join(getAgentDir(), "browser-profile");
}
