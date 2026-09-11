/**
 * Add-provider picker modal.
 *
 * Mirrors the @agegr/pi-web ModelsConfig screen: a searchable grid of every
 * provider the Pi SDK ships, split into sections —
 *   CUSTOM   → user-defined OpenAI-compatible endpoints
 *   API KEY  → providers configured with an API key
 *   LOCAL    → LM Studio / Ollama (pre-filled Base URL)
 *   CLOUD    → Agnes etc. (remote, still needs an API key)
 *
 * Picking a card drops into an inline config step. For OpenAI-compatible
 * (CUSTOM / LOCAL / CLOUD) providers the config step is:
 *   渠道名称 * / Base URL * / API Key *  →  divider  →  模型目录
 * The model catalog holds every model the provider exposes. Models are added
 * either by hand ("添加模型") or pulled from the endpoint ("获取可用模型",
 * which opens a checklist popup). Each row is editable (name / context window
 * / supports images) and deletable.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { X, Search, ArrowLeft, Plus, Check, Download, Trash } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUIStore } from "../store/ui-store";
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

interface ModelEntry {
  /** Stable React key. For fetched models this is a uuid; names can collide. */
  key: string;
  name: string;
  contextWindow: number;
  supportsImages: boolean;
  /** Whether this model supports reasoning / thinking (drives supportsThinking()). */
  reasoning: boolean;
  /** compat.thinkingFormat: how the endpoint emits the reasoning stream. "" = auto. */
  thinkingFormat: string;
  /** Manual rows let the user edit the name; fetched rows keep the server id. */
  editableName: boolean;
}

/** thinkingFormat options for compat.thinkingFormat. Provider names are locale-agnostic. */
const THINKING_FORMAT_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Auto" },
  { value: "qwen", label: "Qwen (reasoning_content)" },
  { value: "deepseek", label: "DeepSeek (reasoning_content)" },
  { value: "openai", label: "OpenAI / generic" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "together", label: "Together" },
  { value: "zai", label: "Z.AI" },
  { value: "ant-ling", label: "Tongyi Lingma" },
];

