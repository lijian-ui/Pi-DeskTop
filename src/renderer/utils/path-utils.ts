/**
 * Shared path helpers for the renderer.
 *
 * The renderer has no Node `path` module, but both artifact extraction
 * (shell commands quoting relative paths) and clickable path links in chat
 * need to turn a possibly-relative path into something the main process can
 * stat. Keeping one implementation avoids the two drifting apart.
 */

/**
 * Windows 运行时把 Git-Bash / MSYS / WSL 风格路径还原成盘符路径：
 *   /c/Users/x      → C:\Users\x
 *   /mnt/c/Users/x  → C:\Users\x
 * 其它输入原样返回。
 *
 * 模型在 bash 里干活时会产出这种路径（bash 自己认），但主进程用 Windows fs
 * 解析时会把 `/c/Users/x` 当成"当前盘根相对路径" → `D:\c\Users\x` → stat ENOENT。
 * 非 Windows 平台不转换：那里的 `/c/…` 可能真是合法路径。
 */
const IS_WINDOWS =
  typeof navigator !== "undefined" &&
  /win/i.test(navigator.platform || navigator.userAgent || "");

export function toWindowsPath(p: string): string {
  if (!IS_WINDOWS || !p) return p;
  const m = /^\/(?:mnt\/)?([a-zA-Z])\/(.*)$/.exec(p);
  if (!m) return p;
  return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`;
}

/**
 * Resolve `p` against `cwd` when it is relative. Absolute inputs (drive
 * letter, POSIX root, UNC) are returned untouched.
 */
export function resolveAgainstCwd(p: string, cwd: string): string {
  const abs = toWindowsPath(p);
  if (!cwd || !abs) return abs;
  // Already absolute: C:\ or C:/, POSIX root, or UNC (\\server\share).
  if (/^[a-zA-Z]:[\\/]/.test(abs) || abs.startsWith("/") || abs.startsWith("\\\\")) return abs;
  const sep = cwd.includes("\\") ? "\\" : "/";
  return cwd.replace(/[\\/]+$/, "") + sep + abs.replace(/^[.][\\/]/, "");
}

/** Does `p` look like an absolute path already? */
export function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");
}
