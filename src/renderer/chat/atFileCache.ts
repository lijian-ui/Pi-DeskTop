import type { DirEntry } from "../../preload/api";

/**
 * Shared, process-wide cache for directory listings used by the `@` file
 * picker. The picker lives in the renderer, but the actual `listDirectory`
 * IPC call is served by the Electron *main* process. While the model is
 * streaming, the main process event loop is saturated by the SDK agent loop,
 * so those IPC calls queue up and the picker would sit on "加载中" forever.
 *
 * To keep the picker usable during streaming we pre-fetch (and warm) directory
 * listings while the app is idle (see ChatComposer), then read straight from
 * this cache — no main-process round-trip, no spinner.
 *
 * Keyed by the absolute directory path so every level (root + expansions) is
 * cached and reused.
 */

const dirCache = new Map<string, DirEntry[]>();
const inflight = new Map<string, Promise<DirEntry[] | null>>();

export function getCachedDir(path: string): DirEntry[] | undefined {
  return dirCache.get(path);
}

export function setCachedDir(path: string, entries: DirEntry[]): void {
  dirCache.set(path, entries);
}

export function invalidateDir(path: string): void {
  dirCache.delete(path);
}

/** Warm the cache for a directory while the app is idle. No-op if already
 *  cached or currently being fetched. Safe to call repeatedly. */
export async function preloadDir(path: string): Promise<void> {
  if (!path || dirCache.has(path) || inflight.has(path)) return;
  const p = (async () => {
    try {
      const res = await window.piDesk.listDirectory(path);
      const entries = res?.entries ?? [];
      dirCache.set(path, entries);
      return entries;
    } catch {
      return null;
    } finally {
      inflight.delete(path);
    }
  })();
  inflight.set(path, p);
  await p;
}
