/**
 * Image helpers for composer attachments.
 *
 * The SDK expects `ImageContent.data` to be raw base64 (no `data:` prefix), so
 * everything here works in that representation and only rebuilds a data-URL
 * when something needs to be handed to an <img> tag.
 */

/** Convert a File/Blob to base64 without the `data:` prefix. */
export async function fileToBase64(file: Blob): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  // Chunked conversion: String.fromCharCode(...bytes) blows the call stack
  // (and memory) on multi-MB screenshots.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(
      ...(bytes.subarray(i, i + CHUNK) as unknown as number[])
    );
  }
  return btoa(binary);
}

/** Build the `data:` URL an <img> needs from a stored attachment. */
export function toDataUrl(mimeType: string, data: string): string {
  return `data:${mimeType || "image/png"};base64,${data}`;
}

/** Human-readable byte size for the attachment pill tooltip. */
export function formatBytes(size?: number): string {
  if (!size || size <= 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function isImageFile(file: { type?: string }): boolean {
  return !!file.type && file.type.startsWith("image/");
}

/**
 * Compression defaults for images sent to the LLM.
 *
 * Kept gentle on purpose: we only downscale genuinely large images and we
 * re-encode photos as JPEG. This dramatically shrinks the payload (and the
 * persisted session file) without a visible quality hit for normal
 * screenshots. The SDK does NOT resize inline `prompt(text, {images})` images,
 * so this client-side step is what actually bounds what we ship to the model.
 */
export const MAX_COMPRESS_LONG_SIDE = 1600;
export const COMPRESS_QUALITY = 0.82;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Approximate decoded byte length of a base64 string (for the pill tooltip). */
function base64ByteLength(b64: string): number {
  let pad = 0;
  if (b64.endsWith("==")) pad = 2;
  else if (b64.endsWith("=")) pad = 1;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/**
 * Lossy-compress an already-base64 image for sending to the LLM.
 *
 * - Downscales so the longest side <= `maxLongSide`, preserving aspect ratio.
 * - Re-encodes as JPEG at `quality`, EXCEPT when the source is a PNG/WebP that
 *   actually uses transparency — then it stays PNG (lossless) so a transparent
 *   region never turns into a black rectangle.
 * - A white matte is painted under everything before drawing, so any partially
 *   transparent pixel composites onto white in the JPEG case.
 * - Never throws: on any failure it returns the input unchanged so sending the
 *   original is always possible.
 */
export async function compressImage(
  data: string,
  mimeType: string,
  maxLongSide: number = MAX_COMPRESS_LONG_SIDE,
  quality: number = COMPRESS_QUALITY
): Promise<{ data: string; mimeType: string }> {
  try {
    const bytes = base64ToBytes(data);
    const blob = new Blob([bytes as BlobPart], { type: mimeType });
    const bitmap = await createImageBitmap(blob);
    const w0 = bitmap.width;
    const h0 = bitmap.height;
    const longSide = Math.max(w0, h0);
    let w = w0;
    let h = h0;
    if (longSide > maxLongSide) {
      const scale = maxLongSide / longSide;
      w = Math.max(1, Math.round(w0 * scale));
      h = Math.max(1, Math.round(h0 * scale));
    }

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close?.();
      return { data, mimeType };
    }
    // White matte: protects transparency from becoming black in JPEG output.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);

    // Only PNG/WebP can carry alpha; sample a tiny downscaled copy to decide.
    let hasAlpha = false;
    if (mimeType === "image/png" || mimeType === "image/webp") {
      const S = 48;
      const sScale = Math.min(1, S / Math.max(w0, h0));
      const sw = Math.max(1, Math.round(w0 * sScale));
      const sh = Math.max(1, Math.round(h0 * sScale));
      const sc = document.createElement("canvas");
      sc.width = sw;
      sc.height = sh;
      const scx = sc.getContext("2d");
      if (scx) {
        scx.drawImage(bitmap, 0, 0, sw, sh);
        const px = scx.getImageData(0, 0, sw, sh).data;
        for (let i = 3; i < px.length; i += 4) {
          if (px[i] < 250) {
            hasAlpha = true;
            break;
          }
        }
      }
    }
    bitmap.close?.();

    let outMime: string;
    let outDataUrl: string;
    if (hasAlpha) {
      outMime = "image/png";
      outDataUrl = canvas.toDataURL("image/png");
    } else {
      outMime = "image/jpeg";
      outDataUrl = canvas.toDataURL("image/jpeg", quality);
    }
    const outData = outDataUrl.split(",")[1];
    if (!outData) return { data, mimeType };
    return { data: outData, mimeType: outMime };
  } catch {
    return { data, mimeType };
  }
}

/** Decoded byte length helper, surfaced for callers that want the compressed size. */
export function compressedByteLength(data: string): number {
  return base64ByteLength(data);
}

