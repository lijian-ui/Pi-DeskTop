/**
 * Shared path helpers for the renderer.
 *
 * The renderer has no Node `path` module, but both artifact extraction
 * (shell commands quoting relative paths) and clickable path links in chat
 * need to turn a possibly-relative path into something the main process can
 * stat. Keeping one implementation avoids the two drifting apart.
 */

/**
 * Resolve `p` against `cwd` when it is relative. Absolute inputs (drive
 * letter, POSIX root, UNC) are returned untouched.
 */
export function resolveAgainstCwd(p: string, cwd: string): string {
  if (!cwd || !p) return p;
  // Already absolute: C:\ or C:/, POSIX root, or UNC (\\server\share).
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\")) return p;
  const sep = cwd.includes("\\") ? "\\" : "/";
  return cwd.replace(/[\\/]+$/, "") + sep + p.replace(/^[.][\\/]/, "");
}

/** Does `p` look like an absolute path already? */
export function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");
}
