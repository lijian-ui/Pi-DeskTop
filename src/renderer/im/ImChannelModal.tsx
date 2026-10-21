/**
 * Add / edit IM channel modal.
 *
 * Structure:
 *   渠道名称  [输入框]
 *   渠道类型  [下拉：钉钉 / 微信 / QQ 机器人]
 *   配置项    (随类型变化 — 钉钉显示 clientId/clientSecret；微信显示扫码绑定)
 *   保存 / 取消
 */
import { useEffect, useMemo, useState } from "react";
import { X, Check, FolderOpen, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  DingtalkRegisterStatus,
  FeishuRegisterStatus,
  ImChannelInstance,
  ImChannelType,
  QqLoginStatus,
  WeixinLoginStatus,
} from "../../preload/api";
import styles from "./ImChannelModal.module.css";

/** Channel types the UI lets the user pick from. */
const CHANNEL_TYPES: ImChannelType[] = ["dingtalk", "weixin", "qq", "feishu"];

/**
 * Channels whose adapter implements `sendVoice` — only these get the TTS
 * voice-reply switches. Keep in sync with the adapters in src/main/im/*.
 * qq → SILK, feishu → Opus(OGG), dingtalk → AMR-NB.
 */
const VOICE_CAPABLE_TYPES: ImChannelType[] = ["qq", "feishu", "dingtalk"];

function newId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `ch-${Date.now()}`;
}

/**
 * Field spec per channel type — drives which credential inputs render.
 * key = instance.config key; labelKey = i18n label.
 * WeChat / QQ have NO appId/appSecret inputs: both are bound via QR scan
 * (credentials written by the login flow), so their field lists are empty.
 */
const TYPE_FIELDS: Record<
  ImChannelType,
  { key: string; labelKey: string; secret?: boolean; optional?: boolean }[]
> = {
  dingtalk: [
    { key: "clientId", labelKey: "im.clientId" },
    { key: "clientSecret", labelKey: "im.clientSecret", secret: true },
  ],
  feishu: [
    { key: "appId", labelKey: "im.feishuAppId" },
    { key: "appSecret", labelKey: "im.feishuAppSecret", secret: true },
    { key: "encryptKey", labelKey: "im.feishuEncryptKey", secret: true, optional: true },
    { key: "verificationToken", labelKey: "im.feishuVerificationToken", secret: true, optional: true },
    { key: "brand", labelKey: "im.feishuBrand", optional: true },
  ],
  weixin: [],
  qq: [],
};

const NOT_IMPL: Record<ImChannelType, string | null> = {
  dingtalk: null,
  feishu: null,
  weixin: null,
  qq: null,
};

/** 钉钉 / 飞书扫码创建共用的快照形状（两家字段一致）。 */
type QrLoginSnapshot = {
  loginId: string;
  status: "running" | "confirmed" | "error" | "canceled" | "expired";
  qrcodeUrl: string;
  qrcode: string;
  message: string;
};

/**
 * 扫码创建块（钉钉代建机器人 / 飞书代建应用）——两家的交互完全一致，
 * 只是文案与回调不同，所以抽成一个组件，避免两份重复的 JSX。
 */
