/**
 * 飞书「扫码一键创建应用」—— 官方 RFC 8628 设备授权流程
 * （`@larksuiteoapi/node-sdk` 的 `registerApp`）。
 *
 * 与钉钉 `/app/registration/*` 同构：用户用飞书 App 扫码，官方后端**代为创建**一个
 * 已预置权限与会话事件订阅的机器人，回传 `client_id` / `client_secret` —— 无需手工
 * 去开放平台建应用、勾权限。
 *
 * 采用同一「快照 + 前端轮询」模型（参考项目 dsh-im-gateway 的 feishu-register.ts）：
 * startLogin() 立刻返回快照，后台跑 registerApp，UI 轮询 getLoginStatus() 直到 confirmed。
 *
 * 预置项只声明本通道真正需要的四件：
 *   - scopes: im:message / im:message:send_as_bot / im:resource /
 *             cardkit:card:write（流式卡片；缺失则流式失效，自动降级为表情）
 *   - events: im.message.receive_v1
 * 事件订阅方式（长连接）属敏感配置，不能通过 addons 传入 —— 若官方基座默认不是长连接，
 * 用户仍需在开放平台把订阅方式改一次。
 */
import { randomUUID } from "node:crypto";
import QRCode from "qrcode";

/** 返回给调用方（设置页）的快照。 */
export interface FeishuRegisterStatus {
  loginId: string;
  status: "running" | "confirmed" | "error" | "canceled" | "expired";
  /** 二维码图片 data URL（UI 用 <img> 展示）。 */
  qrcodeUrl: string;
  /** 原始二维码内容 URL（兜底链接）。 */
  qrcode: string;
  message: string;
  /** status === "confirmed" 时给出。domain 对应渠道配置的 `brand`。 */
  credentials?: { appId: string; clientSecret: string; domain: "feishu" | "lark" };
}

interface ActiveLogin {
  loginId: string;
  status: FeishuRegisterStatus["status"];
  qrcodeUrl: string;
  qrcode: string;
  message: string;
  startedAt: number;
  /** 取消 registerApp（SDK 原生支持 AbortSignal）。 */
  abort: AbortController;
  appId?: string;
  clientSecret?: string;
  domain?: "feishu" | "lark";
}

const logins = new Map<string, ActiveLogin>();

/** 首帧尽量带上二维码的等待上限（ms）—— 超时也返回，UI 会轮询补图。 */
const FIRST_QR_WAIT_MS = 4_000;

function snapshot(l: ActiveLogin): FeishuRegisterStatus {
  const s: FeishuRegisterStatus = {
    loginId: l.loginId,
    status: l.status,
    qrcodeUrl: l.qrcodeUrl,
    qrcode: l.qrcode,
    message: l.message,
  };
  if (l.status === "confirmed" && l.appId && l.clientSecret) {
    s.credentials = {
      appId: l.appId,
      clientSecret: l.clientSecret,
      domain: l.domain ?? "feishu",
    };
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
 * 发起一次飞书机器人扫码创建。立即返回快照（通常已含二维码），
 * `registerApp` 在后台运行，UI 轮询 getLoginStatus() 获取最终结果。
 */
export async function startLogin(): Promise<FeishuRegisterStatus> {
  purgeStale();
  const loginId = randomUUID();
  const abort = new AbortController();
  const login: ActiveLogin = {
    loginId,
    status: "running",
    qrcodeUrl: "",
    qrcode: "",
    message: "正在向飞书申请二维码…",
    startedAt: Date.now(),
    abort,
  };
  logins.set(loginId, login);

  // registerApp 会阻塞到「扫码完成 / 取消 / 失败」，因此放后台跑。
  void (async () => {
    try {
      const lark = await import("@larksuiteoapi/node-sdk");
      const result = await lark.registerApp({
        source: "pi-desktop",
        signal: abort.signal,
        onQRCodeReady: (info: { url: string }) => {
          login.qrcode = info.url;
          login.message = "请用飞书 App 扫码，一键创建机器人（权限与会话事件已预填）。";
          void QRCode.toDataURL(info.url, { width: 240, margin: 1 })
            .then((url) => {
              login.qrcodeUrl = url;
            })
            .catch(() => {
              login.message = "二维码渲染失败，可用下方链接扫码。";
            });
        },
        onStatusChange: (info: { status: string }) => {
          if (info.status === "slow_down") login.message = "操作过于频繁，正在放慢轮询…";
          else if (info.status === "domain_switched")
            login.message = "已切换到国际版 Lark 域名，请继续扫码。";
        },
        appPreset: {
          name: "Pi 桌面助手",
          desc: "Pi Desktop IM 网关机器人",
        },
        addons: {
          preset: true,
          scopes: {
            tenant: [
              "im:message",
              "im:message:send_as_bot",
              "im:resource",
              // 流式输出必需：飞书没有原生逐字气泡，打字机效果只能靠 CardKit 卡片。
              "cardkit:card:write",
            ],
          },
          events: {
            items: { tenant: ["im.message.receive_v1"] },
          },
        },
      });

      const appId = String(result?.client_id ?? "").trim();
      const clientSecret = String(result?.client_secret ?? "").trim();
      if (!appId || !clientSecret) {
        login.status = "error";
        login.message = "授权成功但未返回应用凭据。";
        return;
      }
      login.appId = appId;
      login.clientSecret = clientSecret;
      login.domain = result?.user_info?.tenant_brand === "lark" ? "lark" : "feishu";
      login.status = "confirmed";
      login.message = "机器人创建成功！App ID 已自动填入。";
    } catch (err) {
      if (login.status === "canceled") return;
      const msg = err instanceof Error ? err.message : String(err);
      // abort 触发的取消不是错误。
      if (abort.signal.aborted || /abort/i.test(msg)) {
        if (login.status === "running") {
          login.status = "canceled";
          login.message = "注册已取消。";
        }
        return;
      }
      login.status = "error";
      login.message = msg || "扫码创建失败，请重试或手动填写 App ID / App Secret。";
    }
  })();

  // 等一小会儿让二维码就绪（够快就首帧带图；否则交给 UI 轮询）。
  const deadline = Date.now() + FIRST_QR_WAIT_MS;
  while (!login.qrcodeUrl && login.status === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return snapshot(login);
}

/** 读取当前快照（不存在返回 null）。 */
export function getLoginStatus(loginId: string): FeishuRegisterStatus | null {
  const l = logins.get(loginId);
  return l ? snapshot(l) : null;
}

/** 取消进行中的扫码创建。 */
export function cancelLogin(loginId: string): void {
  const l = logins.get(loginId);
  if (!l) return;
  try {
    l.abort.abort();
  } catch {
    /* ignore */
  }
  if (l.status === "running") {
    l.status = "canceled";
    l.message = "注册已取消。";
  }
}
