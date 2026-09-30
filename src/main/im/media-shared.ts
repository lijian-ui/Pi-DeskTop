/**
 * Shared IM media helpers — channel-agnostic policy shared by every adapter.
 *
 * Media TRANSFER is inherently channel-specific (DingTalk OAPI multipart,
 * WeChat AES-CDN, QQ SDK sendMedia), so that stays in each adapter. What every
 * adapter duplicates instead is the surrounding policy: size/timeout caps, the
 * "is this a local path → read it / send it" detection, and the scan of reply
 * text for embedded media references. Those live here as a single source of
 * source of truth, so one policy change (e.g. a new file extension) lands once.
 */
import { statSync } from "node:fs";

/** Cap on inbound/outbound media payloads — a media blob is context, not a dump. */
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;

/** Guard against a hung attachment download URL (inbound side). */
export const MEDIA_FETCH_TIMEOUT_MS = 30_000;

/** True when a path points at a local file (drive letter, /, ~, file://). */
export function isLocalPath(raw: string): boolean {
  return (
    raw.startsWith("file://") ||
    /^[A-Za-z]:[\\/]/.test(raw) ||
    raw.startsWith("/") ||
    raw.startsWith("~")
  );
}

/** Strip file:// / URL-encoding to get the on-disk absolute path. */
export function toLocalPath(raw: string): string {
  let p = raw.startsWith("file://") ? raw.slice("file://".length) : raw;
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep as-is */
  }
  return p;
}

/** True when the path exists AND is a regular file (directories are skipped
 *  so a `pwd`-style output never gets uploaded as media). */
export function isRegularFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Image extensions the media layer recognizes (sent as image messages). */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|bmp|webp)$/i;

/** True for paths/names with an image extension. */
export function isImageFile(path: string): boolean {
  return IMAGE_EXT_RE.test(path);
}

/** One embedded media reference found in reply text. */
export interface MediaRef {
  /** The raw text token to replace with a short note after sending. */
  full: string;
  /** Resolved on-disk absolute path. */
  path: string;
  kind: "image" | "file";
}

/**
 * Scan reply text for embedded local media references and return them in
 * source order. NOW image-only: only markdown `![alt](<local image path>)`
 * syntax auto-attaches media. Bare absolute paths (code/text files etc.) are
 * NOT auto-sent — outbound file delivery is owned by the explicit `send_file`
 * tool instead (compare openclaw's message tool), so a project that generates
 * 20 source files doesn't spam the channel.
 * Channels with an extra explicit marker (e.g. DingTalk's [DINGTALK_FILE]…)
 * handle that token themselves on top of this.
 *
 * The caller owns the transport: for each ref, upload it via the channel's
 * own mechanism, send it, and replace `ref.full` with a channel-appropriate
 * note (e.g. "[图片]"). `kind` is always "image" today.
 */
export function extractMediaRefs(text: string): MediaRef[] {
  const refs: MediaRef[] = [];
  const seen = new Set<string>(); // resolved path — drop duplicate refs
  // markdown image syntax — image only.
  for (const m of text.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
    const path = m[2];
    if (!isLocalPath(path)) continue;
    const filePath = toLocalPath(path);
    if (!isImageFile(filePath)) continue;
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    refs.push({ full: m[0], path: filePath, kind: "image" });
  }
  return refs;
}