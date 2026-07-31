/**
 * Add-provider picker modal.
 *
 * Mirrors the @agegr/pi-web ModelsConfig screen: a searchable grid of every
 * provider the Pi SDK ships, split into two sections —
 *   CUSTOM   → user-defined OpenAI-compatible endpoints
 *   API KEY  → providers configured with an API key
 *
 * Picking a card drops into an inline config step where the user pastes a key
 * (API KEY) or fills the custom form (CUSTOM) and saves.
 */
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { X, Search, ArrowLeft, Plus, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import ProviderIcon from "./ProviderIcon";
import type {
  ProviderCatalog,
  ProviderCatalogItem,
} from "../../preload/api";
import styles from "./AddProviderPicker.module.css";

const CUSTOM_ID = "__custom__";

type Step = "pick" | "config";

interface Selection {
  id: string;
  name: string;
  kind: "apiKey" | "custom";
  /** For built-in local endpoints (LM Studio / Ollama): pre-fill Base URL. */
  presetBaseUrl?: string;
}

export default function AddProviderPicker({
  onClose,
  onSaved,
  editProviderId = null,
}: {
  onClose: () => void;
  onSaved: () => void;
  editProviderId?: string | null;
}) {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<ProviderCatalog | null>(null);
  const [query, setQuery] = useState("");
  const [step, setStep] = useState<Step>("pick");
  const [selection, setSelection] = useState<Selection | null>(null);

  // ── config-step form state ──
  const [formName, setFormName] = useState("");
  const [formBaseUrl, setFormBaseUrl] = useState("");
  const [formContextWindow, setFormContextWindow] = useState<number>(NaN);
  const [formApiKey, setFormApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // When editing an existing custom provider, holds its raw config so we can
  // preserve model fields the form doesn't expose (reasoning / input / cost …).
  const [editConfig, setEditConfig] = useState<any>(null);

  const loadCatalog = () => {
    window.piDesk
      .listProvidersCatalog()
      .then((c) => setCatalog(c))
      .catch((err) => console.error("Failed to load provider catalog:", err));
  };

  useEffect(() => {
    loadCatalog();
  }, []);

  // When opened to edit an existing custom provider, load its full raw config
  // (which includes contextWindow + apiKey, not surfaced by the catalog) and
  // prefill the form. The form edits the FIRST model; siblings are preserved.
  useEffect(() => {
    if (!editProviderId) return;
    window.piDesk
      .getCustomModelsJson()
      .then((data) => {
        const cfg = (data as Record<string, any>)[editProviderId];
        if (!cfg) {
          setError(t("models.notFound"));
          return;
        }
        const model0 = Array.isArray(cfg.models) ? cfg.models[0] : undefined;
        setEditConfig(cfg);
        setSelection({ id: editProviderId, name: cfg.name ?? editProviderId, kind: "custom" });
        // Prefill with the model's own name (the real server-side identifier),
        // falling back to the provider name for legacy single-model configs.
        setFormName(
          typeof model0?.name === "string" && model0.name
            ? model0.name
            : typeof cfg.name === "string"
              ? cfg.name
              : editProviderId
        );
        setFormBaseUrl(typeof cfg.baseUrl === "string" ? cfg.baseUrl : "");
        setFormContextWindow(
          model0 && Number.isFinite(model0.contextWindow) ? model0.contextWindow : 128000
        );
        setFormApiKey(typeof cfg.apiKey === "string" ? cfg.apiKey : "");
        setError("");
        setStep("config");
      })
      .catch((err) => console.error("Failed to load custom provider:", err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editProviderId]);

  const filter = useMemo(() => query.trim().toLowerCase(), [query]);

  const matches = (item: { id: string; name: string }) =>
    !filter ||
    item.name.toLowerCase().includes(filter) ||
    item.id.toLowerCase().includes(filter);

  // Built-in local endpoints. Selecting one opens the same OpenAI-compatible
  // custom config form, pre-filled with that server's default Base URL.
  const localProviders = [
    {
      id: "lm-studio",
      name: "LM Studio",
      desc: t("models.lmStudioDesc"),
      baseUrl: "http://localhost:1234/v1",
    },
    {
      id: "ollama",
      name: "Ollama",
      desc: t("models.ollamaDesc"),
      baseUrl: "http://localhost:11434/v1",
    },
  ];

  const apiKey = (catalog?.apiKeyProviders ?? []).filter(matches);
  const customMatches = matches({ id: CUSTOM_ID, name: t("models.customCardTitle") });
  const localMatches = localProviders.filter(matches);

  const nothingFound =
    !!catalog && apiKey.length === 0 && !customMatches && localMatches.length === 0;

  const openConfig = (sel: Selection) => {
    setSelection(sel);
    setFormName("");
    setFormBaseUrl(sel.presetBaseUrl ?? "");
    setFormContextWindow(NaN);
    setFormApiKey("");
    setError("");
    setStep("config");
  };

  const backToPick = () => {
    setStep("pick");
    setSelection(null);
    setError("");
  };

  const requiredFilled =
    selection?.kind === "custom"
      ? formName.trim() !== "" &&
        formBaseUrl.trim() !== "" &&
        Number.isFinite(formContextWindow) &&
        formApiKey.trim() !== ""
      : formApiKey.trim() !== "";

  const handleSave = async () => {
    if (!selection) return;
    if (!formApiKey.trim()) {
      setError(t("models.apiKeyRequired"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      if (selection.kind === "custom") {
        if (!formName.trim()) {
          setError(t("models.nameRequired"));
          setSaving(false);
          return;
        }
        if (!Number.isFinite(formContextWindow)) {
          setError(t("models.contextWindowRequired"));
          setSaving(false);
          return;
        }
        let baseUrl = formBaseUrl.trim().replace(/\/+$/, "");
        if (!baseUrl) {
          setError(t("models.urlRequired"));
          setSaving(false);
          return;
        }
        if (!/\/v1$/i.test(baseUrl)) baseUrl += "/v1";
        const providerId = editProviderId
          ? editProviderId
          : selection.presetBaseUrl
            ? selection.id
            : formName.trim().toLowerCase().replace(/\s+/g, "-");
        const name = formName.trim();
        // The model id is what gets sent as the `model` field in API requests,
        // so it MUST be the server-side identifier verbatim (case + slashes
        // preserved). LM Studio's JIT auto-load matches strictly on this.
        const modelId = name;
        const ctx = Number.isFinite(formContextWindow) ? formContextWindow : 128000;

        // Read the current on-disk config so saving MERGES models into the
        // provider instead of wiping previously added ones.
        const allCfg = await window.piDesk.getCustomModelsJson().catch(() => ({}));
        const existingCfg = (allCfg as Record<string, any>)[providerId];
        const existingModels: any[] = Array.isArray(existingCfg?.models)
          ? existingCfg.models
          : [];

        let models: any[];
        if (editProviderId && editConfig) {
          // Edit: rewrite the model being edited (the FIRST model — that's what
          // the form shows), keep fields the form doesn't expose (reasoning,
          // input, cost, maxTokens, compat, headers) and preserve all sibling
          // models untouched. The old id + edited model are read from the
          // FRESH disk config (existingModels), NOT from the `editConfig`
          // snapshot taken when the dialog opened — a snapshot would drift if
          // the file changed in between, and `find` would miss → edited={}
          // and silently drop the model's extra fields.
          const oldId = existingModels[0] ? String(existingModels[0].id) : "";
          const edited = existingModels[0] ?? {};
          const rest = existingModels.filter(
            (m) => String(m?.id) !== oldId && String(m?.id) !== modelId
          );
          models = [{ ...edited, id: modelId, name, contextWindow: ctx }, ...rest];
        } else {
          // Add: upsert by model id — same id updates in place, a new id is
          // APPENDED so provider can hold multiple models (LM Studio, Ollama…).
          const newModel = {
            id: modelId,
            name,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: ctx,
            maxTokens: 16384,
          };
          models = [
            ...existingModels.filter((m) => String(m?.id) !== modelId),
            newModel,
          ];
        }

        // Provider display name: keep the existing one; new presets use the
        // product name (LM Studio / Ollama), new customs use the model name.
        const providerName =
          (typeof existingCfg?.name === "string" && existingCfg.name) ||
          (selection.presetBaseUrl ? selection.name : name);

        await window.piDesk.saveCustomProvider(providerId, {
          api: "openai-completions",
          name: providerName,
          baseUrl,
          apiKey: formApiKey.trim(),
          models,
        });
      } else {
        await window.piDesk.saveApiKey(selection.id, formApiKey.trim());
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("models.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        {/* ── Header ── */}
        <div className={styles.header}>
          {step === "config" ? (
            <button className={styles.backBtn} onClick={backToPick} title={t("models.back")}>
              <ArrowLeft size={16} />
            </button>
          ) : null}
          <h3 className={styles.title}>
            {step === "config" && selection
              ? t("models.configureTitle", { name: selection.name })
              : t("models.pickTitle")}
          </h3>
          <button className={styles.closeBtn} onClick={onClose} title={t("close")}>
            <X size={16} />
          </button>
        </div>

        {/* ── Body ── */}
        {step === "pick" ? (
          <>
            <div className={styles.searchRow}>
              <Search size={15} className={styles.searchIcon} />
              <input
                className={styles.searchInput}
                type="text"
                placeholder={t("models.searchPlaceholder")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
              {query && (
                <button className={styles.searchClear} onClick={() => setQuery("")}>
                  <X size={13} />
                </button>
              )}
            </div>

            <div className={styles.body}>
              {!catalog ? (
                <div className={styles.loading}>{t("loading")}</div>
              ) : nothingFound ? (
                <div className={styles.empty}>{t("models.noResults")}</div>
              ) : (
                <>
                  {/* CUSTOM */}
                  {customMatches && (
                    <Section title={t("models.sectionCustom")}>
                      <button
                        className={styles.card}
                        onClick={() =>
                          openConfig({
                            id: CUSTOM_ID,
                            name: t("models.customCardTitle"),
                            kind: "custom",
                          })
                        }
                      >
                        <span className={styles.cardText}>
                          <span className={styles.cardName}>{t("models.customCardTitle")}</span>
                          <span className={styles.cardSub}>{t("models.customCardDesc")}</span>
                        </span>
                        <span className={styles.cardIcon}>
                          <Plus size={20} className={styles.plusIcon} />
                        </span>
                      </button>
                    </Section>
                  )}

                  {/* LOCAL — LM Studio / Ollama */}
                  {localMatches.length > 0 && (
                    <Section title={t("models.sectionLocal")}>
                      {localMatches.map((p) => (
                        <button
                          key={p.id}
                          className={styles.card}
                          onClick={() =>
                            openConfig({
                              id: p.id,
                              name: p.name,
                              kind: "custom",
                              presetBaseUrl: p.baseUrl,
                            })
                          }
                        >
                          <span className={styles.cardText}>
                            <span className={styles.cardName}>{p.name}</span>
                            <span className={styles.cardSub}>{p.desc}</span>
                          </span>
                          <span className={styles.cardIcon}>
                            <ProviderIcon id={p.id} size={22} />
                          </span>
                        </button>
                      ))}
                    </Section>
                  )}

                  {/* API KEY */}
                  {apiKey.length > 0 && (
                    <Section title={t("models.sectionApiKey")}>
                      {apiKey.map((p) => (
                        <ApiKeyCard
                          key={p.id}
                          item={p}
                          modelCountLabel={t("models.modelCount", { count: p.modelCount })}
                          onClick={() =>
                            openConfig({ id: p.id, name: p.name, kind: "apiKey" })
                          }
                        />
                      ))}
                    </Section>
                  )}
                </>
              )}
            </div>
          </>
        ) : (
          /* ── Config step ── */
          <div className={styles.configBody}>
            {selection && (
              <div className={styles.configHead}>
                <span className={styles.configIcon}>
                  {selection.kind === "custom" ? (
                    <Plus size={22} className={styles.plusIcon} />
                  ) : (
                    <ProviderIcon id={selection.id} size={26} />
                  )}
                </span>
                <div className={styles.configHeadText}>
                  <span className={styles.configName}>{selection.name}</span>
                  <span className={styles.configHint}>
                    {selection.kind === "custom"
                      ? t("models.customCardDesc")
                      : t("models.apiKeyHint")}
                  </span>
                </div>
              </div>
            )}

            {selection?.kind === "custom" && (
              <>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>
                    {t("models.modelName")}
                    <span className={styles.required}>*</span>
                  </span>
                  <input
                    className={styles.fieldInput}
                    type="text"
                    placeholder={t("models.modelName")}
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    autoFocus
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>
                    {t("models.baseUrl")}
                    <span className={styles.required}>*</span>
                  </span>
                  <input
                    className={styles.fieldInput}
                    type="url"
                    placeholder="http://localhost:1234/v1"
                    value={formBaseUrl}
                    onChange={(e) => setFormBaseUrl(e.target.value)}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>
                    {t("models.contextWindow")}
                    <span className={styles.required}>*</span>
                  </span>
                  <input
                    className={styles.fieldInput}
                    type="number"
                    min={1}
                    step={1000}
                    placeholder="128000"
                    value={Number.isFinite(formContextWindow) ? formContextWindow : ""}
                    onChange={(e) =>
                      setFormContextWindow(
                        e.target.value === "" ? NaN : Number(e.target.value)
                      )
                    }
                  />
                  <span className={styles.fieldHint}>{t("models.contextWindowHint")}</span>
                </label>
              </>
            )}

            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                {t("models.apiKey")}
                <span className={styles.required}>*</span>
              </span>
              <input
                className={styles.fieldInput}
                type="password"
                placeholder={selection?.kind === "custom" ? "sk-..." : t("models.apiKey")}
                value={formApiKey}
                onChange={(e) => setFormApiKey(e.target.value)}
                autoFocus={selection?.kind !== "custom"}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !saving) handleSave();
                }}
              />
            </label>

            {error && <div className={styles.error}>{error}</div>}
          </div>
        )}

        {/* ── Footer ── */}
        <div className={styles.footer}>
          {step === "config" ? (
            <>
              <button className={styles.btnGhost} onClick={backToPick}>
                {t("models.back")}
              </button>
              <button
                className={styles.btnPrimary}
                onClick={handleSave}
                disabled={saving || !requiredFilled}
              >
                {saving ? (
                  t("models.saving")
                ) : (
                  <>
                    <Check size={15} />
                    <span>{t("save")}</span>
                  </>
                )}
              </button>
            </>
          ) : (
            <button className={styles.btnGhost} onClick={onClose}>
              {t("cancel")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>{title}</div>
      <div className={styles.grid}>{children}</div>
    </div>
  );
}

function ApiKeyCard({
  item,
  modelCountLabel,
  onClick,
}: {
  item: ProviderCatalogItem;
  modelCountLabel: string;
  onClick: () => void;
}) {
  return (
    <button className={styles.card} onClick={onClick}>
      <span className={styles.cardText}>
        <span className={styles.cardName}>{item.name}</span>
        <span className={styles.cardSub}>{modelCountLabel}</span>
      </span>
      <span className={styles.cardRight}>
        {item.configured && (
          <span className={styles.configuredDot} title="configured">
            <Check size={12} />
          </span>
        )}
        <span className={styles.cardIcon}>
          <ProviderIcon id={item.id} size={22} />
        </span>
      </span>
    </button>
  );
}
