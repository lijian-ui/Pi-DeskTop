/**
 * 钉钉机器人「扫码创建」—— 官方设备码注册流程。
 *
 * 与微信 / QQ 的「绑定已有账号」不同，钉钉的 `/app/registration/*`（oapi.dingtalk.com）
 * 允许官方后端在用户用手机钉钉扫码后**代我们创建一个全新机器人**：轮询结果直接返回
 * clientId / clientSecret，AI 卡片与消息权限已预置 —— 不用去开放平台手工建应用、勾权限。
 *
 * 流程与参考项目 dsh-im-gateway 的 `channels/dingtalk-register.ts` 一致：
 * init → begin → poll，二维码由 `qrcode` 渲染成 data URL，UI 轮询 getLoginStatus()。
 */
import { randomUUID } from "node:crypto";
import QRCode from "qrcode";

/** 返回给调用方（设置页）的快照。 */
export interface DingtalkRegisterStatus {
  loginId: string;
  status: "running" | "confirmed" | "error" | "canceled" | "expired";
  /** 二维码图片 data URL（UI 用 <img> 展示）。 */
  qrcodeUrl: string;
  /** 原始二维码内容 URL（兜底链接）。 */
  qrcode: string;
  message: string;
  /** status === "confirmed" 时给出。 */
  credentials?: { clientId: string; clientSecret: string };
}

interface ActiveLogin {
  loginId: string;
  status: DingtalkRegisterStatus["status"];
  qrcodeUrl: string;
  qrcode: string;
  message: string;
  startedAt: number;
  /** 停掉后台轮询。 */
  stop?: () => void;
  clientId?: string;
  clientSecret?: string;
}

const logins = new Map<string, ActiveLogin>();

/** 注册服务地址（可用环境变量指向测试环境）。 */
const BASE_URL =
  (process.env.DINGTALK_REGISTRATION_BASE_URL ?? "").trim() || "https://oapi.dingtalk.com";
/** 标识调用来源（官方注册后端要求）。 */
const SOURCE = "DING_DWS_CLAW";

/** POST JSON 并校验钉钉信封（errcode === 0）。 */
async function post<T extends Record<string, unknown>>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as (T & { errcode: number; errmsg?: string }) | undefined;
  if (!data || data.errcode !== 0) {
    throw new Error(data?.errmsg || `[${path}] unknown error (errcode=${data?.errcode ?? "N/A"})`);
  }
  return data as T;
}

function snapshot(l: ActiveLogin): DingtalkRegisterStatus {
  const s: DingtalkRegisterStatus = {
    loginId: l.loginId,
    status: l.status,
    qrcodeUrl: l.qrcodeUrl,
    qrcode: l.qrcode,
    message: l.message,
  };
  if (l.status === "confirmed" && l.clientId && l.clientSecret) {
    s.credentials = { clientId: l.clientId, clientSecret: l.clientSecret };
  }
  return s;
}

/** 清理过期的非运行记录，避免 map 无限增长。 */
function purgeStale(): void {
  const now = Date.now();
  for (const [id, l] of logins) {
    if (l.status !== "running" && now - l.startedAt > 5 * 60_000) logins.delete(id);
  }
}

/**
 * 发起一次钉钉机器人扫码创建：立即返回快照（含二维码），后台轮询等用户扫码，
 * UI 通过 getLoginStatus() 轮询到 confirmed。
 */
export async function startLogin(): Promise<DingtalkRegisterStatus> {
  purgeStale();
  const loginId = randomUUID();

  // 1. init → nonce
  const init = await post<{ nonce?: string }>("/app/registration/init", { source: SOURCE });
  const nonce = String(init.nonce ?? "").trim();
  if (!nonce) throw new Error("[dingtalk-register] init: missing nonce");

  // 2. begin → device_code + 验证链接（二维码内容）
  const begin = await post<{
    device_code?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
  }>("/app/registration/begin", { nonce });
  const deviceCode = String(begin.device_code ?? "").trim();
  const verifyUrl = String(begin.verification_uri_complete ?? "").trim();
  if (!deviceCode || !verifyUrl) {
    throw new Error("[dingtalk-register] begin: missing device_code or verification_uri");
  }
  const expiresInMs = Math.max(60, Number(begin.expires_in ?? 7200)) * 1000;
  const intervalMs = Math.max(3, Number(begin.interval ?? 3)) * 1000;

  const login: ActiveLogin = {
    loginId,
    status: "running",
    qrcodeUrl: "",
    qrcode: verifyUrl,
    message: "正在获取二维码…",
    startedAt: Date.now(),
  };
  logins.set(loginId, login);

  try {
    login.qrcodeUrl = await QRCode.toDataURL(verifyUrl, { width: 240, margin: 1 });
    login.message = "请用手机钉钉扫码，一键创建机器人（或绑定已有机器人）。";
  } catch {
    login.message = "二维码渲染失败，可用下方链接扫码。";
  }

  const deadline = Date.now() + expiresInMs;
  const timer = setInterval(() => {
    void (async () => {
      if (login.status !== "running") {
        clearInterval(timer);
        return;
      }
      if (Date.now() >= deadline) {
        login.status = "expired";
        login.message = "二维码已过期，请重新扫码。";
        clearInterval(timer);
        return;
      }
      try {
        const poll = await post<{
          status?: string;
          client_id?: string;
          client_secret?: string;
          fail_reason?: string;
        }>("/app/registration/poll", { device_code: deviceCode });
        const status = String(poll.status ?? "").trim().toUpperCase();
        if (status === "WAITING") return;
        if (status === "SUCCESS") {
          const clientId = String(poll.client_id ?? "").trim();
          const clientSecret = String(poll.client_secret ?? "").trim();
          if (!clientId || !clientSecret) {
            login.status = "error";
            login.message = "授权成功但未返回机器人凭证。";
          } else {
            login.clientId = clientId;
            login.clientSecret = clientSecret;
            login.status = "confirmed";
            login.message = "机器人创建成功！AppKey 已自动填入。";
          }
          clearInterval(timer);
          return;
        }
        if (status === "FAIL") {
          login.status = "error";
          login.message = String(poll.fail_reason ?? "授权失败").trim();
          clearInterval(timer);
          return;
        }
        if (status === "EXPIRED") {
          login.status = "expired";
          login.message = "二维码已过期，请重新扫码。";
          clearInterval(timer);
          return;
        }
      } catch (err) {
        // 网络抖动继续轮询，最终由 deadline 收尾。
        if (login.status !== "running") {
          login.status = "error";
          login.message = err instanceof Error ? err.message : String(err);
          clearInterval(timer);
        }
      }
    })().catch(() => {});
  }, intervalMs);
  login.stop = () => clearInterval(timer);

  return snapshot(login);
}

/** 读取当前快照（不存在返回 null）。 */
export function getLoginStatus(loginId: string): DingtalkRegisterStatus | null {
  const l = logins.get(loginId);
  return l ? snapshot(l) : null;
}

/** 取消进行中的注册。 */
export function cancelLogin(loginId: string): void {
  const l = logins.get(loginId);
  if (!l) return;
  l.stop?.();
  l.status = "canceled";
  l.message = "注册已取消。";
}
