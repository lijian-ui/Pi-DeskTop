/**
 * DingTalk media plane — upload/download of image/file/voice payloads and
 * document text extraction. Uploads go through the legacy OAPI (oapi.dingtalk
 * .com/media/upload) which returns a media_id; downloads and robot messaging
 * use the newer /v1.0 API. Ported from dingtalk-openclaw-connector (MIT).
 */
import axios from "axios";
import { createReadStream, existsSync } from "node:fs";
import { basename, extname } from "node:path";
import FormData from "form-data";

/** DingTalk robot credentials (extracted from ImChannelInstance.config). */
export interface DingtalkCredentials {
  clientId: string;
  clientSecret: string;
}

const DINGTALK_API = "https://api.dingtalk.com";
const DINGTALK_OAPI = "https://oapi.dingtalk.com";

const OAPI_TOKEN_CACHE_TTL_MS = 1000 * 60 * 55;

interface TokenCacheEntry {
  token: string;
  expiryMs: number;
}

const oapiTokenCache = new Map<string, TokenCacheEntry>();

/** Legacy OAPI access token (separate from the /v1.0 robot token). */
async function getOapiAccessToken(cfg: DingtalkCredentials): Promise<string | null> {
  const key = cfg.clientId;
  const cached = oapiTokenCache.get(key);
  if (cached && cached.expiryMs > Date.now() + 60_000) return cached.token;

  const res = await axios.get(`${DINGTALK_OAPI}/gettoken`, {
    params: { appkey: cfg.clientId, appsecret: cfg.clientSecret },
  });
  const token = res.data?.access_token as string | undefined;
  if (!token) return null;
  const expireInSec = Number(res.data?.expires_in ?? 0) || 7200;
  oapiTokenCache.set(key, {
    token,
    expiryMs: Date.now() + expireInSec * 1000 + OAPI_TOKEN_CACHE_TTL_MS,
  });
  return token;
}

/** Result of uploading a local file to DingTalk media storage. */
export interface DingtalkUploadResult {
  /** Raw media_id as returned by the API. The leading `@` is significant:
   *  sampleImageMsg.photoURL and sampleFile.mediaId both require it
   *  (mirrors the DingTalk OpenClaw SDK / novaclaw). */
  mediaId: string;
}

/**
 * Upload a local file to DingTalk and return its media ids. Returns null on
 * any failure — the caller decides how to degrade.
 */
export async function uploadDingtalkMedia(
  cfg: DingtalkCredentials,
  filePath: string,
  mediaType: "image" | "file" | "video" | "voice",
): Promise<DingtalkUploadResult | null> {
  try {
    if (!existsSync(filePath)) return null;
    const token = await getOapiAccessToken(cfg);
    if (!token) return null;
    const form = new FormData();
    form.append("media", createReadStream(filePath), {
      filename: basename(filePath),
      contentType: mediaType === "image" ? "image/jpeg" : "application/octet-stream",
    });
    const res = await axios.post(`${DINGTALK_OAPI}/media/upload`, form, {
      params: { access_token: token, type: mediaType },
      headers: form.getHeaders(),
      timeout: 60_000,
      maxBodyLength: Infinity,
    });
    const mediaId = res.data?.media_id as string | undefined;
    if (!mediaId) return null;
    return { mediaId };
  } catch (err) {
    console.warn(
      "[im:dingtalk] media upload failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Download a message attachment (image/file/voice) by its downloadCode and
 * return the raw bytes. Two calls: downloadCode → signed OSS URL, then GET.
 */
export async function downloadDingtalkMedia(
  cfg: DingtalkCredentials,
  downloadCode: string,
): Promise<{ data: Buffer; mimeType: string } | null> {
  try {
    const token = await getOapiAccessToken(cfg);
    if (!token) return null;
    const res = await axios.post(
      `${DINGTALK_API}/v1.0/robot/messageFiles/download`,
      { downloadCode, robotCode: cfg.clientId },
      {
        headers: { "x-acs-dingtalk-access-token": token },
        timeout: 15_000,
      },
    );
    const downloadUrl = res.data?.downloadUrl as string | undefined;
    if (!downloadUrl) return null;

    const bin = await axios.get(downloadUrl, {
      responseType: "arraybuffer",
      timeout: 30_000,
      // OSS presigned URLs reject requests carrying a default JSON Content-Type;
      // dropping it lets the signature check pass.
      headers: { "Content-Type": undefined },
    });
    const mimeType = (bin.headers["content-type"] as string) || "application/octet-stream";
    return { data: Buffer.from(bin.data as ArrayBuffer), mimeType };
  } catch (err) {
    console.warn(
      "[im:dingtalk] media download failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

const TEXT_FILE_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".yaml", ".yml", ".xml", ".html", ".css",
  ".js", ".ts", ".py", ".java", ".c", ".cpp", ".h", ".sh", ".bat", ".csv",
]);

/** Cap on extracted document text — a requirements doc is context, not a file
 *  dump; keep the token footprint bounded. */
const MAX_FILE_TEXT_CHARS = 20_000;

/**
 * Extract readable text from a downloaded attachment. Plain text/code files
 * are read as UTF-8; .docx/.pdf go through mammoth/pdf-parse (loaded lazily —
 * they carry no type declarations, hence the untyped import).
 */
export async function parseDingtalkFile(
  data: Buffer,
  fileName: string,
): Promise<string | null> {
  try {
    const ext = extname(fileName).toLowerCase();
    if (TEXT_FILE_EXTENSIONS.has(ext)) {
      return data.toString("utf-8").slice(0, MAX_FILE_TEXT_CHARS);
    }
    if (ext === ".docx") {
      const mammoth: any = await import("mammoth");
      const mod = mammoth.default ?? mammoth;
      const result = await mod.extractRawText({ buffer: data });
      return (result?.value ?? "").slice(0, MAX_FILE_TEXT_CHARS);
    }
    if (ext === ".pdf") {
      // pdf-parse v2: class-based parser, lazy-loaded (no type declarations).
      const pdfParse: any = await import("pdf-parse");
      const mod = pdfParse.default ?? pdfParse;
      const parser = new mod.PDFParse({ data });
      try {
        const result = await parser.getText();
        return (result?.text ?? "").slice(0, MAX_FILE_TEXT_CHARS);
      } finally {
        await parser.destroy?.().catch(() => {});
      }
    }
    return null;
  } catch (err) {
    console.warn(
      "[im:dingtalk] file parse failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
