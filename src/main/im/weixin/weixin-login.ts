/**
 * Weixin QR scan login — desktop-adapted from the official connector's
 * login-qr.ts. The login loop runs IN-PROCESS (started by startLogin, never
 * awaited); the UI polls getStatus() for a snapshot and submits the pairing
 * code via submitVerifyCode when the server asks for one.
 *
 * On "confirmed" the loop resolves with the bot credentials; the caller
 * stores them into the channel instance config.
 */
import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { apiGetFetch, apiPostFetch } from "./weixin-api";

/** Default `bot_type` for ilink get_bot_qrcode / get_qrcode_status. */
const DEFAULT_ILINK_BOT_TYPE = "3";

/** Fixed API base URL for all QR code requests. */
const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";

/** Client-side timeout for the long-poll get_qrcode_status request. */
const QR_LONG_POLL_TIMEOUT_MS = 35_000;

/** A QR code that was never scanned expires after this long. */
const LOGIN_TTL_MS = 5 * 60_000;

/** Max QR refresh attempts before giving up. */
const MAX_QR_REFRESH_COUNT = 3;

type QrStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface StatusResponse {
  status: QrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

/** Snapshot returned to the renderer. */
export interface WeixinLoginStatus {
  loginId: string;
  status: QrStatus | "running" | "error" | "canceled";
  /** Image URL of the QR code (may be empty until startLogin succeeds). */
  qrcodeUrl: string;
  /** Raw QR content string (fallback link for the user). */
  qrcode: string;
  message: string;
  /** Set when status === "need_verifycode" — UI must prompt for this. */
  verifyCodeNeeded?: boolean;
  /** Set when status === "confirmed". */
  credentials?: { token: string; botId: string; baseUrl: string; userId?: string };
}

interface ActiveLogin {
  loginId: string;
  /** Query identifier used by get_qrcode_status polling. */
  qrcode: string;
  /** Rendered QR image as a data URL (what the UI shows in <img>). */
  qrcodeUrl: string;
  /** Raw QR content URL (fallback link for the user when the image fails). */
  qrContent: string;
  startedAt: number;
  status: QrStatus | "running" | "error" | "canceled";
  message: string;
  botToken?: string;
  botId?: string;
  baseUrl?: string;
  userId?: string;
  pendingVerifyCode?: string;
  currentApiBaseUrl: string;
  qrRefreshCount: number;
  running: boolean;
}

const logins = new Map<string, ActiveLogin>();

/** Remove stale logins so the map never grows unbounded. */
function purgeStale(): void {
  const now = Date.now();
  for (const [id, l] of logins) {
    if (!l.running && now - l.startedAt > LOGIN_TTL_MS) logins.delete(id);
  }
}

function snapshot(l: ActiveLogin): WeixinLoginStatus {
  const s: WeixinLoginStatus = {
    loginId: l.loginId,
    status: l.status,
    qrcodeUrl: l.qrcodeUrl,
    // Raw QR content URL — the fallback link for the user.
    qrcode: l.qrContent,
    message: l.message,
  };
  if (l.status === "need_verifycode") s.verifyCodeNeeded = true;
  if (l.status === "confirmed" && l.botToken && l.botId) {
    s.credentials = {
      token: l.botToken,
      botId: l.botId,
      baseUrl: l.baseUrl ?? FIXED_BASE_URL,
      userId: l.userId,
    };
  }
  return s;
}

async function fetchQRCode(apiBaseUrl: string, botType: string): Promise<QRCodeResponse> {
  const rawText = await apiPostFetch({
    baseUrl: apiBaseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    body: JSON.stringify({ local_token_list: [] }),
    timeoutMs: 15_000,
    label: "fetchQRCode",
  });
  return JSON.parse(rawText) as QRCodeResponse;
}

async function pollQRStatus(
  apiBaseUrl: string,
  qrcode: string,
  verifyCode?: string,
): Promise<StatusResponse> {
  try {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) {
      endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
    }
    const rawText = await apiGetFetch({
      baseUrl: apiBaseUrl,
      endpoint,
      timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
      label: "pollQRStatus",
    });
    return JSON.parse(rawText) as StatusResponse;
  } catch (err) {
    // Timeout / gateway errors are normal for a long-poll — keep waiting.
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    return { status: "wait" };
  }
}

async function refreshQR(l: ActiveLogin): Promise<boolean> {
  try {
    const qr = await fetchQRCode(FIXED_BASE_URL, DEFAULT_ILINK_BOT_TYPE);
    l.qrcode = qr.qrcode;
    l.qrContent = qr.qrcode_img_content;
    // qrcode_img_content is the URL CONTENT to scan, not an image — render
    // it into an actual QR picture for the UI.
    l.qrcodeUrl = await QRCode.toDataURL(qr.qrcode_img_content, {
      width: 240,
      margin: 1,
    });
    l.startedAt = Date.now();
    l.qrRefreshCount += 1;
    l.message = "二维码已更新，请重新扫描。";
    return true;
  } catch (err) {
    l.message = `刷新二维码失败: ${String(err)}`;
    return false;
  }
}

