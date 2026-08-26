import { useEffect, useState, useCallback, useRef } from "react";
import { Plus, Trash2, Pencil, Play, Loader2, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTtsStore } from "../store/tts-store";
import type { TtsConfigItem } from "../../preload/api";
import TtsConfigModal from "./TtsConfigModal";
import ConfirmDialog from "./ConfirmDialog";
import styles from "./TtsPage.module.css";

const TEST_TEXT = "你好TTS语言合成服务，测试成功";

export default function TtsPage() {
  const { t } = useTranslation();
  const { config, loaded, load, addConfig, updateConfig, removeConfig, setActive, setStreamEnabled } =
    useTtsStore();
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<TtsConfigItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TtsConfigItem | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const ensureLoaded = useCallback(async () => {
    if (!loaded) await load();
  }, [loaded, load]);

  useEffect(() => {
    ensureLoaded();
  }, [ensureLoaded]);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  const handleSave = async (item: TtsConfigItem) => {
    if (editing) {
      await updateConfig(item);
    } else {
      await addConfig(item);
    }
  };

  const handleConfirmDelete = async () => {
    const item = pendingDelete;
    setPendingDelete(null);
    if (!item) return;
    await removeConfig(item.id);
  };

  const handleTest = async (item: TtsConfigItem) => {
    if (playingId === item.id) {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      setPlayingId(null);
      return;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setTestingId(item.id);
    setPlayingId(null);
    try {
      const prevActive = config.activeConfigId;
      await setActive(item.id);
      const { audioBase64, format } = await window.piDesk.ttsSynthesize(TEST_TEXT);
      const mime = format === "wav" ? "audio/wav" : `audio/${format}`;
      const audio = new Audio(`data:${mime};base64,${audioBase64}`);
      audioRef.current = audio;
      audio.onended = () => {
        setPlayingId(null);
        audioRef.current = null;
      };
      audio.onerror = () => {
        setPlayingId(null);
        setTestingId(null);
        audioRef.current = null;
      };
      setTestingId(null);
      setPlayingId(item.id);
      await audio.play();
      if (prevActive !== item.id) await setActive(prevActive);
    } catch {
      setTestingId(null);
      setPlayingId(null);
    }
  };

  if (!loaded) return <div className={styles.loading}>{t("loading")}</div>;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>{t("tts.title")}</h1>
        <button className={styles.addBtn} onClick={() => { setEditing(null); setShowModal(true); }}>
          <Plus size={16} />
          <span>{t("tts.addConfig")}</span>
        </button>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>{t("tts.configs")}</h2>
        {config.configs.length === 0 ? (
          <div className={styles.emptyHint}>
            {t("tts.empty")}{" "}
            <button
              className={styles.textLink}
              onClick={() => { setEditing(null); setShowModal(true); }}
            >
              {t("tts.addNow")}
            </button>
          </div>
        ) : (
          <div className={styles.list}>
            {config.configs.map((item) => {
              const isActive = item.id === config.activeConfigId;
              const isTesting = testingId === item.id;
              const isPlaying = playingId === item.id;
              return (
                <div
                  key={item.id}
                  className={`${styles.row} ${isActive ? styles.rowActive : ""}`}
                  onClick={() => setActive(isActive ? null : item.id)}
                >
                  <span className={`${styles.radio} ${isActive ? styles.radioChecked : ""}`} />
                  <span className={styles.rowText}>
                    <span className={styles.rowName}>{item.name}</span>
                    <span className={styles.rowSub}>
                      {t("tts.voiceLabel", { voice: item.voice })}
                    </span>
                  </span>
                  <span className={styles.rowActions}>
                    <button
                      className={styles.iconBtn}
                      title={isPlaying ? t("tts.stopTest") : t("tts.test")}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleTest(item);
                      }}
                      disabled={isTesting}
                    >
                      {isTesting ? (
                        <Loader2 size={14} className={styles.spin} />
                      ) : isPlaying ? (
                        <Square size={14} />
                      ) : (
                        <Play size={14} />
                      )}
                    </button>
                    <button
                      className={styles.iconBtn}
                      title={t("tts.edit")}
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing(item);
                        setShowModal(true);
                      }}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                      title={t("tts.delete")}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingDelete(item);
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className={styles.section}>
        <label className={styles.toggleRow}>
          <input
            type="checkbox"
            checked={config.streamEnabled}
            onChange={(e) => setStreamEnabled(e.target.checked)}
          />
          <span>
            <span className={styles.toggleLabel}>{t("tts.streamTitle")}</span>
            <span className={styles.sectionDesc}>{t("tts.streamDesc")}</span>
          </span>
        </label>
      </div>

      <p className={styles.hint}>{t("tts.hint")}</p>

      {showModal && (
        <TtsConfigModal
          editing={editing}
          onClose={() => { setShowModal(false); setEditing(null); }}
          onSave={handleSave}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("tts.confirmDeleteTitle")}
        message={t("tts.confirmDelete", { name: pendingDelete?.name ?? "" })}
        confirmLabel={t("tts.delete")}
        cancelLabel={t("cancel")}
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
