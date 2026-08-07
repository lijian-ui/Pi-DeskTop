/**
 * Add / edit IM channel modal.
 *
 * Structure:
 *   渠道名称  [输入框]
 *   渠道类型  [下拉：钉钉 / 微信 / QQ 机器人]
 *   配置项    (随类型变化 — 钉钉显示 clientId/clientSecret 等)
 *   保存 / 取消
 */
import { useMemo, useState } from "react";
import { X, Check, FolderOpen, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ImChannelInstance, ImChannelType } from "../../preload/api";
import styles from "./ImChannelModal.module.css";

/** Channel types the UI lets the user pick from. */
const CHANNEL_TYPES: ImChannelType[] = ["dingtalk", "weixin", "qq"];

function newId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `ch-${Date.now()}`;
}

/**
 * Field spec per channel type — drives which credential inputs render.
 * key = instance.config key; labelKey = i18n label.
 */
const TYPE_FIELDS: Record<
  ImChannelType,
  { key: string; labelKey: string; secret?: boolean }[]
> = {
  dingtalk: [
    { key: "clientId", labelKey: "im.clientId" },
    { key: "clientSecret", labelKey: "im.clientSecret", secret: true },
  ],
  weixin: [
    { key: "appId", labelKey: "im.weixinAppId" },
    { key: "appSecret", labelKey: "im.weixinAppSecret", secret: true },
  ],
  qq: [
    { key: "appId", labelKey: "im.qqAppId" },
    { key: "appSecret", labelKey: "im.qqAppSecret", secret: true },
  ],
};

const NOT_IMPL: Record<ImChannelType, string | null> = {
  dingtalk: null,
  weixin: "im.weixinNotImpl",
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

  const canSave = useMemo(() => {
    if (!name.trim()) return false;
    return fields.every((f) => (config[f.key] ?? "").trim() !== "");
  }, [name, config, fields]);

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
          {fields.map((f) => (
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
          ))}

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
