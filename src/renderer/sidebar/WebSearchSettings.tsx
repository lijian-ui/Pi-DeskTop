import { useState, useEffect } from "react";
import type { WebSearchConfig, WebSearchProviderTest } from "../../preload/api";
import styles from "./WebSearchSettings.module.css";

/**
 * Settings → "Web 搜索" (web_search / web_fetch tool configuration).
 *
 * Reads/writes ~/.pi/agent/websearch-config.json via the preload. The master
 * switch and provider keys drive whether the tools are registered at session
 * creation (the extension reads config live, so key/timeout edits apply without
 * a reload; toggling `enabled` / changing `provider` takes effect on the next
 * new session).
 */
const PROVIDER_IDS = ["anysearch", "tinyfish", "tavily", "bocha"] as const;
const PROVIDER_LABELS: Record<string, string> = {
  anysearch: "AnySearch",
  tinyfish: "TinyFish",
  tavily: "Tavily",
  bocha: "博查",
};

function defaultConfig(): WebSearchConfig {
  return {
    enabled: false,
    provider: "anysearch",
    searchProviders: {
      anysearch: { apiKey: "", enabled: false },
      tinyfish: { apiKey: "", enabled: false },
      tavily: { apiKey: "", enabled: false },
      bocha: { apiKey: "", enabled: false },
    },
    fetchProvider: "anysearch",
    resultCount: 5,
    timeoutMs: 15_000,
    fetchTimeoutMs: 60_000,
    maxFetchChars: 12_000,
    ssrfProtection: true,
    electronRender: true,
    internalHostAllowlist: ["localhost", "127.0.0.1"],
  };
}

export default function WebSearchSettings() {
  const [cfg, setCfg] = useState<WebSearchConfig>(defaultConfig());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [tests, setTests] = useState<WebSearchProviderTest[]>([]);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    window.piDesk
      .getWebSearchConfig()
      .then((c) => setCfg(c))
      .catch(() => setError("加载配置失败"))
      .finally(() => setLoading(false));
  }, []);

  const update = (patch: Partial<WebSearchConfig>) =>
    setCfg((c) => ({ ...c, ...patch }));

  const updateProvider = (
    id: (typeof PROVIDER_IDS)[number],
    patch: Partial<WebSearchConfig["searchProviders"][(typeof PROVIDER_IDS)[number]]>,
  ) =>
    setCfg((c) => ({
      ...c,
      searchProviders: { ...c.searchProviders, [id]: { ...c.searchProviders[id], ...patch } },
    }));

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      await window.piDesk.saveWebSearchConfig(cfg);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setError("");
    setTests([]);
    try {
      setTests(await window.piDesk.testWebSearch());
    } catch (e) {
      setError(e instanceof Error ? e.message : "测试失败");
    } finally {
      setTesting(false);
    }
  }

  if (loading) return <div className={styles.loading}>加载中…</div>;

  return (
    <div className={styles.page}>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Web 搜索</h2>
        <p className={styles.sectionDesc}>
          为 Pi 注入 web_search 工具，让模型可实时检索互联网。
        </p>

        <label className={styles.row}>
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
          />
          <span>启用 Web 搜索（同时开启 web_fetch 抓取）</span>
        </label>

        <div className={styles.grid}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>首选搜索 Provider</label>
            <select
              className={styles.input}
              value={cfg.provider}
              onChange={(e) => update({ provider: e.target.value as WebSearchConfig["provider"] })}
            >
              {PROVIDER_IDS.map((id) => (
                <option key={id} value={id}>
                  {PROVIDER_LABELS[id]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <h3 className={styles.subTitle}>Provider API Keys</h3>
        {PROVIDER_IDS.map((id) => {
          const p = cfg.searchProviders[id];
          const test = tests.find((t) => t.id === id);
          return (
            <div key={id} className={styles.providerRow}>
              <div className={styles.providerHead}>
                <label className={styles.providerName}>
                  <input
                    type="checkbox"
                    checked={p.enabled}
                    onChange={(e) => updateProvider(id, { enabled: e.target.checked })}
                  />
                  <span>{PROVIDER_LABELS[id]}</span>
                </label>
                {test && (
                  <span className={test.ok ? styles.statusOk : styles.statusFail}>
                    {test.ok ? "✓ 可用" : `✗ ${test.error ?? "不可用"}`}
                  </span>
                )}
              </div>
              <input
                type="password"
                className={styles.input}
                placeholder="API Key"
                value={p.apiKey}
                onChange={(e) => updateProvider(id, { apiKey: e.target.value })}
              />
            </div>
          );
        })}

        <h3 className={styles.subTitle}>参数</h3>
        <div className={styles.grid}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>每次结果数 (1-10)</label>
            <input
              type="number"
              min={1}
              max={10}
              className={styles.input}
              value={cfg.resultCount}
              onChange={(e) => update({ resultCount: Number(e.target.value) })}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>搜索超时 (ms)</label>
            <input
              type="number"
              min={1000}
              max={120000}
              step={1000}
              className={styles.input}
              value={cfg.timeoutMs}
              onChange={(e) => update({ timeoutMs: Number(e.target.value) })}
            />
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Web 抓取 (web_fetch)</h2>
        <p className={styles.sectionDesc}>
          按 URL 抓取网页全文（含今日头条 / 公众号等 JS 渲染页），转文本供模型深入阅读。
        </p>

        <div className={styles.grid}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>抓取 Provider</label>
            <select
              className={styles.input}
              value={cfg.fetchProvider}
              onChange={(e) =>
                update({ fetchProvider: e.target.value as WebSearchConfig["fetchProvider"] })
              }
            >
              <option value="anysearch">AnySearch</option>
              <option value="tinyfish">TinyFish</option>
              <option value="electron">浏览器渲染（无头 Chromium）</option>
              <option value="local">本地抓取（兜底）</option>
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>抓取超时 (ms)</label>
            <input
              type="number"
              min={1000}
              max={180000}
              step={1000}
              className={styles.input}
              value={cfg.fetchTimeoutMs}
              onChange={(e) => update({ fetchTimeoutMs: Number(e.target.value) })}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>抓取最大字符</label>
            <input
              type="number"
              min={500}
              max={200000}
              step={500}
              className={styles.input}
              value={cfg.maxFetchChars}
              onChange={(e) => update({ maxFetchChars: Number(e.target.value) })}
            />
          </div>
        </div>

        <label className={styles.row}>
          <input
            type="checkbox"
            checked={cfg.ssrfProtection}
            onChange={(e) => update({ ssrfProtection: e.target.checked })}
          />
          <span>SSRF 防护（阻止抓取内网 / 云元数据地址）</span>
        </label>

        <label className={styles.row}>
          <input
            type="checkbox"
            checked={cfg.electronRender}
            onChange={(e) => update({ electronRender: e.target.checked })}
          />
          <span>浏览器渲染（JS 重度页面：今日头条 / 公众号 / Vue / React，复用内置 Chromium）</span>
        </label>

        {error && <p className={styles.error}>{error}</p>}
      </section>

      <div className={styles.actions}>
        <button
          className={`${styles.saveBtn} ${saved ? styles.saveBtnSuccess : ""}`}
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? "保存中…" : saved ? "已保存" : "保存"}
        </button>
        <button className={styles.clearBtn} onClick={handleTest} disabled={testing}>
          {testing ? "测试中…" : "测试连接"}
        </button>
      </div>
    </div>
  );
}