const genKey = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `m_${Math.random().toString(36).slice(2)}_${Date.now()}`;

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
  const bumpModelsVersion = useUIStore((s) => s.bumpModelsVersion);
  const [catalog, setCatalog] = useState<ProviderCatalog | null>(null);
  const [query, setQuery] = useState("");
  const [step, setStep] = useState<Step>("pick");
  const [selection, setSelection] = useState<Selection | null>(null);

  // ── config-step form state ──
  const [formChannel, setFormChannel] = useState("");
  const [formBaseUrl, setFormBaseUrl] = useState("");
  const [formApiKey, setFormApiKey] = useState("");
  // Focus the API Key field when a fetch fails due to missing/invalid auth,
  // so the user lands exactly where they need to fix it.
  const apiKeyRef = useRef<HTMLInputElement>(null);
  // The model catalog — every model this provider exposes. Both the manual
  // "添加模型" and the "获取可用模型" popup feed into this single list.
  const [modelList, setModelList] = useState<ModelEntry[]>([]);

  // "Fetch available models" popup state.
  const [fetchPopupOpen, setFetchPopupOpen] = useState(false);
  const [popupModels, setPopupModels] = useState<string[]>([]);
  const [popupChecked, setPopupChecked] = useState<Record<string, boolean>>({});

  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // When editing an existing custom provider, holds its raw config so we can
  // preserve provider-level fields the form doesn't expose (name …).
  const [, setEditConfig] = useState<any>(null);

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
  // and prefill the form + the model catalog (one editable row per model).
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
        setEditConfig(cfg);
        setSelection({ id: editProviderId, name: cfg.name ?? editProviderId, kind: "custom" });
        setFormBaseUrl(typeof cfg.baseUrl === "string" ? cfg.baseUrl : "");
        setFormApiKey(typeof cfg.apiKey === "string" ? cfg.apiKey : "");
        setFormChannel(typeof cfg.channel === "string" ? cfg.channel : "");
        const prefill: ModelEntry[] = (
          Array.isArray(cfg.models) ? cfg.models : []
        ).map((m: any) => ({
          key: genKey(),
          name: String(m?.id ?? m?.name ?? ""),
          contextWindow: Number.isFinite(m?.contextWindow) ? m.contextWindow : 128000,
          supportsImages: Array.isArray(m?.input) ? m.input.includes("image") : false,
          reasoning: m?.reasoning === true,
          thinkingFormat: typeof m?.compat?.thinkingFormat === "string" ? m.compat.thinkingFormat : "",
          editableName: true,
        }));
        setModelList(prefill);
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

  // Cloud OpenAI-compatible endpoints shipped as presets (same flow as local,
  // but remote — the user still fills in an API key in the config step).
  const cloudProviders = [
    {
      id: "agnesai",
      name: t("models.agnesName"),
      desc: t("models.agnesDesc"),
      baseUrl: "https://api.agnes-ai.cn/v1",
    },
  ];

  const apiKey = (catalog?.apiKeyProviders ?? []).filter(matches);
  const customMatches = matches({ id: CUSTOM_ID, name: t("models.customCardTitle") });
  const localMatches = localProviders.filter(matches);
  const cloudMatches = cloudProviders.filter(matches);

  const nothingFound =
    !!catalog && apiKey.length === 0 && !customMatches && localMatches.length === 0 && cloudMatches.length === 0;

  const openConfig = (sel: Selection) => {
    setSelection(sel);
    setFormChannel("");
    setFormBaseUrl(sel.presetBaseUrl ?? "");
    setFormApiKey("");
    setModelList([]);
    setFetchPopupOpen(false);
    setPopupModels([]);
    setPopupChecked({});
    setFetching(false);
    setFetchError("");
    setError("");
    setStep("config");
  };

  const backToPick = () => {
    setStep("pick");
    setSelection(null);
    setError("");
  };

  // ── Model catalog editing ──
  const addManualModel = () => {
    setModelList((prev) => [
      ...prev,
      { key: genKey(), name: "", contextWindow: 128000, supportsImages: false, reasoning: false, thinkingFormat: "", editableName: true },
    ]);
  };
  const updateModelName = (key: string, name: string) =>
    setModelList((prev) => prev.map((m) => (m.key === key ? { ...m, name } : m)));
  const updateModelCtx = (key: string, raw: string) =>
    setModelList((prev) =>
      prev.map((m) =>
        m.key === key
          ? { ...m, contextWindow: raw === "" ? NaN : Number(raw) }
          : m,
      ),
    );
  const updateModelImg = (key: string, val: boolean) =>
    setModelList((prev) => prev.map((m) => (m.key === key ? { ...m, supportsImages: val } : m)));
  const updateModelReasoning = (key: string, val: boolean) =>
    setModelList((prev) => prev.map((m) => (m.key === key ? { ...m, reasoning: val } : m)));
  const updateModelThinkingFormat = (key: string, val: string) =>
    setModelList((prev) => prev.map((m) => (m.key === key ? { ...m, thinkingFormat: val } : m)));
  const removeModel = (key: string) =>
    setModelList((prev) => prev.filter((m) => m.key !== key));

  // ── Fetch available models popup ──
  const doFetch = async (existingNames?: Set<string>) => {
    if (!formBaseUrl.trim()) {
      setFetchError(t("models.urlRequired"));
      return;
    }
    setFetching(true);
    setFetchError("");
    try {
      const ids = await window.piDesk.fetchRemoteModels(
        formBaseUrl.trim(),
        formApiKey.trim(),
      );
      if (!ids.length) {
        setFetchError(t("models.noRemoteModels"));
        setPopupModels([]);
        return;
      }
      setPopupModels(ids);
      // Pre-check models already present in the catalog so the user sees state.
      const ens =
        existingNames ??
        new Set(modelList.map((m) => m.name.trim().toLowerCase()).filter(Boolean));
      const pre: Record<string, boolean> = {};
      for (const id of ids) {
        if (ens.has(id.toLowerCase())) pre[id] = true;
      }
      setPopupChecked(pre);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("models.fetchFailed");
      setFetchError(msg);
      // A 401/403 means the endpoint rejected the request for auth reasons —
      // point the user at the API Key field they likely left empty/invalid.
      if (/40[13]/.test(msg)) apiKeyRef.current?.focus();
      setPopupModels([]);
    } finally {
      setFetching(false);
    }
  };

  const openFetchPopup = () => {
    setFetchPopupOpen(true);
    setPopupModels([]);
    setPopupChecked({});
    setFetchError("");
    doFetch();
  };

  const togglePopupModel = (id: string, checked: boolean) => {
    setPopupChecked((prev) => {
      const next = { ...prev };
      if (checked) next[id] = true;
      else delete next[id];
      return next;
    });
  };

  // Select / clear every fetched model in one click.
  const allPopupSelected =
    popupModels.length > 0 && popupModels.every((id) => popupChecked[id]);
  const toggleSelectAll = (checked: boolean) => {
    setPopupChecked((prev) => {
      const next = { ...prev };
      for (const id of popupModels) {
        if (checked) next[id] = true;
        else delete next[id];
      }
      return next;
    });
  };

  // Merge the checked popup models into the catalog (skip duplicates by name).
  // Each row keeps its own defaults — per-model config happens in the catalog.
  const confirmPopup = () => {
    setModelList((prev) => {
      const byName = new Map(prev.map((m) => [m.name.trim().toLowerCase(), m]));
      for (const id of Object.keys(popupChecked)) {
        if (!popupChecked[id]) continue;
        const lc = id.toLowerCase();
        if (byName.has(lc)) continue;
        byName.set(lc, {
          key: genKey(),
          name: id,
          contextWindow: 128000,
          supportsImages: false,
          reasoning: false,
          thinkingFormat: "",
          editableName: false,
        });
      }
      return Array.from(byName.values());
    });
    setFetchPopupOpen(false);
    setPopupModels([]);
    setPopupChecked({});
  };

  const requiredFilled =
    selection?.kind === "custom"
      ? (editProviderId ? true : formChannel.trim() !== "") &&
        formBaseUrl.trim() !== "" &&
        formApiKey.trim() !== "" &&
        modelList.some((m) => m.name.trim() !== "")
      : formApiKey.trim() !== "";

  const handleSave = async () => {
    if (!selection) return;
    setSaving(true);
    setError("");
    try {
      if (selection.kind === "custom") {
        // When editing an existing provider the id comes from editProviderId,
        // so the channel field is no longer required (local/cloud presets are
        // saved without one). Same for the API key — local endpoints often
        // need none, and if present it's already prefilled.
        if (!editProviderId && !formChannel.trim()) {
          setError(t("models.channelRequired"));
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
        if (!editProviderId && !formApiKey.trim()) {
          setError(t("models.apiKeyRequired"));
          setSaving(false);
          return;
        }

        const validModels = modelList.filter((m) => m.name.trim() !== "");
        if (validModels.length === 0) {
          setError(t("models.needModel"));
          setSaving(false);
          return;
        }

        // Read the existing on-disk config (provider name + edit merge).
        const allCfg = await window.piDesk.getCustomModelsJson().catch(() => ({}));
        const providerId = editProviderId
          ? editProviderId
          : selection.presetBaseUrl
            ? selection.id
            : formChannel.trim().toLowerCase().replace(/\s+/g, "-");
        const existingCfg = (allCfg as Record<string, any>)[providerId];

        // The catalog IS the full model list — full replace on save.
        const models = validModels.map((m) => ({
          id: m.name.trim(),
          name: m.name.trim(),
          reasoning: m.reasoning ?? false,
          ...(m.thinkingFormat ? { compat: { thinkingFormat: m.thinkingFormat } } : {}),
          input: m.supportsImages ? ["text", "image"] : ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: Number.isFinite(m.contextWindow) ? m.contextWindow : 128000,
          maxTokens: 16384,
        }));

        // Provider display name: keep the existing one; new presets use the
        // product name (LM Studio / Ollama / Agnes); new customs use channel.
        const providerName =
          (typeof existingCfg?.name === "string" && existingCfg.name) ||
          (selection.presetBaseUrl ? selection.name : formChannel.trim());

        await window.piDesk.saveCustomProvider(providerId, {
          api: "openai-completions",
          name: providerName,
          channel: formChannel.trim() || existingCfg?.channel || "",
          baseUrl,
          apiKey: formApiKey.trim(),
          models,
        });
      } else {
        if (!formApiKey.trim()) {
          setError(t("models.apiKeyRequired"));
          setSaving(false);
          return;
        }
        await window.piDesk.saveApiKey(selection.id, formApiKey.trim());
      }
      onSaved();
      bumpModelsVersion();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("models.saveFailed"));
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

                  {/* CLOUD — Agnes etc. */}
                  {cloudMatches.length > 0 && (
                    <Section title={t("models.sectionCloud")}>
                      {cloudMatches.map((p) => (
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
                    {t("models.channel")}
                    <span className={styles.required}>*</span>
                  </span>
                  <input
                    className={styles.fieldInput}
                    type="text"
                    placeholder={t("models.channelPlaceholder")}
                    value={formChannel}
                    onChange={(e) => setFormChannel(e.target.value)}
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
              </>
            )}

            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                {t("models.apiKey")}
                <span className={styles.required}>*</span>
              </span>
              <input
                ref={apiKeyRef}
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

            {selection?.kind === "custom" && (
              <>
                {!formApiKey.trim() && (
                  <p className={styles.fetchHint}>
                    {t("models.fetchNeedsKey")}
                  </p>
                )}

                <div className={styles.divider} />

                {/* ── Model catalog ── */}
                <div className={styles.catalogHead}>
                  <span className={styles.catalogTitle}>{t("models.catalog")}</span>
                  <div className={styles.catalogActions}>
                    <button
                      type="button"
                      className={styles.addModelBtn}
                      onClick={addManualModel}
                    >
                      <Plus size={14} />
                      {t("models.addModel")}
                    </button>
                    <button
                      type="button"
                      className={styles.fetchBtn}
                      onClick={openFetchPopup}
                      disabled={!formBaseUrl.trim()}
                    >
                      <Download size={14} />
                      {t("models.fetchModels")}
                    </button>
                  </div>
                </div>

                {modelList.length === 0 ? (
                  <div className={styles.catalogEmpty}>{t("models.catalogEmpty")}</div>
                ) : (
                  <div className={styles.modelList}>
                    {modelList.map((m) => (
                      <div key={m.key} className={styles.modelRow}>
                        <div className={styles.modelRowTop}>
                          <input
                            className={styles.fieldInput}
                            type="text"
                            placeholder={t("models.modelName")}
                            value={m.name}
                            disabled={!m.editableName}
                            onChange={(e) => updateModelName(m.key, e.target.value)}
                          />
                          <button
                            type="button"
                            className={styles.modelRowDel}
                            onClick={() => removeModel(m.key)}
                            title={t("models.deleteModel")}
                          >
                            <Trash size={14} />
                          </button>
                        </div>
                        <div className={styles.modelRowOpts}>
                          <label className={styles.fieldRow}>
                            <span className={styles.fieldLabel}>
                              {t("models.contextWindow")}
                            </span>
                            <input
                              className={styles.fieldInput}
                              type="number"
                              min={1}
                              step={1000}
                              placeholder="128000"
                              value={
                                Number.isFinite(m.contextWindow) ? m.contextWindow : ""
                              }
                              onChange={(e) => updateModelCtx(m.key, e.target.value)}
                            />
                          </label>
                          <label className={styles.checkRow}>
                            <input
                              type="checkbox"
                              className={styles.checkbox}
                              checked={m.supportsImages}
                              onChange={(e) => updateModelImg(m.key, e.target.checked)}
                            />
                            <span className={styles.checkText}>
                              <span className={styles.checkLabel}>
                                {t("models.supportsImages")}
                              </span>
                            </span>
                          </label>
                          <label className={styles.checkRow} title={t("models.supportsReasoningHint")}>
                            <input
                              type="checkbox"
                              className={styles.checkbox}
                              checked={m.reasoning}
                              onChange={(e) => updateModelReasoning(m.key, e.target.checked)}
                            />
                            <span className={styles.checkText}>
                              <span className={styles.checkLabel}>
                                {t("models.supportsReasoning")}
                              </span>
                            </span>
                          </label>
                          {m.reasoning && (
                            <label className={styles.fieldRow} title={t("models.thinkingFormatHint")}>
                              <span className={styles.fieldLabel}>{t("models.thinkingFormat")}</span>
                              <select
                                className={styles.fieldInput}
                                value={m.thinkingFormat}
                                onChange={(e) => updateModelThinkingFormat(m.key, e.target.value)}
                              >
                                {THINKING_FORMAT_OPTIONS.map((f) => (
                                  <option key={f.value} value={f.value}>
                                    {f.value === "" ? t("models.thinkingFormatAuto") : f.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

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

      {/* ── Fetch available models popup ── */}
      {fetchPopupOpen && (
        <div
          className={styles.popupOverlay}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setFetchPopupOpen(false);
          }}
        >
          <div className={styles.popupModal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.popupHeader}>
              <h4 className={styles.popupTitle}>{t("models.fetchModels")}</h4>
              <button
                className={styles.closeBtn}
                onClick={() => setFetchPopupOpen(false)}
                title={t("close")}
              >
                <X size={16} />
              </button>
            </div>
            <div className={styles.popupBody}>
              {popupModels.length === 0 ? (
                <div className={styles.popupEmpty}>
                  {fetchError ? (
                    <span className={styles.fetchError}>{fetchError}</span>
                  ) : fetching ? (
                    t("loading")
                  ) : (
                    t("models.noRemoteModels")
                  )}
                </div>
              ) : (
                <>
                  <label className={styles.popupSelectAll}>
                    <input
                      type="checkbox"
                      className={styles.checkbox}
                      checked={allPopupSelected}
                      onChange={(e) => toggleSelectAll(e.target.checked)}
                    />
                    <span className={styles.modelPickName}>{t("models.selectAll")}</span>
                  </label>
                  <div className={styles.popupList}>
                  {popupModels.map((id) => {
                    const checked = !!popupChecked[id];
                    return (
                      <label key={id} className={styles.modelPickHead}>
                        <input
                          type="checkbox"
                          className={styles.checkbox}
                          checked={checked}
                          onChange={(e) => togglePopupModel(id, e.target.checked)}
                        />
                        <span className={styles.modelPickName}>{id}</span>
                      </label>
                    );
                  })}
                </div>
                </>
              )}
            </div>
            <div className={styles.popupFooter}>
              <button className={styles.btnGhost} onClick={() => setFetchPopupOpen(false)}>
                {t("cancel")}
              </button>
              <button
                className={styles.btnPrimary}
                onClick={confirmPopup}
                disabled={Object.keys(popupChecked).length === 0}
              >
                {t("models.addSelected")}
              </button>
            </div>
          </div>
        </div>
      )}
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
