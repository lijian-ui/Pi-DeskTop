import { useState, useEffect, useCallback, useRef } from "react";
import { Plus, X, Globe, Key, Tag, Check, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import ConfirmDialog from "./ConfirmDialog";
import styles from "./SettingsPanel.module.css";

interface ProviderInfo {
  id: string;
  name: string;
  baseUrl?: string;
  configured: boolean;
  authSource: string | null;
}

// ── Built-in provider list for the dropdown ──
const BUILTIN_PROVIDERS = [
  { id: "openai",                name: "OpenAI" },
  { id: "anthropic",             name: "Anthropic (Claude)" },
  { id: "google",                name: "Google (Gemini)" },
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
  const [formName, setFormName] = useState("");
  const [formBaseUrl, setFormBaseUrl] = useState("");
  const [formApiKey, setFormApiKey] = useState("");
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
    setFormName(""); setFormBaseUrl(""); setFormApiKey("");
    setError(""); setShowDialog(true);
  };

  const handleSave = async () => {
    if (!selectedProvider) { setError(t("models.providerRequired")); return; }
    if (!formApiKey.trim()) { setError(t("models.apiKeyRequired")); return; }

    setSaving(true); setError("");
    try {
      if (selectedProvider === "__custom__") {
        // Validate BEFORE deriving the provider id / model id — the old order
        // computed them from an (possibly empty) name first, which would write
        // into a "" key if the guard below were ever moved or deleted.
        if (!formName.trim()) { setError(t("models.nameRequired")); return; }
        let baseUrl = formBaseUrl.trim().replace(/\/+$/, "");
        if (!baseUrl) { setError(t("models.urlRequired")); return; }
        if (!/\/v1$/i.test(baseUrl)) baseUrl += "/v1";
        const providerId = formName.trim().toLowerCase().replace(/\s+/g, "-");
        // Model id must be the server-side identifier verbatim (see
        // AddProviderPicker): it is sent as the `model` field in requests.
        const modelId = formName.trim();
        // Merge with any existing models under this provider instead of
        // replacing them (upsert by model id).
        const allCfg = await window.piDesk.getCustomModelsJson().catch(() => ({}));
        const existingCfg = (allCfg as Record<string, any>)[providerId];
        const existingModels: any[] = Array.isArray(existingCfg?.models) ? existingCfg.models : [];
        await window.piDesk.saveCustomProvider(providerId, {
          api: "openai-completions",
          name: (typeof existingCfg?.name === "string" && existingCfg.name) || formName.trim(),
          baseUrl,
          apiKey: formApiKey.trim(),
          models: [
            ...existingModels.filter((m) => String(m?.id) !== modelId),
            { id: modelId, name: formName.trim(), reasoning: false, input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000, maxTokens: 16384 },
          ],
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
                    <span className={styles.modelRowName}>{p.name}</span>
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
          formName={formName}
          setFormName={setFormName}
          formBaseUrl={formBaseUrl}
          setFormBaseUrl={setFormBaseUrl}
          formApiKey={formApiKey}
          setFormApiKey={setFormApiKey}
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
  formName: string; setFormName: (v: string) => void;
  formBaseUrl: string; setFormBaseUrl: (v: string) => void;
  formApiKey: string; setFormApiKey: (v: string) => void;
  saving: boolean;
  error: string;
  onSave: () => void;
  onClose: () => void;
}

function AddModelDialog(props: AddModelDialogProps) {
  const { t } = useTranslation();
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

          {props.selectedProvider === "__custom__" && (
            <>
              <div className={styles.fieldRow}>
                <Tag size={14} className={styles.fieldIcon} />
                <div className={styles.fieldStack}>
                  <label className={styles.fieldLabel}>{t("models.modelName")}</label>
                  <input className={styles.fieldInput} type="text"
                    placeholder={t("models.modelName")}
                    value={props.formName} onChange={(e) => props.setFormName(e.target.value)} />
                </div>
              </div>
              <div className={styles.fieldRow}>
                <Globe size={14} className={styles.fieldIcon} />
                <div className={styles.fieldStack}>
                  <label className={styles.fieldLabel}>{t("models.baseUrl")}</label>
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
              <label className={styles.fieldLabel}>{t("models.apiKey")}</label>
              <input className={styles.fieldInput} type="password"
                placeholder={props.selectedProvider === "__custom__" ? "sk-..." : t("models.apiKey")}
                value={props.formApiKey} onChange={(e) => props.setFormApiKey(e.target.value)}
                autoFocus />
            </div>
          </div>

          {props.error && <div className={styles.formError}>{props.error}</div>}

          <div className={styles.formActions}>
            <button className={styles.formBtnCancel} onClick={props.onClose}>{t("cancel")}</button>
            <button className={styles.formBtnSave} onClick={props.onSave}
              disabled={!props.selectedProvider || !props.formApiKey.trim() || props.saving}>
              {props.saving ? t("models.saving") : t("save")}
            </button>
          </div>
        </div>
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