function QrCreateBlock({
  title,
  hint,
  startLabel,
  fetchingLabel,
  boundText,
  login,
  fetching,
  qrError,
  onStart,
  onCancel,
  onRebind,
  onQrError,
}: {
  title: string;
  hint: string;
  startLabel: string;
  fetchingLabel: string;
  /** 已绑定/已创建时的摘要文案；空串表示尚未绑定。 */
  boundText: string;
  login: QrLoginSnapshot | null;
  fetching: boolean;
  qrError: boolean;
  onStart: () => void;
  onCancel: () => void;
  onRebind: () => void;
  onQrError: () => void;
}) {
  const { t } = useTranslation();
  const confirmed = login?.status === "confirmed";
  const hasBound = Boolean(boundText);
  const settled =
    login?.status === "error" || login?.status === "canceled" || login?.status === "expired";

  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{title}</span>

      {(confirmed || (!login && hasBound)) && (
        <div className={styles.wxBound}>
          <Check size={16} />
          <span>{boundText}</span>
        </div>
      )}

      {!login && !hasBound && (
        <>
          <p className={styles.fieldHint}>{hint}</p>
          <button
            type="button"
            className={styles.wxBindBtn}
            onClick={onStart}
            disabled={fetching}
          >
            {fetching ? fetchingLabel : startLabel}
          </button>
        </>
      )}

      {login && !confirmed && (
        <div className={styles.wxQrArea}>
          {login.qrcodeUrl ? (
            <img
              className={styles.wxQrImg}
              src={login.qrcodeUrl}
              alt="QR"
              onError={onQrError}
            />
          ) : (
            <div className={styles.wxQrEmpty}>{fetchingLabel}</div>
          )}

          <div className={styles.wxStatus}>{login.message}</div>

          {qrError && login.qrcode && (
            <p className={styles.wxLink}>
              {t("im.qrLinkFallback")}
              <span className={styles.wxLinkUrl}>{login.qrcode}</span>
            </p>
          )}

          <div className={styles.wxActions}>
            {settled && (
              <button
                type="button"
                className={styles.wxBindBtn}
                onClick={onStart}
                disabled={fetching}
              >
                {startLabel}
              </button>
            )}
            <button type="button" className={styles.wxGhostBtn} onClick={onCancel}>
              {t("im.qrCancel")}
            </button>
          </div>
        </div>
      )}

      {(confirmed || hasBound) && (
        <button
          type="button"
          className={styles.wxGhostBtn}
          onClick={onRebind}
          disabled={fetching}
        >
          {t("im.qrRebind")}
        </button>
      )}
    </div>
  );
}

