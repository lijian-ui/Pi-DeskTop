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
import type { ImChannelInstance, ImChannelType, WeixinLoginStatus } from "../../preload/api";
import styles from "./ImChannelModal.module.css";

/** Channel types the UI lets the user pick from. */
const CHANNEL_TYPES: ImChannelType[] = ["dingtalk", "weixin", "qq"];

function newId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `ch-${Date.now()}`;
}

/**
 * Field spec per channel type — drives which credential inputs render.
 * key = instance.config key; labelKey = i18n label.
 * WeChat has NO appId/appSecret: it is bound via QR scan (token written by
 * the login flow), so its field list is empty.
 */
const TYPE_FIELDS: Record<
  ImChannelType,
  { key: string; labelKey: string; secret?: boolean }[]
> = {
  dingtalk: [
    { key: "clientId", labelKey: "im.clientId" },
    { key: "clientSecret", labelKey: "im.clientSecret", secret: true },
  ],
  weixin: [],
  qq: [
    { key: "appId", labelKey: "im.qqAppId" },
    { key: "appSecret", labelKey: "im.qqAppSecret", secret: true },
  ],
};

const NOT_IMPL: Record<ImChannelType, string | null> = {
  dingtalk: null,
  weixin: null,
  qq: "im.qqNotImpl",
};

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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const fields = TYPE_FIELDS[type];
  const notImpl = NOT_IMPL[type];

  // ── WeChat QR bind state ──
  const [wxLogin, setWxLogin] = useState<WeixinLoginStatus | null>(null);
  const [wxFetching, setWxFetching] = useState(false);
  const [wxVerifyCode, setWxVerifyCode] = useState("");
  const [wxVerifyError, setWxVerifyError] = useState(false);
  const [wxQrError, setWxQrError] = useState(false);
  // Already-bound instance → show bound summary + rebind button.
  const boundBotId = type === "weixin" ? (config["botId"] ?? "") : "";

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

  const submitWxVerifyCode = () => {
    if (!wxLogin?.loginId || !wxVerifyCode.trim()) return;
    void window.piDesk.imWeixinSubmitVerifyCode(wxLogin.loginId, wxVerifyCode.trim());
    setWxVerifyError(false);
  };

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

  const canSave = useMemo(() => {
    if (!name.trim()) return false;
    if (type === "weixin") {
      // WeChat: binding must have completed (token written into config).
      return Boolean(config["token"] && config["botId"]);
    }
    return fields.every((f) => (config[f.key] ?? "").trim() !== "");
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
          ) : (
            fields.map((f) => (
              <label key={f.key} className={styles.field}>
                <span className={styles.fieldLabel}>
                  {t(f.labelKey)}
                  <span className={styles.required}>*</span>
                </span>
                <input
                  className={styles.fieldInput}
                  type={f.secret ? "password" : "text"}
                  value={config[f.key] ?? ""}
                  placeholder={f.secret ? "••••••••" : ""}
                  onChange={(e) =>
                    setConfig({ ...config, [f.key]: e.target.value })
                  }
                />
              </label>
            ))
          )}

          {notImpl && <div className={styles.notImpl}>{t(notImpl)}</div>}

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
