import { useEffect, useState } from "react";
import { X, Eye, EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TtsConfigItem } from "../../preload/api";
import { MIMO_VOICES } from "../../shared/tts-voices";
import styles from "./TtsConfigModal.module.css";

interface Props {
  onClose: () => void;
  onSave: (item: TtsConfigItem) => Promise<void>;
  editing?: TtsConfigItem | null;
}

export default function TtsConfigModal({ onClose, onSave, editing }: Props) {
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState("");
  const [voice, setVoice] = useState<string>(MIMO_VOICES[0].id);
  const [style, setStyle] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (editing) {
      setApiKey(editing.apiKey);
      setVoice(editing.voice);
      setStyle(editing.style);
    }
  }, [editing]);

  const handleSave = async () => {
    if (!apiKey.trim()) {
      setError(t("tts.apiKeyRequired"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const voiceLabel = MIMO_VOICES.find((v) => v.id === voice)?.label ?? voice;
      const item: TtsConfigItem = {
        id: editing?.id ?? `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: editing?.name ?? `MiMo-${voiceLabel}`,
        model: "mimo-v2.5-tts",
        apiKey: apiKey.trim(),
        voice,
        style: style.trim(),
      };
      await onSave(item);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("tts.saveFailed"));
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
        <div className={styles.header}>
          <h3 className={styles.title}>
            {editing ? t("tts.editConfig") : t("tts.addConfig")}
          </h3>
          <button className={styles.closeBtn} onClick={onClose} title={t("close")}>
            <X size={16} />
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>
              {t("tts.model")}
              <span className={styles.required}>*</span>
            </label>
            <select className={styles.fieldInput} value="mimo-v2.5-tts" disabled>
              <option value="mimo-v2.5-tts">MiMo-V2.5-TTS</option>
            </select>
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel}>
              {t("tts.apiKey")}
              <span className={styles.required}>*</span>
            </label>
            <div className={styles.inputWithAction}>
              <input
                className={styles.fieldInput}
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t("tts.apiKeyPlaceholder")}
              />
              <button
                type="button"
                className={styles.eyeBtn}
                onClick={() => setShowKey((v) => !v)}
                title={showKey ? t("tts.hideKey") : t("tts.showKey")}
              >
                {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel}>{t("tts.voice")}</label>
            <select
              className={styles.fieldInput}
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
            >
              {MIMO_VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel}>{t("tts.style")}</label>
            <textarea
              className={styles.fieldInput}
              value={style}
              onChange={(e) => setStyle(e.target.value)}
              placeholder={t("tts.stylePlaceholder")}
            />
            <span className={styles.fieldHint}>{t("tts.styleHint")}</span>
          </div>

          {error && <div className={styles.error}>{error}</div>}
        </div>

        <div className={styles.footer}>
          <button className={styles.btnGhost} onClick={onClose} disabled={saving}>
            {t("cancel")}
          </button>
          <button className={styles.btnPrimary} onClick={handleSave} disabled={saving}>
            {saving ? t("tts.saving") : t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
