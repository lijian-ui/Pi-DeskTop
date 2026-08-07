/**
 * IM 接入 — channel config page.
 *
 * Left-nav entry below 扩展. Shows every configured channel as a card
 * (name / type / connection status / enable toggle / edit / delete) plus an
 * "Add channel" button that opens the add/edit modal.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Plus, Pencil, Trash2, Loader2, FolderSync } from "lucide-react";
import { useUIStore } from "../store/ui-store";
import { useSessionStore } from "../store/session-store";
import type { ImConfig, ImChannelInstance } from "../../preload/api";
import ImChannelIcon from "./ImChannelIcon";
import ImChannelModal from "./ImChannelModal";
import ConfirmDialog from "../sidebar/ConfirmDialog";
import styles from "./ImPage.module.css";

type StatusMap = Record<string, string>;

export default function ImPage() {
  const { t } = useTranslation();
  const setMainView = useUIStore((s) => s.setMainView);

  const [config, setConfig] = useState<ImConfig>({ channels: [] });
  const [status, setStatus] = useState<StatusMap>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ImChannelInstance | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ImChannelInstance | null>(null);
  const [applying, setApplying] = useState<string | null>(null); // instanceId being toggled
  const [pendingMigrate, setPendingMigrate] = useState<ImChannelInstance | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    const [cfg, st] = await Promise.all([
      window.piDesk.imGetConfig(),
      window.piDesk.imGetStatus().catch(() => ({})),
    ]);
    setConfig(cfg);
    setStatus(st);
  }, []);

  useEffect(() => {
    load();
    const off = window.piDesk.onImStatus((s) => setStatus(s));
    return off;
  }, [load]);

  /** Persist the full config (add / edit / toggle / delete all funnel here). */
  const persist = async (next: ImConfig) => {
    setSaving(true);
    setError("");
    try {
      const res = await window.piDesk.imSaveConfig(next);
      if (!res.ok) {
        setError(res.error ?? t("im.saveFailed"));
        return false;
      }
      setConfig(next);
      await window.piDesk.imGetStatus().then((s) => setStatus(s));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleSaveInstance = async (instance: ImChannelInstance) => {
    const exists = config.channels.some((c) => c.id === instance.id);
    const channels = exists
      ? config.channels.map((c) => (c.id === instance.id ? instance : c))
      : [...config.channels, instance];
    const ok = await persist({ ...config, channels });
    if (!ok) throw new Error(t("im.saveFailed"));
  };

  const handleToggle = async (inst: ImChannelInstance) => {
    setApplying(inst.id);
    try {
      await persist({
        ...config,
        channels: config.channels.map((c) =>
          c.id === inst.id ? { ...c, enabled: !c.enabled } : c,
        ),
      });
    } finally {
      setApplying(null);
    }
  };

  const handleConfirmDelete = async () => {
    const inst = pendingDelete;
    setPendingDelete(null);
    if (!inst) return;
    await persist({
      ...config,
      channels: config.channels.filter((c) => c.id !== inst.id),
    });
  };

  /** Migrate all existing conversations of a channel to its configured cwd. */
  const handleConfirmMigrate = async () => {
    const inst = pendingMigrate;
    setPendingMigrate(null);
    if (!inst || !inst.cwd) return;
    setMigrating(true);
    setError("");
    setNotice("");
    try {
      const res = await window.piDesk.imMigrateChannelSessions(inst.id);
      // Session files moved → refresh the sidebar session list so items
      // regroup under the new workspace.
      await useSessionStore.getState().refreshSessions();
      const failedCount = res.failed.length;
      setNotice(
        t("im.migrateDone", {
          ok: res.migrated.length,
          skipped: res.skipped.length,
          failed: failedCount,
        }),
      );
      if (failedCount > 0) {
        setError(
          res.failed.map((f) => `${f.sessionKey}: ${f.error}`).join("\n"),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMigrating(false);
    }
  };

  const channels = config.channels ?? [];

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h2 className={styles.title}>{t("nav.im")}</h2>
        <div className={styles.headerRight}>
          <button
            className={styles.addBtn}
            onClick={() => {
              setEditing(null);
              setModalOpen(true);
            }}
          >
            <Plus size={16} />
            <span>{t("im.addChannel")}</span>
          </button>
          <button
            className={styles.closeBtn}
            onClick={() => setMainView("chat")}
            title={t("close")}
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div className={styles.body}>
        {error && <div className={styles.error}>{error}</div>}
        {notice && <div className={styles.notice}>{notice}</div>}

        {/* Channel cards */}
        {channels.length === 0 ? (
          <div className={styles.empty}>
            <p>{t("im.empty")}</p>
          </div>
        ) : (
          <div className={styles.channelList}>
            {channels.map((inst) => {
              const st = status[inst.id] ?? "off";
              return (
                <div key={inst.id} className={styles.channelCard}>
                  <span className={styles.channelIcon}>
                    <ImChannelIcon type={inst.type} size={18} />
                  </span>
                  <div className={styles.channelInfo}>
                    <div className={styles.channelNameRow}>
                      <span className={styles.channelName}>{inst.name}</span>
                      <span
                        className={`${styles.badge} ${styles["badge_" + st]}`}
                      >
                        {t(`im.status.${st}`)}
                      </span>
                    </div>
                    <span className={styles.channelSub}>
                      {t(`im.${inst.type}`)} · {inst.id}
                    </span>
                    {inst.cwd && (
                      <span
                        className={styles.channelWorkspace}
                        title={inst.cwd}
                      >
                        {t("im.workspace")}: {inst.cwd}
                      </span>
                    )}
                  </div>

                  <span className={styles.channelActions}>
                    {/* migrate existing sessions to the configured workspace */}
                    <button
                      type="button"
                      className={styles.iconBtn}
                      title={
                        inst.cwd
                          ? t("im.migrate")
                          : t("im.migrateNoCwd")
                      }
                      disabled={!inst.cwd || migrating === true}
                      onClick={() => setPendingMigrate(inst)}
                    >
                      {migrating && pendingMigrate?.id === inst.id ? (
                        <Loader2 size={14} className={styles.spin} />
                      ) : (
                        <FolderSync size={14} />
                      )}
                    </button>
                    {/* enable toggle */}
                    <button
                      type="button"
                      className={`${styles.toggleBtn} ${
                        inst.enabled ? styles.toggleOn : ""
                      }`}
                      title={inst.enabled ? t("im.disable") : t("im.enable")}
                      onClick={() => handleToggle(inst)}
                      disabled={applying === inst.id}
                    >
                      {applying === inst.id ? (
                        <Loader2 size={14} className={styles.spin} />
                      ) : (
                        <span className={styles.toggleKnob} />
                      )}
                    </button>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      title={t("im.edit")}
                      onClick={() => {
                        setEditing(inst);
                        setModalOpen(true);
                      }}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      className={`${styles.iconBtn} ${styles.dangerBtn}`}
                      title={t("im.delete")}
                      onClick={() => setPendingDelete(inst)}
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

      {modalOpen && (
        <ImChannelModal
          editInstance={editing}
          onClose={() => setModalOpen(false)}
          onSave={handleSaveInstance}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("im.delete")}
        message={t("im.confirmDelete", { name: pendingDelete?.name ?? "" })}
        confirmLabel={t("im.delete")}
        cancelLabel={t("cancel")}
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        open={pendingMigrate !== null}
        title={t("im.migrate")}
        message={t("im.migrateConfirm", {
          name: pendingMigrate?.name ?? "",
          cwd: pendingMigrate?.cwd ?? "",
        })}
        confirmLabel={t("im.migrate")}
        cancelLabel={t("cancel")}
        onConfirm={handleConfirmMigrate}
        onCancel={() => setPendingMigrate(null)}
      />
    </div>
  );
}
