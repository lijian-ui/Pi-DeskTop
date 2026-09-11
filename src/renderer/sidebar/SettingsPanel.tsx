import { useState, useEffect, useCallback, useRef } from "react";
import { Plus, X, Globe, Key, Tag, Check, ChevronDown, Download, Trash } from "lucide-react";
import { useTranslation } from "react-i18next";
import ConfirmDialog from "./ConfirmDialog";
import styles from "./SettingsPanel.module.css";

interface ProviderInfo {
  id: string;
  name: string;
  baseUrl?: string;
  configured: boolean;
  authSource: string | null;
  /** Friendly channel label for custom OpenAI-compatible providers (optional). */
  channel?: string;
}

interface ModelEntry {
  key: string;
  name: string;
  contextWindow: number;
  supportsImages: boolean;
  /** Whether this model supports reasoning / thinking (drives supportsThinking()). */
  reasoning: boolean;
  /** compat.thinkingFormat: how the endpoint emits the reasoning stream. "" = auto. */
  thinkingFormat: string;
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

// ── Built-in provider list for the dropdown ──
const BUILTIN_PROVIDERS = [
  { id: "openai",                name: "OpenAI" },
  { id: "anthropic",             name: "Anthropic (Claude)" },
  { id: "google",               name: "Google (Gemini)" },
  { id: "deepseek",              name: "DeepSeek" },
  { id: "xai",                   name: "xAI (Grok)" },
  { id: "mistral",               name: "Mistral" },
  { id: "openrouter",            name: "OpenRouter" },
  { id: "groq",                  name: "Groq" },
  { id: "together",              name: "Together" },
  { id: "moonshotai",            name: "Moonshot AI (月之暗面)" },
  { id: "minimax",               name: "MiniMax" },
  { id: "kimi-coding",           name: "Kimi (月之暗面 Coding)" },
  { id: "zai",                   name: "Z.AI (智谱)" },
  { id: "xiaomi",                name: "Xiaomi (小米)" },
  { id: "fireworks",             name: "Fireworks" },
  { id: "cerebras",              name: "Cerebras" },
  { id: "huggingface",           name: "Hugging Face" },
  { id: "nvidia",                name: "NVIDIA" },
  { id: "github-copilot",        name: "GitHub Copilot" },
  { id: "opencode",              name: "OpenCode Zen" },
  { id: "ant-ling",              name: "Ant Ling" },
  { id: "__custom__",            name: "Custom (OpenAI-compatible)" },
];

const PROVIDER_API_TAG: Record<string, { label: string; cls: string }> = {
  openai:         { label: "OpenAI Responses", cls: "tagOpenai" },
  anthropic:      { label: "Anthropic",        cls: "tagAnthropic" },
  google:         { label: "Google Gemini",    cls: "tagGoogle" },
  deepseek:       { label: "OpenAI Chat",      cls: "tagOpenai" },
  xai:            { label: "OpenAI Chat",      cls: "tagOpenai" },
  mistral:        { label: "Mistral",          cls: "tagMistral" },
  openrouter:     { label: "OpenAI Chat",      cls: "tagOpenai" },
  groq:           { label: "OpenAI Chat",      cls: "tagOpenai" },
  together:       { label: "OpenAI Chat",      cls: "tagOpenai" },
  moonshotai:     { label: "OpenAI Chat",      cls: "tagOpenai" },
  minimax:        { label: "Anthropic",        cls: "tagAnthropic" },
  "kimi-coding":  { label: "Anthropic",        cls: "tagAnthropic" },
  zai:            { label: "OpenAI Chat",      cls: "tagOpenai" },
  xiaomi:         { label: "OpenAI Chat",      cls: "tagOpenai" },
  fireworks:      { label: "OpenAI Chat",      cls: "tagOpenai" },
  cerebras:       { label: "OpenAI Chat",      cls: "tagOpenai" },
  huggingface:    { label: "OpenAI Chat",      cls: "tagOpenai" },
  nvidia:         { label: "OpenAI Chat",      cls: "tagOpenai" },
  "github-copilot": { label: "Multi",          cls: "tagDefault" },
  opencode:       { label: "Multi",            cls: "tagDefault" },
  "ant-ling":     { label: "OpenAI Chat",      cls: "tagOpenai" },
};

export default function SettingsPanel() {
  const { t } = useTranslation();
  const [configured, setConfigured] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);

