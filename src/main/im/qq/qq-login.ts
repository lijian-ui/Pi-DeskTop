/**
 * QQ Bot QR scan binding — wraps `@tencent-connect/qqbot-connector`'s
 * callback-style `startQrConnect` into the same snapshot model used by
 * WeChat: startLogin kicks off a background flow (the connector polls
 * internally and calls back), the UI polls getStatus() for snapshots.
 *
 * On success the connector hands back the robot credentials directly
 * (appId + appSecret) — no need to create the bot on the QQ open platform
 * manually.
 */
import { randomUUID } from "node:crypto";
import QRCode from "qrcode";

/** Snapshot returned to the renderer. */
export interface QqLoginStatus {
  loginId: string;
  status: "running" | "confirmed" | "error" | "canceled";
  /** QR image as data URL (what the UI shows in <img>). */
  qrcodeUrl: string;
  /** Raw QR content URL (fallback link). */
  qrcode: string;
  message: string;
  /** Set when status === "confirmed". */
  credentials?: { appId: string; appSecret: string };
}

interface ActiveLogin {
  loginId: string;
  status: "running" | "confirmed" | "error" | "canceled";
  qrcodeUrl: string;
  qrcode: string;
  message: string;
  startedAt: number;
  appId?: string;
  appSecret?: string;
  stop?: () => void;
}

const logins = new Map<string, ActiveLogin>();

function snapshot(l: ActiveLogin): QqLoginStatus {
  const s: QqLoginStatus = {
    loginId: l.loginId,
    status: l.status,
    qrcodeUrl: l.qrcodeUrl,
    qrcode: l.qrcode,
    message: l.message,
  };
  if (l.status === "confirmed" && l.appId && l.appSecret) {
    s.credentials = { appId: l.appId, appSecret: l.appSecret };
  }
  return s;
}

/** Purge stale logins so the map never grows unbounded. */
function purgeStale(): void {
  const now = Date.now();
  for (const [id, l] of logins) {
    if (l.status !== "running" && now - l.startedAt > 5 * 60_000) {
      logins.delete(id);
    }
  }
}

/**
 * Kick off a QQ QR binding. Returns immediately with a login id; the
 * connector polls in the background and the UI polls getStatus().
 */
export async function startLogin(): Promise<QqLoginStatus> {
  purgeStale();
  // Dynamic import: the connector is an ESM package kept external in the
  // main-process bundle — static imports would become require() calls and
  // fail at runtime (same pattern as the WeChat qrcode package).
  const { startQrConnect } = await import("@tencent-connect/qqbot-connector");
  const loginId = randomUUID();
  const login: ActiveLogin = {
    loginId,
    status: "running",
    qrcodeUrl: "",
    qrcode: "",
    message: "正在获取二维码…",
    startedAt: Date.now(),
  };
  logins.set(loginId, login);

  const stop = startQrConnect(
    {
      onQrDisplayed: (url) => {
        login.qrcode = url;
        // The connector gives us a URL — render it into an actual QR picture.
        QRCode.toDataURL(url, { width: 240, margin: 1 })
          .then((dataUrl) => {
            login.qrcodeUrl = dataUrl;
            login.message = "请用手机 QQ 扫描二维码绑定机器人。";
          })
          .catch(() => {
            login.message = "二维码渲染失败，可用下方链接扫码。";
          });
      },
      onQrExpired: () => {
        login.message = "二维码已过期，正在刷新…";
      },
      onSuccess: (creds) => {
        const first = creds[0];
        if (!first) {
          login.status = "error";
          login.message = "绑定失败：未获取到机器人凭据。";
          return;
        }
        login.appId = first.appId;
        login.appSecret = first.appSecret;
        login.status = "confirmed";
        login.message = `绑定成功！AppID: ${first.appId}`;
      },
      onFailure: (err) => {
        login.status = "error";
        login.message = `绑定失败：${err.message}`;
      },
    },
    { displayQrCodeToConsole: false, source: "pi-desktop" },
  );
  login.stop = stop;

  return snapshot(login);
}

/** Read the current login snapshot (null if the login is gone). */
export function getLoginStatus(loginId: string): QqLoginStatus | null {
  const l = logins.get(loginId);
  if (!l) return null;
  return snapshot(l);
}

/** Cancel an in-flight login. */
export function cancelLogin(loginId: string): void {
  const l = logins.get(loginId);
  if (!l) return;
  l.stop?.();
  l.status = "canceled";
  l.message = "绑定已取消。";
}