export default function ImChannelModal({
  editInstance = null,
  onClose,
  onSave,
}: {
  editInstance?: ImChannelInstance | null;
  onClose: () => void;
  onSave: (instance: ImChannelInstance) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(editInstance?.name ?? "");
  const [type, setType] = useState<ImChannelType>(editInstance?.type ?? "dingtalk");
  const [config, setConfig] = useState<Record<string, string>>(
    editInstance?.config ?? {},
  );
  const [workspace, setWorkspace] = useState(editInstance?.cwd ?? "");
  const [ttsReply, setTtsReply] = useState(editInstance?.ttsReply ?? false);
  const [ttsVoiceOnly, setTtsVoiceOnly] = useState(editInstance?.ttsVoiceOnly ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const fields = TYPE_FIELDS[type];
  const notImpl = NOT_IMPL[type];
  const supportsVoice = VOICE_CAPABLE_TYPES.includes(type);

  // ── WeChat QR bind state ──
  const [wxLogin, setWxLogin] = useState<WeixinLoginStatus | null>(null);
  const [wxFetching, setWxFetching] = useState(false);
  const [wxVerifyCode, setWxVerifyCode] = useState("");
  const [wxVerifyError, setWxVerifyError] = useState(false);
  const [wxQrError, setWxQrError] = useState(false);

  // ── QQ QR bind state ──
  const [qqLogin, setQqLogin] = useState<QqLoginStatus | null>(null);
  const [qqFetching, setQqFetching] = useState(false);
  const [qqQrError, setQqQrError] = useState(false);
  const boundQqAppId = type === "qq" ? (config["appId"] ?? "") : "";
  // Already-bound instance → show bound summary + rebind button.
  const boundBotId = type === "weixin" ? (config["botId"] ?? "") : "";

  // ── DingTalk / Feishu QR create state ──
  const [dtLogin, setDtLogin] = useState<DingtalkRegisterStatus | null>(null);
  const [dtFetching, setDtFetching] = useState(false);
  const [dtQrError, setDtQrError] = useState(false);
  const [fsLogin, setFsLogin] = useState<FeishuRegisterStatus | null>(null);
  const [fsFetching, setFsFetching] = useState(false);
  const [fsQrError, setFsQrError] = useState(false);

  const startWxLogin = async () => {
    setWxFetching(true);
    setWxVerifyError(false);
    setWxVerifyCode("");
    setWxQrError(false);
    try {
      const s = await window.piDesk.imWeixinStartLogin();
      setWxLogin(s);
    } catch (err) {
      setWxLogin({
        loginId: "",
        status: "error",
        qrcodeUrl: "",
        qrcode: "",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setWxFetching(false);
    }
  };

  const cancelWxLogin = () => {
    if (wxLogin?.loginId) void window.piDesk.imWeixinCancelLogin(wxLogin.loginId);
    setWxLogin(null);
  };

  const startQqLogin = async () => {
    setQqFetching(true);
    setQqQrError(false);
    try {
      const s = await window.piDesk.imQqStartLogin();
      setQqLogin(s);
    } catch (err) {
      setQqLogin({
        loginId: "",
        status: "error",
        qrcodeUrl: "",
        qrcode: "",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setQqFetching(false);
    }
  };

  const cancelQqLogin = () => {
    if (qqLogin?.loginId) void window.piDesk.imQqCancelLogin(qqLogin.loginId);
    setQqLogin(null);
  };

  const submitWxVerifyCode = () => {
    if (!wxLogin?.loginId || !wxVerifyCode.trim()) return;
    void window.piDesk.imWeixinSubmitVerifyCode(wxLogin.loginId, wxVerifyCode.trim());
    setWxVerifyError(false);
  };

  // ── DingTalk QR create（官方设备码流程：扫码后代建机器人）──
  const startDtLogin = async () => {
    setDtFetching(true);
    setDtQrError(false);
    try {
      setDtLogin(await window.piDesk.imDingtalkStartLogin());
    } catch (err) {
      setDtLogin({
        loginId: "",
        status: "error",
        qrcodeUrl: "",
        qrcode: "",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDtFetching(false);
    }
  };

  const cancelDtLogin = () => {
    if (dtLogin?.loginId) void window.piDesk.imDingtalkCancelLogin(dtLogin.loginId);
    setDtLogin(null);
  };

  const rebindDt = async () => {
    cancelDtLogin();
    await startDtLogin();
  };

  // ── Feishu QR create（官方 registerApp：扫码代建应用）──
  const startFsLogin = async () => {
    setFsFetching(true);
    setFsQrError(false);
    try {
      setFsLogin(await window.piDesk.imFeishuStartLogin());
    } catch (err) {
      setFsLogin({
        loginId: "",
        status: "error",
        qrcodeUrl: "",
        qrcode: "",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setFsFetching(false);
    }
  };

  const cancelFsLogin = () => {
    if (fsLogin?.loginId) void window.piDesk.imFeishuCancelLogin(fsLogin.loginId);
    setFsLogin(null);
  };

  const rebindFs = async () => {
    cancelFsLogin();
    await startFsLogin();
  };

  // Poll the DingTalk snapshot until it settles.
  useEffect(() => {
    if (!dtLogin?.loginId) return;
    if (dtLogin.status !== "running") return;
    const iv = setInterval(async () => {
      const s = await window.piDesk.imDingtalkLoginStatus(dtLogin.loginId);
      if (!s) {
        clearInterval(iv);
        return;
      }
      setDtLogin(s);
      if (s.status === "confirmed" && s.credentials) {
        const c = s.credentials;
        setConfig((prev) => ({ ...prev, clientId: c.clientId, clientSecret: c.clientSecret }));
      }
    }, 2000);
    return () => clearInterval(iv);
  }, [dtLogin?.loginId, dtLogin?.status]);

  // Poll the Feishu snapshot until it settles.
  useEffect(() => {
    if (!fsLogin?.loginId) return;
    if (fsLogin.status !== "running") return;
    const iv = setInterval(async () => {
      const s = await window.piDesk.imFeishuLoginStatus(fsLogin.loginId);
      if (!s) {
        clearInterval(iv);
        return;
      }
      setFsLogin(s);
      if (s.status === "confirmed" && s.credentials) {
        const c = s.credentials;
        // 飞书适配器读的是 appSecret / brand（register 返回 clientSecret / domain）。
        setConfig((prev) => ({
          ...prev,
          appId: c.appId,
          appSecret: c.clientSecret,
          brand: c.domain,
        }));
      }
    }, 2000);
    return () => clearInterval(iv);
  }, [fsLogin?.loginId, fsLogin?.status]);

  // Poll the login snapshot while one is in flight.
  useEffect(() => {
    if (!wxLogin || !wxLogin.loginId) return;
    const done =
      wxLogin.status === "confirmed" ||
      wxLogin.status === "error" ||
      wxLogin.status === "canceled";
    if (done) return;
    const iv = setInterval(async () => {
      const s = await window.piDesk.imWeixinLoginStatus(wxLogin.loginId);
      if (!s) {
        clearInterval(iv);
        return;
      }
      setWxLogin(s);
      if (s.status === "confirmed" && s.credentials) {
        const c = s.credentials;
        // Functional update — never rely on a captured `config` snapshot.
        setConfig((prev) => ({
          ...prev,
          token: c.token,
          botId: c.botId,
          baseUrl: c.baseUrl,
          userId: c.userId ?? "",
        }));
        setWxVerifyError(false);
      }
      if (s.status === "need_verifycode") {
        setWxVerifyError(Boolean(wxVerifyCode.trim()));
      }
    }, 2000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wxLogin?.loginId, wxLogin?.status]);

  // Poll the QQ login snapshot while one is in flight.
  useEffect(() => {
    if (!qqLogin || !qqLogin.loginId) return;
    const done = qqLogin.status === "confirmed" || qqLogin.status === "error" || qqLogin.status === "canceled";
    if (done) return;
    const iv = setInterval(async () => {
      const s = await window.piDesk.imQqLoginStatus(qqLogin.loginId);
      if (!s) {
        clearInterval(iv);
        return;
      }
      setQqLogin(s);
      if (s.status === "confirmed" && s.credentials) {
        const c = s.credentials;
        setConfig((prev) => ({ ...prev, appId: c.appId, appSecret: c.appSecret }));
      }
    }, 2000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qqLogin?.loginId, qqLogin?.status]);

  const canSave = useMemo(() => {
    if (!name.trim()) return false;
    if (type === "weixin") {
      // WeChat: binding must have completed (token written into config).
      return Boolean(config["token"] && config["botId"]);
    }
    if (type === "qq") {
      // QQ: binding must have completed (appId/appSecret written).
      return Boolean(config["appId"] && config["appSecret"]);
    }
    return fields.every((f) => f.optional || (config[f.key] ?? "").trim() !== "");
  }, [name, config, fields, type]);

  const handlePickWorkspace = async () => {
    setError("");
    const picked = await window.piDesk.pickWorkspace();
    if (picked) setWorkspace(picked);
  };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError("");
    const trimmedWs = workspace.trim();
    const instance: ImChannelInstance = {
      id: editInstance?.id ?? newId(),
      name: name.trim(),
      type,
      enabled: editInstance?.enabled ?? true,
      config,
      cwd: trimmedWs ? trimmedWs : undefined,
      ttsReply: supportsVoice ? ttsReply : undefined,
      ttsVoiceOnly: supportsVoice ? ttsVoiceOnly : undefined,
    };
    try {
      await onSave(instance);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={styles.overlay}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        {/* ── Header ── */}
        <div className={styles.header}>
          <h3 className={styles.title}>
            {editInstance ? t("im.editChannel") : t("im.addChannel")}
          </h3>
          <button className={styles.closeBtn} onClick={onClose} title={t("close")}>
            <X size={16} />
          </button>
        </div>

        {/* ── Body ── */}
        <div className={styles.body}>
          {/* 渠道名称 */}
          <label className={styles.field}>
            <span className={styles.fieldLabel}>
              {t("im.channelName")}
              <span className={styles.required}>*</span>
            </span>
            <input
              className={styles.fieldInput}
              type="text"
              placeholder={t("im.channelNamePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>

          {/* 渠道类型 */}
          <label className={styles.field}>
            <span className={styles.fieldLabel}>
              {t("im.channelType")}
              <span className={styles.required}>*</span>
            </span>
            <select
              className={styles.fieldInput}
              value={type}
              disabled={!!editInstance}
              onChange={(e) => {
                setType(e.target.value as ImChannelType);
                setConfig({});
              }}
            >
              {CHANNEL_TYPES.map((ct) => (
                <option key={ct} value={ct}>
                  {t(`im.${ct}`)}
                </option>
              ))}
            </select>
          </label>

          {/* 类型相关配置 */}
          {type === "weixin" ? (
            <div className={styles.field}>
              <span className={styles.fieldLabel}>{t("im.weixinBindTitle")}</span>

              {wxLogin && wxLogin.status === "confirmed" && (
                <div className={styles.wxBound}>
                  <Check size={16} />
                  <span>{t("im.weixinBound", { botId: config["botId"] ?? "" })}</span>
                </div>
              )}

              {!wxLogin && boundBotId && (
                <div className={styles.wxBound}>
                  <Check size={16} />
                  <span>{t("im.weixinBound", { botId: boundBotId })}</span>
                </div>
              )}

              {!wxLogin && !boundBotId && (
                <>
                  <p className={styles.fieldHint}>{t("im.weixinBindHint")}</p>
                  <button
                    type="button"
                    className={styles.wxBindBtn}
                    onClick={() => void startWxLogin()}
                    disabled={wxFetching}
                  >
                    {wxFetching ? t("im.weixinFetching") : t("im.weixinBindStart")}
                  </button>
                </>
              )}

              {wxLogin && wxLogin.status !== "confirmed" && (
                <div className={styles.wxQrArea}>
                  {wxLogin.qrcodeUrl ? (
                    <img
                      className={styles.wxQrImg}
                      src={wxLogin.qrcodeUrl}
                      alt="WeChat QR"
                      onError={() => setWxQrError(true)}
                    />
                  ) : (
                    <div className={styles.wxQrEmpty}>{t("im.weixinFetching")}</div>
                  )}

                  <div className={styles.wxStatus}>
                    {wxLogin.status === "scaned" && t("im.weixinScaned")}
                    {wxLogin.status === "need_verifycode" && t("im.weixinNeedVerifyCode")}
                    {(wxLogin.status === "running" || wxLogin.status === "wait" || wxLogin.status === "expired") &&
                      t("im.weixinScanWait")}
                    {wxLogin.status === "error" && t("im.weixinError", { message: wxLogin.message })}
                    {wxLogin.status === "canceled" && wxLogin.message}
                  </div>

                  {wxQrError && wxLogin.qrcode && (
                    <p className={styles.wxLink}>
                      {t("im.weixinLinkFallback")}
                      <span className={styles.wxLinkUrl}>{wxLogin.qrcode}</span>
                    </p>
                  )}

                  {wxLogin.status === "need_verifycode" && (
                    <div className={styles.wxVerifyRow}>
                      <input
                        className={styles.fieldInput}
                        type="text"
                        placeholder={t("im.weixinVerifyCodePlaceholder")}
                        value={wxVerifyCode}
                        onChange={(e) => {
                          setWxVerifyCode(e.target.value);
                          setWxVerifyError(false);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") submitWxVerifyCode();
                        }}
                      />
                      <button
                        type="button"
                        className={styles.wxBindBtn}
                        onClick={submitWxVerifyCode}
                        disabled={!wxVerifyCode.trim()}
                      >
                        {t("im.weixinVerifySubmit")}
                      </button>
                    </div>
                  )}
                  {wxVerifyError && (
                    <div className={styles.wxError}>{t("im.weixinVerifyError")}</div>
                  )}

                  <div className={styles.wxActions}>
                    {(wxLogin.status === "error" || wxLogin.status === "canceled") && (
                      <button
                        type="button"
                        className={styles.wxBindBtn}
                        onClick={() => void startWxLogin()}
                        disabled={wxFetching}
                      >
                        {t("im.weixinBindStart")}
                      </button>
                    )}
                    <button type="button" className={styles.wxGhostBtn} onClick={cancelWxLogin}>
                      {t("im.weixinCancel")}
                    </button>
                  </div>
                </div>
              )}

              {(boundBotId || wxLogin?.status === "confirmed") && (
                <button
                  type="button"
                  className={styles.wxGhostBtn}
                  onClick={() => {
                    setWxLogin(null);
                    void startWxLogin();
                  }}
                  disabled={wxFetching}
                >
                  {t("im.weixinRebind")}
                </button>
              )}
            </div>
          ) : type === "qq" ? (
            <div className={styles.field}>
              <span className={styles.fieldLabel}>{t("im.qqBindTitle")}</span>

              {qqLogin && qqLogin.status === "confirmed" && (
                <div className={styles.wxBound}>
                  <Check size={16} />
                  <span>{t("im.qqBound", { appId: config["appId"] ?? "" })}</span>
                </div>
              )}

              {!qqLogin && boundQqAppId && (
                <div className={styles.wxBound}>
                  <Check size={16} />
                  <span>{t("im.qqBound", { appId: boundQqAppId })}</span>
                </div>
              )}

              {!qqLogin && !boundQqAppId && (
                <>
                  <p className={styles.fieldHint}>{t("im.qqBindHint")}</p>
                  <button
                    type="button"
                    className={styles.wxBindBtn}
                    onClick={() => void startQqLogin()}
                    disabled={qqFetching}
                  >
                    {qqFetching ? t("im.qqFetching") : t("im.qqBindStart")}
                  </button>
                </>
              )}

              {qqLogin && qqLogin.status !== "confirmed" && (
                <div className={styles.wxQrArea}>
                  {qqLogin.qrcodeUrl ? (
                    <img
                      className={styles.wxQrImg}
                      src={qqLogin.qrcodeUrl}
                      alt="QQ QR"
                      onError={() => setQqQrError(true)}
                    />
                  ) : (
                    <div className={styles.wxQrEmpty}>{t("im.qqFetching")}</div>
                  )}

                  <div className={styles.wxStatus}>
                    {qqLogin.status === "error"
                      ? qqLogin.message
                      : t("im.qqScanWait")}
                  </div>

                  {qqQrError && qqLogin.qrcode && (
                    <p className={styles.wxLink}>
                      {t("im.qqLinkFallback")}
                      <span className={styles.wxLinkUrl}>{qqLogin.qrcode}</span>
                    </p>
                  )}

                  <div className={styles.wxActions}>
                    {qqLogin.status === "error" && (
                      <button
                        type="button"
                        className={styles.wxBindBtn}
                        onClick={() => void startQqLogin()}
                        disabled={qqFetching}
                      >
                        {t("im.qqBindStart")}
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.wxGhostBtn}
                      onClick={cancelQqLogin}
                    >
                      {t("im.qqCancel")}
                    </button>
                  </div>
                </div>
              )}

              {(boundQqAppId || qqLogin?.status === "confirmed") && (
                <button
                  type="button"
                  className={styles.wxGhostBtn}
                  onClick={() => {
                    setQqLogin(null);
                    void startQqLogin();
                  }}
                  disabled={qqFetching}
                >
                  {t("im.qqRebind")}
                </button>
              )}
            </div>
          ) : type === "dingtalk" || type === "feishu" ? (
            <>
              {type === "dingtalk" && (
                <QrCreateBlock
                  title={t("im.dingtalkBindTitle")}
                  hint={t("im.dingtalkBindHint")}
                  startLabel={t("im.dingtalkBindStart")}
                  fetchingLabel={t("im.dingtalkFetching")}
                  boundText={
                    dtLogin?.credentials?.clientId ?? config["clientId"]
                      ? t("im.dingtalkBound", {
                          clientId: dtLogin?.credentials?.clientId ?? config["clientId"],
                        })
                      : ""
                  }
                  login={dtLogin}
                  fetching={dtFetching}
                  qrError={dtQrError}
                  onStart={() => void startDtLogin()}
                  onCancel={cancelDtLogin}
                  onRebind={() => void rebindDt()}
                  onQrError={() => setDtQrError(true)}
                />
              )}
              {type === "feishu" && (
                <QrCreateBlock
                  title={t("im.feishuBindTitle")}
                  hint={t("im.feishuBindHint")}
                  startLabel={t("im.feishuBindStart")}
                  fetchingLabel={t("im.feishuFetching")}
                  boundText={
                    fsLogin?.credentials?.appId ?? config["appId"]
                      ? t("im.feishuBound", {
                          appId: fsLogin?.credentials?.appId ?? config["appId"],
                        })
                      : ""
                  }
                  login={fsLogin}
                  fetching={fsFetching}
                  qrError={fsQrError}
                  onStart={() => void startFsLogin()}
                  onCancel={cancelFsLogin}
                  onRebind={() => void rebindFs()}
                  onQrError={() => setFsQrError(true)}
                />
              )}
              {fields.map((f) => (
                <label key={f.key} className={styles.field}>
                  <span className={styles.fieldLabel}>
                    {t(f.labelKey)}
                    {!f.optional && <span className={styles.required}>*</span>}
                  </span>
                  <input
                    className={styles.fieldInput}
                    type={f.secret ? "password" : "text"}
                    value={config[f.key] ?? ""}
                    placeholder={f.secret ? "••••••••" : f.optional ? t("common.optional") : ""}
                    onChange={(e) =>
                      setConfig({ ...config, [f.key]: e.target.value })
                    }
                  />
                </label>
              ))}
            </>
          ) : (
            fields.map((f) => (
              <label key={f.key} className={styles.field}>
                <span className={styles.fieldLabel}>
                  {t(f.labelKey)}
                  {!f.optional && <span className={styles.required}>*</span>}
                </span>
                <input
                  className={styles.fieldInput}
                  type={f.secret ? "password" : "text"}
                  value={config[f.key] ?? ""}
                  placeholder={f.secret ? "••••••••" : f.optional ? t("common.optional") : ""}
                  onChange={(e) =>
                    setConfig({ ...config, [f.key]: e.target.value })
                  }
                />
              </label>
            ))
          )}

          {notImpl && <div className={styles.notImpl}>{t(notImpl)}</div>}

          {/* Channel-level command approval (Linear-style row: label + desc + compact switch). */}
          <div className={styles.field}>
            <div className={styles.approvalRow}>
              <div className={styles.approvalCopy}>
                <span className={styles.fieldLabel}>{t("im.approval")}</span>
                <span className={styles.approvalHint}>{t("im.approvalHint")}</span>
              </div>
              <label
                className={`${styles.approvalSwitch} ${
                  config["approval"] === "on" ? styles.approvalSwitchOn : ""
                }`}
              >
                <input
                  type="checkbox"
                  checked={config["approval"] === "on"}
                  onChange={(e) =>
                    setConfig({ ...config, approval: e.target.checked ? "on" : "off" })
                  }
                />
                <span className={styles.approvalSlider} />
              </label>
            </div>
          </div>

          {/* TTS voice reply (channels whose adapter implements sendVoice) */}
          {supportsVoice && (
            <div className={styles.field}>
              <div className={styles.approvalRow}>
                <div className={styles.approvalCopy}>
                  <span className={styles.fieldLabel}>{t("im.ttsReply")}</span>
                  <span className={styles.approvalHint}>{t("im.ttsReplyHint")}</span>
                </div>
                <label
                  className={`${styles.approvalSwitch} ${
                    ttsReply ? styles.approvalSwitchOn : ""
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={ttsReply}
                    onChange={(e) => {
                      const v = e.target.checked;
                      setTtsReply(v);
                      if (!v) setTtsVoiceOnly(false);
                    }}
                  />
                  <span className={styles.approvalSlider} />
                </label>
              </div>
            </div>
          )}

          {/* Voice-only mode (voice-capable channels; auto-enables voice reply) */}
          {supportsVoice && (
            <div className={styles.field}>
              <div className={styles.approvalRow}>
                <div className={styles.approvalCopy}>
                  <span className={styles.fieldLabel}>{t("im.ttsVoiceOnly")}</span>
                  <span className={styles.approvalHint}>{t("im.ttsVoiceOnlyHint")}</span>
                </div>
                <label
                  className={`${styles.approvalSwitch} ${
                    ttsVoiceOnly ? styles.approvalSwitchOn : ""
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={ttsVoiceOnly}
                    onChange={(e) => {
                      const v = e.target.checked;
                      if (v) setTtsReply(true);
                      setTtsVoiceOnly(v);
                    }}
                  />
                  <span className={styles.approvalSlider} />
                </label>
              </div>
            </div>
          )}

          {/* 默认工作区（可选） */}
          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t("im.workspace")}</span>
            <div className={styles.workspaceRow}>
              <span
                className={
                  workspace
                    ? styles.workspacePath
                    : `${styles.workspacePath} ${styles.workspacePathEmpty}`
                }
                title={workspace || undefined}
              >
                {workspace || t("im.workspaceNone")}
              </span>
              <button
                type="button"
                className={styles.workspaceBtn}
                onClick={handlePickWorkspace}
                title={t("im.workspacePick")}
              >
                <FolderOpen size={14} />
                <span>{t("im.workspacePick")}</span>
              </button>
              {workspace && (
                <button
                  type="button"
                  className={styles.workspaceBtn}
                  onClick={() => setWorkspace("")}
                  title={t("im.workspaceClear")}
                >
                  <RotateCcw size={14} />
                </button>
              )}
            </div>
            <span className={styles.fieldHint}>{t("im.workspaceHint")}</span>
          </div>

          {error && <div className={styles.error}>{error}</div>}
        </div>

        {/* ── Footer ── */}
        <div className={styles.footer}>
          <button className={styles.btnGhost} onClick={onClose}>
            {t("cancel")}
          </button>
          <button
            className={styles.btnPrimary}
            onClick={handleSave}
            disabled={saving || !canSave}
          >
            {saving ? (
              t("im.saving")
            ) : (
              <>
                <Check size={15} />
                <span>{t("im.save")}</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