  // ── Dialog state ──
  const [showDialog, setShowDialog] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [formChannel, setFormChannel] = useState("");
  const [formBaseUrl, setFormBaseUrl] = useState("");
  const [formApiKey, setFormApiKey] = useState("");
  // The model catalog for custom OpenAI-compatible providers. Both the manual
  // "add model" button and the "fetch available models" popup feed this list.
  const [modelList, setModelList] = useState<ModelEntry[]>([]);

  // Fetch popup state.
  const [fetchPopupOpen, setFetchPopupOpen] = useState(false);
  const [popupModels, setPopupModels] = useState<string[]>([]);
  const [popupChecked, setPopupChecked] = useState<Record<string, boolean>>({});

  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  /** Provider awaiting delete confirmation (two-step removal). */
  const [pendingRemove, setPendingRemove] = useState<ProviderInfo | null>(null);

  const loadConfigured = useCallback(async () => {
    try {
      const all = await window.piDesk.getAllProviders();
      setConfigured(all?.filter((p: ProviderInfo) => p.configured) ?? []);
    } catch (err) {
      console.error("Failed to load providers:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadConfigured(); }, [loadConfigured]);

  const openDialog = () => {
    setSelectedProvider("");
    setFormChannel(""); setFormBaseUrl(""); setFormApiKey("");
    setModelList([]);
    setFetchPopupOpen(false); setPopupModels([]); setPopupChecked({});
    setFetching(false); setFetchError("");
    setError(""); setShowDialog(true);
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
        m.key === key ? { ...m, contextWindow: raw === "" ? NaN : Number(raw) } : m,
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
  const doFetch = async () => {
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
      const ens = new Set(modelList.map((m) => m.name.trim().toLowerCase()).filter(Boolean));
      const pre: Record<string, boolean> = {};
      for (const id of ids) {
        if (ens.has(id.toLowerCase())) pre[id] = true;
      }
      setPopupChecked(pre);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("models.fetchFailed");
      setFetchError(msg);
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

  const canSave = selectedProvider
    ? selectedProvider === "__custom__"
      ? formChannel.trim() !== "" &&
        formBaseUrl.trim() !== "" &&
        formApiKey.trim() !== "" &&
        modelList.some((m) => m.name.trim() !== "")
      : formApiKey.trim() !== ""
    : false;

  const handleSave = async () => {
    if (!selectedProvider) { setError(t("models.providerRequired")); return; }
    if (!formApiKey.trim()) { setError(t("models.apiKeyRequired")); return; }

    setSaving(true); setError("");
    try {
      if (selectedProvider === "__custom__") {
        if (!formChannel.trim()) { setError(t("models.channelRequired")); setSaving(false); return; }
        let baseUrl = formBaseUrl.trim().replace(/\/+$/, "");
        if (!baseUrl) { setError(t("models.urlRequired")); setSaving(false); return; }
        if (!/\/v1$/i.test(baseUrl)) baseUrl += "/v1";

        const validModels = modelList.filter((m) => m.name.trim() !== "");
        if (validModels.length === 0) {
          setError(t("models.needModel"));
          setSaving(false);
          return;
        }

        const providerId = formChannel.trim().toLowerCase().replace(/\s+/g, "-");
        const allCfg = await window.piDesk.getCustomModelsJson().catch(() => ({}));
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

        const providerName =
          (typeof existingCfg?.name === "string" && existingCfg.name) ||
          formChannel.trim();

        await window.piDesk.saveCustomProvider(providerId, {
          api: "openai-completions",
          name: providerName,
          channel: formChannel.trim(),
          baseUrl,
          apiKey: formApiKey.trim(),
          models,
        });
      } else {
        await window.piDesk.saveApiKey(selectedProvider, formApiKey.trim());
      }
      setShowDialog(false);
      await loadConfigured();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("models.saveFailed"));
    } finally { setSaving(false); }
  };

  const handleRemove = (p: ProviderInfo) => {
    // Two-step delete: ask for confirmation first (removing a custom provider
    // also removes EVERY model under it — irreversible).
    setPendingRemove(p);
  };

  const confirmRemove = async () => {
    const p = pendingRemove;
    setPendingRemove(null);
    if (!p) return;
    try {
      // Decide custom-vs-builtin by looking at custom-models.json keys rather
      // than the runtime registration table: the registry ALSO contains
      // built-in providers, so a custom provider whose name collided with a
      // built-in id would be misrouted to deleteApiKey (and silently fail).
      const cfg = await window.piDesk.getCustomModelsJson().catch(() => ({}));
      if (cfg && Object.prototype.hasOwnProperty.call(cfg, p.id)) {
        await window.piDesk.deleteCustomProvider(p.id);
      } else {
        await window.piDesk.deleteApiKey(p.id);
      }
      await loadConfigured();
    } catch (err) { console.error(err); }
  };

  if (loading) return <div className={styles.loading}>{t("loading")}</div>;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>{t("models.title")}</h1>
        <button className={styles.addBtn} onClick={openDialog}>
          <Plus size={16} />
          <span>{t("models.addBtn")}</span>
        </button>
      </div>

      {/* ── Configured models list ── */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>{t("models.configured")}</h2>
        {configured.length === 0 ? (
          <div className={styles.emptyHint}>
            {t("models.empty")}{" "}
            <button className={styles.textLink} onClick={openDialog}>{t("models.addNow")}</button>
          </div>
        ) : (
          <div className={styles.modelList}>
            {configured.map((p) => {
              const tag = PROVIDER_API_TAG[p.id];
              return (
                <div key={p.id} className={styles.modelRow}>
                  <div className={styles.modelRowLeft}>
                    <Check size={14} className={styles.checkIcon} />
                    <div className={styles.modelRowText}>
                      <span className={styles.modelRowName}>{p.channel || p.name}</span>
                      {p.channel && p.channel !== p.name && (
                        <span className={styles.modelRowSub}>{p.name}</span>
                      )}
                    </div>
                    {tag && <span className={`${styles.apiTag} ${styles[tag.cls] ?? ""}`}>{tag.label}</span>}
                  </div>
                  <div className={styles.modelRowRight}>
                    <span className={styles.modelRowMeta}>{p.authSource ?? t("configured")}</span>
                    <button className={styles.removeBtn} onClick={() => handleRemove(p)} title={t("remove")}>
                      <X size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Add model dialog ── */}
      {showDialog && (
        <AddModelDialog
          selectedProvider={selectedProvider}
          setSelectedProvider={setSelectedProvider}
          formChannel={formChannel}
          setFormChannel={setFormChannel}
          formBaseUrl={formBaseUrl}
          setFormBaseUrl={setFormBaseUrl}
          formApiKey={formApiKey}
          setFormApiKey={setFormApiKey}
          modelList={modelList}
          setModelList={setModelList}
          addManualModel={addManualModel}
          updateModelName={updateModelName}
          updateModelCtx={updateModelCtx}
          updateModelImg={updateModelImg}
          updateModelReasoning={updateModelReasoning}
          updateModelThinkingFormat={updateModelThinkingFormat}
          removeModel={removeModel}
          fetchPopupOpen={fetchPopupOpen}
          setFetchPopupOpen={setFetchPopupOpen}
          popupModels={popupModels}
          popupChecked={popupChecked}
          fetching={fetching}
          fetchError={fetchError}
          doFetch={doFetch}
          openFetchPopup={openFetchPopup}
          togglePopupModel={togglePopupModel}
          toggleSelectAll={toggleSelectAll}
          confirmPopup={confirmPopup}
          canSave={canSave}
          saving={saving}
          error={error}
          onSave={handleSave}
          onClose={() => setShowDialog(false)}
        />
      )}

      {/* ── Delete confirmation (custom providers own every model under them) ── */}
      <ConfirmDialog
        open={pendingRemove !== null}
        title={t("models.confirmDeleteTitle")}
        message={t("models.confirmDelete", { name: pendingRemove?.name ?? "" })}
        confirmLabel={t("models.delete")}
        cancelLabel={t("cancel")}
        danger
        onConfirm={confirmRemove}
        onCancel={() => setPendingRemove(null)}
      />
    </div>
  );
}

// ── Add-model dialog with custom dropdown ──
interface AddModelDialogProps {
  selectedProvider: string;
  setSelectedProvider: (v: string) => void;
  formChannel: string; setFormChannel: (v: string) => void;
  formBaseUrl: string; setFormBaseUrl: (v: string) => void;
  formApiKey: string; setFormApiKey: (v: string) => void;
  modelList: ModelEntry[];
  setModelList: (v: ModelEntry[]) => void;
  addManualModel: () => void;
  updateModelName: (key: string, name: string) => void;
  updateModelCtx: (key: string, raw: string) => void;
  updateModelImg: (key: string, val: boolean) => void;
  updateModelReasoning: (key: string, val: boolean) => void;
  updateModelThinkingFormat: (key: string, val: string) => void;
  removeModel: (key: string) => void;
  fetchPopupOpen: boolean; setFetchPopupOpen: (v: boolean) => void;
  popupModels: string[];
  popupChecked: Record<string, boolean>;
  fetching: boolean; fetchError: string;
  doFetch: () => void;
  openFetchPopup: () => void;
  togglePopupModel: (id: string, checked: boolean) => void;
  toggleSelectAll: (checked: boolean) => void;
  confirmPopup: () => void;
  canSave: boolean;
  saving: boolean;
  error: string;
  onSave: () => void;
  onClose: () => void;
}

function AddModelDialog(props: AddModelDialogProps) {
  const { t } = useTranslation();
  const isCustom = props.selectedProvider === "__custom__";
  return (
    <div className={styles.dialogOverlay} onClick={props.onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.dialogHeader}>
          <h3 className={styles.dialogTitle}>{t("models.addTitle")}</h3>
          <button className={styles.closeBtn} onClick={props.onClose}>
            <X size={16} />
          </button>
        </div>
        <div className={styles.dialogBody}>
          <ProviderDropdown
            value={props.selectedProvider}
            onChange={props.setSelectedProvider}
            placeholder={t("models.selectProvider")}
          />

          {isCustom && (
            <>
              <div className={styles.fieldRow}>
                <Tag size={14} className={styles.fieldIcon} />
                <div className={styles.fieldStack}>
                  <label className={styles.fieldLabel}>{t("models.channel")}<span className={styles.required}>*</span></label>
                  <input className={styles.fieldInput} type="text"
                    placeholder={t("models.channelPlaceholder")}
                    value={props.formChannel} onChange={(e) => props.setFormChannel(e.target.value)} />
                </div>
              </div>

              <div className={styles.fieldRow}>
                <Globe size={14} className={styles.fieldIcon} />
                <div className={styles.fieldStack}>
                  <label className={styles.fieldLabel}>{t("models.baseUrl")}<span className={styles.required}>*</span></label>
                  <input className={styles.fieldInput} type="url"
                    placeholder="http://localhost:1234/v1"
                    value={props.formBaseUrl} onChange={(e) => props.setFormBaseUrl(e.target.value)} />
                </div>
              </div>
            </>
          )}

          <div className={styles.fieldRow}>
            <Key size={14} className={styles.fieldIcon} />
            <div className={styles.fieldStack}>
              <label className={styles.fieldLabel}>{t("models.apiKey")}<span className={styles.required}>*</span></label>
              <input className={styles.fieldInput} type="password"
                placeholder={props.selectedProvider === "__custom__" ? "sk-..." : t("models.apiKey")}
                value={props.formApiKey} onChange={(e) => props.setFormApiKey(e.target.value)}
                autoFocus />
            </div>
          </div>

          {isCustom && (
            <>
              {!props.formApiKey.trim() && (
                <p className={styles.fetchHint}>
                  {t("models.fetchNeedsKey")}
                </p>
              )}

              <div className={styles.divider} />

              {/* ── Model catalog ── */}
              <div className={styles.catalogHead}>
                <span className={styles.catalogTitle}>{t("models.catalog")}</span>
                <div className={styles.catalogActions}>
                  <button type="button" className={styles.addModelBtn} onClick={props.addManualModel}>
                    <Plus size={14} />
                    {t("models.addModel")}
                  </button>
                  <button
                    type="button"
                    className={styles.fetchBtn}
                    onClick={props.openFetchPopup}
                    disabled={!props.formBaseUrl.trim()}
                  >
                    <Download size={14} />
                    {t("models.fetchModels")}
                  </button>
                </div>
              </div>

              {props.modelList.length === 0 ? (
                <div className={styles.catalogEmpty}>{t("models.catalogEmpty")}</div>
              ) : (
                <div className={styles.catalogList}>
                  {props.modelList.map((m) => (
                    <div key={m.key} className={styles.catalogRow}>
                      <div className={styles.catalogRowTop}>
                        <input
                          className={styles.fieldInput}
                          type="text"
                          placeholder={t("models.modelName")}
                          value={m.name}
                          disabled={!m.editableName}
                          onChange={(e) => props.updateModelName(m.key, e.target.value)}
                        />
                        <button
                          type="button"
                          className={styles.catalogRowDel}
                          onClick={() => props.removeModel(m.key)}
                          title={t("models.deleteModel")}
                        >
                          <Trash size={14} />
                        </button>
                      </div>
                      <div className={styles.catalogRowOpts}>
                        <label className={styles.fieldRow}>
                          <span className={styles.fieldLabel}>{t("models.contextWindow")}</span>
                          <input
                            className={styles.fieldInput}
                            type="number"
                            min={1}
                            step={1000}
                            placeholder="128000"
                            value={Number.isFinite(m.contextWindow) ? m.contextWindow : ""}
                            onChange={(e) => props.updateModelCtx(m.key, e.target.value)}
                          />
                        </label>
                        <label className={styles.checkRow}>
                          <input
                            type="checkbox"
                            className={styles.checkbox}
                            checked={m.supportsImages}
                            onChange={(e) => props.updateModelImg(m.key, e.target.checked)}
                          />
                          <span className={styles.checkText}>
                            <span className={styles.checkLabel}>{t("models.supportsImages")}</span>
                          </span>
                        </label>
                        <label className={styles.checkRow} title={t("models.supportsReasoningHint")}>
                          <input
                            type="checkbox"
                            className={styles.checkbox}
                            checked={m.reasoning}
                            onChange={(e) => props.updateModelReasoning(m.key, e.target.checked)}
                          />
                          <span className={styles.checkText}>
                            <span className={styles.checkLabel}>{t("models.supportsReasoning")}</span>
                          </span>
                        </label>
                        {m.reasoning && (
                          <label className={styles.fieldRow} title={t("models.thinkingFormatHint")}>
                            <span className={styles.fieldLabel}>{t("models.thinkingFormat")}</span>
                            <select
                              className={styles.fieldInput}
                              value={m.thinkingFormat}
                              onChange={(e) => props.updateModelThinkingFormat(m.key, e.target.value)}
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

          {props.error && <div className={styles.formError}>{props.error}</div>}

          <div className={styles.formActions}>
            <button className={styles.formBtnCancel} onClick={props.onClose}>{t("cancel")}</button>
            <button className={styles.formBtnSave} onClick={props.onSave}
              disabled={!props.canSave || props.saving}>
              {props.saving ? t("models.saving") : t("save")}
            </button>
          </div>
        </div>

        {/* ── Fetch available models popup ── */}
        {props.fetchPopupOpen && (
          <div
            className={styles.fetchPopupOverlay}
            onClick={(e) => { if (e.target === e.currentTarget) props.setFetchPopupOpen(false); }}
          >
            <div className={styles.fetchPopup} onClick={(e) => e.stopPropagation()}>
              <div className={styles.fetchPopupHeader}>
                <h4 className={styles.fetchPopupTitle}>{t("models.fetchModels")}</h4>
                <button className={styles.closeBtn} onClick={() => props.setFetchPopupOpen(false)} title={t("close")}>
                  <X size={16} />
                </button>
              </div>
              <div className={styles.fetchPopupBody}>
                {props.popupModels.length === 0 ? (
                  <div className={styles.fetchPopupEmpty}>
                    {props.fetchError ? (
                      <span className={styles.fetchError}>{props.fetchError}</span>
                    ) : props.fetching ? (
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
                      checked={props.popupModels.length > 0 && props.popupModels.every((id) => props.popupChecked[id])}
                      onChange={(e) => props.toggleSelectAll(e.target.checked)}
                    />
                    <span className={styles.modelPickName}>{t("models.selectAll")}</span>
                  </label>
                  <div className={styles.fetchPopupList}>
                    {props.popupModels.map((id) => {
                      const checked = !!props.popupChecked[id];
                      return (
                        <label key={id} className={styles.modelPickHead}>
                          <input
                            type="checkbox"
                            className={styles.checkbox}
                            checked={checked}
                            onChange={(e) => props.togglePopupModel(id, e.target.checked)}
                          />
                          <span className={styles.modelPickName}>{id}</span>
                        </label>
                      );
                    })}
                  </div>
                  </>
                )}
              </div>
              <div className={styles.fetchPopupFooter}>
                <button className={styles.formBtnCancel} onClick={() => props.setFetchPopupOpen(false)}>{t("cancel")}</button>
                <button
                  className={styles.formBtnSave}
                  onClick={props.confirmPopup}
                  disabled={Object.keys(props.popupChecked).length === 0}
                >
                  {t("models.addSelected")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Custom dropdown component (replaces native <select>) ──
function ProviderDropdown({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const selected = BUILTIN_PROVIDERS.find((p) => p.id === value);
  const selectedTag = value ? PROVIDER_API_TAG[value] : null;

  return (
    <div className={styles.fieldRow}>
      <Tag size={14} className={styles.fieldIcon} />
      <div className={styles.fieldStack}>
        <label className={styles.fieldLabel}>{t("models.provider")}</label>
        <div className={styles.dropdown} ref={ref}>
          <button
            type="button"
            className={`${styles.dropdownTrigger} ${open ? styles.dropdownTriggerOpen : ""}`}
            onClick={() => setOpen(!open)}
          >
            {selected ? (
              <span className={styles.dropdownSelected}>
                <span className={styles.dropdownSelectedName}>{selected.name}</span>
                {selectedTag && (
                  <span className={`${styles.apiTag} ${styles[selectedTag.cls] ?? ""} ${styles.apiTagSm}`}>
                    {selectedTag.label}
                  </span>
                )}
              </span>
            ) : (
              <span className={styles.dropdownPlaceholder}>{placeholder}</span>
            )}
            <ChevronDown size={14} className={`${styles.dropdownChevron} ${open ? styles.dropdownChevronOpen : ""}`} />
          </button>
          {open && (
            <div className={styles.dropdownMenu}>
              {BUILTIN_PROVIDERS.map((p) => {
                const tag = PROVIDER_API_TAG[p.id];
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`${styles.dropdownItem} ${value === p.id ? styles.dropdownItemActive : ""}`}
                    onClick={() => { onChange(p.id); setOpen(false); }}
                  >
                    <span className={styles.dropdownItemName}>{p.name}</span>
                    {tag && (
                      <span className={`${styles.apiTag} ${styles[tag.cls] ?? ""} ${styles.apiTagSm}`}>
                        {tag.label}
                      </span>
                    )}
                    {value === p.id && <Check size={12} className={styles.dropdownItemCheck} />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
