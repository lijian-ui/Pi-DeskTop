/**
 * Models settings page.
 *
 * Lists every provider the user has already configured (custom OpenAI-compatible
 * endpoints and API-key providers) and offers an "Add Provider" button that opens
 * the full provider picker (AddProviderPicker), which mirrors the @agegr/pi-web
 * ModelsConfig catalog.
 */
import { useCallback, useEffect, useState } from "react";
import { Plus, ChevronRight, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUIStore } from "../store/ui-store";
import ProviderIcon from "./ProviderIcon";
import AddProviderPicker from "./AddProviderPicker";
import ConfirmDialog from "./ConfirmDialog";
import type { ProviderCatalog } from "../../preload/api";
import styles from "./ModelsPage.module.css";

interface Row {
  id: string;
  name: string;
  sub: string;
  kind: "custom" | "apiKey";
  models?: { id: string; name?: string; reasoning?: boolean }[];
}

interface PendingModel {
  providerId: string;
  modelId: string;
  modelName: string;
}

export default function ModelsPage() {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<ProviderCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [showPicker, setShowPicker] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Row | null>(null);
  const [pendingDeleteModel, setPendingDeleteModel] = useState<PendingModel | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const c = await window.piDesk.listProvidersCatalog();
      setCatalog(c);
    } catch (err) {
      console.error("Failed to load provider catalog:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Local providers (LM Studio / Ollama) are saved with a fixed id; show the
  // provider brand name in the list instead of the model name the user typed.
  const LOCAL_PROVIDER_NAMES: Record<string, string> = {
    "lm-studio": t("models.lmStudioName"),
    ollama: t("models.ollamaName"),
  };

  const rows: Row[] = [];
  if (catalog) {
    // Custom providers own their ids; skip them in the built-in loops so a
    // custom endpoint that also registered with the runtime isn't listed twice.
    const customIds = new Set(catalog.customProviders.map((p) => p.id));
    for (const p of catalog.customProviders) {
      rows.push({
        id: p.id,
        name: LOCAL_PROVIDER_NAMES[p.id] ?? p.name,
        sub: t("models.modelCount", { count: p.models.length }),
        kind: "custom",
        models: p.models,
      });
    }
    for (const p of catalog.apiKeyProviders) {
      if (p.configured && !customIds.has(p.id))
        rows.push({
          id: p.id,
          name: p.name,
          sub: t("models.modelCount", { count: p.modelCount }),
          kind: "apiKey",
          models: p.models,
        });
    }
  }

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleConfirmDelete = async () => {
    const row = pendingDelete;
    setPendingDelete(null);
    if (!row) return;
    try {
      if (row.kind === "custom") {
        await window.piDesk.deleteCustomProvider(row.id);
      } else {
        await window.piDesk.deleteApiKey(row.id);
      }
      useUIStore.getState().bumpModelsVersion();
      await load();
    } catch (err) {
      console.error("Failed to remove provider:", err);
    }
  };

  const handleConfirmDeleteModel = async () => {
    const m = pendingDeleteModel;
    setPendingDeleteModel(null);
    if (!m) return;
    try {
      await window.piDesk.deleteCustomModel(m.providerId, m.modelId);
      await load();
    } catch (err) {
      console.error("Failed to remove model:", err);
    }
  };

  if (loading) return <div className={styles.loading}>{t("loading")}</div>;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>{t("models.title")}</h1>
        <button className={styles.addBtn} onClick={() => setShowPicker(true)}>
          <Plus size={16} />
          <span>{t("models.addProvider")}</span>
        </button>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>{t("models.configured")}</h2>
        {rows.length === 0 ? (
          <div className={styles.emptyHint}>
            {t("models.empty")}{" "}
            <button className={styles.textLink} onClick={() => setShowPicker(true)}>
              {t("models.addNow")}
            </button>
          </div>
        ) : (
          <div className={styles.list}>
            {rows.map((row) => {
              const isCustom = row.kind === "custom";
              const isExpandable = isCustom || row.kind === "apiKey";
              const isOpen = isExpandable && expanded.has(row.id);
              return (
                <div key={`${row.kind}:${row.id}`} className={styles.rowWrap} data-expanded={isOpen || undefined}>
                  <div
                    className={`${styles.row} ${isExpandable ? styles.rowClickable : ""}`}
                    onClick={isExpandable ? () => toggleExpand(row.id) : undefined}
                  >
                    <span className={styles.rowIcon}>
                      <ProviderIcon id={row.id} size={20} />
                    </span>
                    <span className={styles.rowName}>{row.name}</span>
                    <span className={styles.rowSub}>{row.sub}</span>
                    <span
                      className={styles.rowDelete}
                      role="button"
                      tabIndex={0}
                      title={t("models.delete")}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingDelete(row);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.stopPropagation();
                          setPendingDelete(row);
                        }
                      }}
                    >
                      <Trash2 size={14} />
                    </span>
                    <span
                      className={`${styles.caret} ${isOpen ? styles.caretOpen : ""}`}
                      aria-hidden="true"
                    >
                      <ChevronRight size={16} />
                    </span>
                  </div>

                  {/* Expanded model list — local / custom (editable) and online (read-only) */}
                  {isOpen && row.models && (
                    <div className={styles.modelList}>
                      {row.models.length === 0 ? (
                        <div className={styles.modelEmpty}>{t("models.empty")}</div>
                      ) : (
                        row.models.map((m) => (
                          <div key={m.id} className={styles.modelRow}>
                            <span className={styles.modelName}>{m.name || m.id}</span>
                            {isCustom ? (
                              <div className={styles.rowActions}>
                                <button
                                  className={styles.editTextBtn}
                                  onClick={() => setEditingId(row.id)}
                                >
                                  {t("models.edit")}
                                </button>
                                <button
                                  className={styles.deleteTextBtn}
                                  onClick={() =>
                                    setPendingDeleteModel({
                                      providerId: row.id,
                                      modelId: m.id,
                                      modelName: m.name || m.id,
                                    })
                                  }
                                >
                                  {t("models.delete")}
                                </button>
                              </div>
                            ) : (
                              <span className={styles.readonlyTag}>{t("models.readOnly")}</span>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showPicker && (
        <AddProviderPicker
          onClose={() => setShowPicker(false)}
          onSaved={load}
        />
      )}

      {editingId && (
        <AddProviderPicker
          editProviderId={editingId}
          onClose={() => setEditingId(null)}
          onSaved={() => {
            setEditingId(null);
            load();
          }}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("models.confirmDeleteTitle")}
        message={t("models.confirmDelete", { name: pendingDelete?.name ?? "" })}
        confirmLabel={t("models.delete")}
        cancelLabel={t("cancel")}
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        open={pendingDeleteModel !== null}
        title={t("models.confirmDeleteTitle")}
        message={t("models.confirmDelete", { name: pendingDeleteModel?.modelName ?? "" })}
        confirmLabel={t("models.delete")}
        cancelLabel={t("cancel")}
        onConfirm={handleConfirmDeleteModel}
        onCancel={() => setPendingDeleteModel(null)}
      />
    </div>
  );
}