/**
 * Kick off a QR login. Returns the login id + QR material immediately; the
 * polling loop runs in the background and updates the snapshot.
 */
export async function startLogin(): Promise<WeixinLoginStatus> {
  purgeStale();
  const loginId = randomUUID();
  const login: ActiveLogin = {
    loginId,
    qrcode: "",
    qrcodeUrl: "",
    qrContent: "",
    startedAt: Date.now(),
    status: "running",
    message: "正在获取二维码…",
    currentApiBaseUrl: FIXED_BASE_URL,
    qrRefreshCount: 0,
    running: true,
  };
  logins.set(loginId, login);

  // Kick off the background loop without awaiting it — callers poll getStatus.
  void (async () => {
    try {
      const qr = await fetchQRCode(FIXED_BASE_URL, DEFAULT_ILINK_BOT_TYPE);
      login.qrcode = qr.qrcode;
      login.qrContent = qr.qrcode_img_content;
      // qrcode_img_content is the URL CONTENT to scan, not an image — render
      // it into an actual QR picture for the UI.
      login.qrcodeUrl = await QRCode.toDataURL(qr.qrcode_img_content, {
        width: 240,
        margin: 1,
      });
      login.message = "请用手机微信扫描二维码。";
      await runLoop(login);
    } catch (err) {
      login.status = "error";
      login.message = `获取二维码失败: ${String(err)}`;
      login.running = false;
    }
  })();

  return snapshot(login);
}

async function runLoop(l: ActiveLogin): Promise<void> {
  while (l.running && Date.now() - l.startedAt < LOGIN_TTL_MS) {
    const resp = await pollQRStatus(
      l.currentApiBaseUrl,
      l.qrcode,
      l.pendingVerifyCode,
    );
    switch (resp.status) {
      case "wait":
        break;
      case "scaned":
        if (l.pendingVerifyCode) l.pendingVerifyCode = undefined;
        if (l.status !== "scaned") {
          l.status = "scaned";
          l.message = "已扫码，正在确认…";
        }
        break;
      case "need_verifycode":
        l.status = "need_verifycode";
        l.message = l.pendingVerifyCode
          ? "❌ 数字不匹配，请重新输入。"
          : "请在手机微信上查看数字，并在此输入。";
        // Wait for the user to submit the code via submitVerifyCode.
        await new Promise<void>((resolve) => {
          const iv = setInterval(() => {
            if (!l.running || l.pendingVerifyCode !== undefined) {
              clearInterval(iv);
              resolve();
            }
          }, 500);
        });
        if (!l.running) return;
        break;
      case "expired": {
        const ok = await refreshQR(l);
        if (!ok || l.qrRefreshCount > MAX_QR_REFRESH_COUNT) {
          l.status = "error";
          l.message = "二维码多次失效，连接流程已停止。请稍后再试。";
          l.running = false;
          return;
        }
        l.status = "wait";
        break;
      }
      case "verify_code_blocked":
        l.pendingVerifyCode = undefined;
        l.message = "多次输入错误，请稍后再试。";
        await new Promise((r) => setTimeout(r, 3000));
        break;
      case "binded_redirect":
        l.status = "confirmed";
        l.message = "该微信已绑定过此实例，无需重复连接。";
        l.running = false;
        return;
      case "scaned_but_redirect":
        if (resp.redirect_host) {
          l.currentApiBaseUrl = `https://${resp.redirect_host}`;
        }
        break;
      case "confirmed": {
        if (!resp.ilink_bot_id) {
          l.status = "error";
          l.message = "登录失败：服务器未返回 ilink_bot_id。";
          l.running = false;
          return;
        }
        l.status = "confirmed";
        l.botToken = resp.bot_token;
        l.botId = resp.ilink_bot_id;
        l.baseUrl = resp.baseurl;
        l.userId = resp.ilink_user_id;
        l.message = "已连接到微信。";
        l.running = false;
        return;
      }
    }
    // Short delay between long-polls to avoid hammering.
    await new Promise((r) => setTimeout(r, 800));
  }

  if (l.running) {
    l.status = "error";
    l.message = "登录超时，请重试。";
    l.running = false;
  }
}

/** Read the current login snapshot (null if the login is gone). */
export function getLoginStatus(loginId: string): WeixinLoginStatus | null {
  const l = logins.get(loginId);
  if (!l) return null;
  return snapshot(l);
}

/** Submit the pairing code shown on the phone. */
export function submitVerifyCode(loginId: string, code: string): boolean {
  const l = logins.get(loginId);
  if (!l || !l.running) return false;
  l.pendingVerifyCode = code.trim();
  if (l.status === "need_verifycode") l.status = "wait";
  return true;
}

/** Cancel an in-flight login. */
export function cancelLogin(loginId: string): void {
  const l = logins.get(loginId);
  if (!l) return;
  l.running = false;
  l.status = "canceled";
  l.message = "登录已取消。";
}
