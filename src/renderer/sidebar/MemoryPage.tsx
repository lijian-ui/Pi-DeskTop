import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, FileText, Pencil, Trash2, X } from "lucide-react";
import styles from "./ContextPage.module.css";
import switchStyles from "./MemoryPage.module.css";
import ConfirmDialog from "./ConfirmDialog";

/**
 * 规则与记忆。
 * 1) 导入设置：两个滑块开关控制 Pi SDK 是否把 AGENTS.md 与 CLAUDE.md
 *    （含 CLAUDE.local.md）注入系统提示词，拨动即保存。
 * 2) 规则：单一 rules.md 文件（~/.pi/agent/rules/rules.md），以
 *    `<rules>…</rules>` 追加到系统提示词最末尾，所有会话与定时任务遵循。
 */
export default function MemoryPage() {
  const { t } = useTranslation();

  // ── 导入设置（AGENTS / CLAUDE 均默认关闭，用户自行启用）──
  const [agents, setAgents] = useState(false);
  const [claude, setClaude] = useState(false);

  // ── 规则 ──
  const [rulesContent, setRulesContent] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorText, setEditorText] = useState("");
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [rulesSaving, setRulesSaving] = useState(false);
  const [rulesSaved, setRulesSaved] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [cfg, rules] = await Promise.all([
        window.piDesk.getContextFilesConfig(),
        window.piDesk.getRulesContent(),
      ]);
      setAgents(cfg.agents);
      setClaude(cfg.claude);
      setRulesContent(rules);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** Flip an import switch and persist immediately. */
  const toggle = async (key: "agents" | "claude") => {
    setError("");
    const next =
      key === "agents" ? { agents: !agents, claude } : { agents, claude: !claude };
    if (key === "agents") setAgents(next.agents);
    else setClaude(next.claude);
    try {
      await window.piDesk.setContextFilesConfig(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** Open the rules editor (creates the file on first save). */
  const openEditor = () => {
    setEditorText(rulesContent);
    setEditorOpen(true);
  };

  const saveRules = async () => {
    setRulesSaving(true);
    setRulesSaved(false);
    setError("");
    try {
      await window.piDesk.saveRulesContent(editorText);
      setRulesContent(editorText);
      setEditorOpen(false);
      setRulesSaved(true);
      setTimeout(() => setRulesSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRulesSaving(false);
    }
  };

  const confirmDelete = async () => {
    setConfirmDeleteOpen(false);
    setError("");
    try {
      await window.piDesk.deleteRulesFile();
      setRulesContent("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (loading) return <div className={styles.loading}>{t("tools.loading")}</div>;

  return (
    <div className={styles.page}>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{t("memory.importTitle")}</h2>
        <div className={switchStyles.card}>
          <div className={switchStyles.cardRow}>
            <div className={switchStyles.cardText}>
              <div className={styles.toggleLabel}>{t("memory.agents")}</div>
              <div className={switchStyles.cardDesc}>{t("memory.agentsDesc")}</div>
            </div>
            <button
              type="button"
              className={`${switchStyles.switch} ${switchStyles.switchRight} ${agents ? switchStyles.switchOn : ""}`}
              onClick={() => toggle("agents")}
              title={t("memory.agents")}
            >
              <span className={switchStyles.switchKnob} />
            </button>
          </div>

          <div className={switchStyles.cardDivider} />

          <div className={switchStyles.cardRow}>
            <div className={switchStyles.cardText}>
              <div className={styles.toggleLabel}>{t("memory.claude")}</div>
              <div className={switchStyles.cardDesc}>{t("memory.claudeDesc")}</div>
            </div>
            <button
              type="button"
              className={`${switchStyles.switch} ${switchStyles.switchRight} ${claude ? switchStyles.switchOn : ""}`}
              onClick={() => toggle("claude")}
              title={t("memory.claude")}
            >
              <span className={switchStyles.switchKnob} />
            </button>
          </div>
        </div>
      </section>

      {/* ── 规则 ── */}
      <section className={styles.section}>
        <div className={switchStyles.sectionHeader}>
          <h2 className={styles.sectionTitle}>{t("rules.title")}</h2>
          <button
            type="button"
            className={switchStyles.iconBtn}
            onClick={load}
            title={t("rules.refresh")}
          >
            <RefreshCw size={14} />
          </button>
        </div>
        <div className={switchStyles.card}>
          <div className={switchStyles.cardHeader}>
            <span className={switchStyles.cardDesc}>{t("rules.desc")}</span>
            <button type="button" className={switchStyles.createBtn} onClick={openEditor}>
              {rulesContent.trim() ? (
                <>
                  <Pencil size={12} />
                  {t("rules.edit")}
                </>
              ) : (
                <>
                  <span className={switchStyles.createBtnIcon}>+</span>
                  {t("rules.create")}
                </>
              )}
            </button>
          </div>

          {rulesContent.trim() ? (
            <div className={switchStyles.ruleRow}>
              <FileText size={15} className={switchStyles.ruleIcon} />
              <span className={switchStyles.rulePreview}>{rulesContent}</span>
              <button
                type="button"
                className={switchStyles.ruleDeleteBtn}
                onClick={() => setConfirmDeleteOpen(true)}
                title={t("rules.delete")}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ) : (
            <div className={switchStyles.ruleEmpty}>{t("rules.empty")}</div>
          )}
        </div>
      </section>

      {error && <p className={styles.error}>{error}</p>}
      {rulesSaved && <p className={switchStyles.savedMsg}>{t("rules.saved")}</p>}

      {/* ── Rules editor modal ── */}
      {editorOpen && (
        <div className={switchStyles.editorOverlay} onClick={() => setEditorOpen(false)}>
          <div
            className={switchStyles.editorModal}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={switchStyles.editorHeader}>
              <h3 className={switchStyles.editorTitle}>{t("rules.editorTitle")}</h3>
              <button
                type="button"
                className={switchStyles.iconBtn}
                onClick={() => setEditorOpen(false)}
                title={t("rules.cancel")}
              >
                <X size={14} />
              </button>
            </div>
            <textarea
              className={switchStyles.editorTextarea}
              value={editorText}
              onChange={(e) => setEditorText(e.target.value)}
              placeholder={t("rules.editorPlaceholder")}
              autoFocus
            />
            <div className={switchStyles.editorFooter}>
              <button
                type="button"
                className={switchStyles.editorBtnGhost}
                onClick={() => setEditorOpen(false)}
              >
                {t("rules.cancel")}
              </button>
              <button
                type="button"
                className={switchStyles.editorBtnPrimary}
                onClick={saveRules}
                disabled={rulesSaving}
              >
                {rulesSaving ? t("rules.saving") : t("rules.save")}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDeleteOpen}
        title={t("rules.deleteConfirmTitle")}
        message={t("rules.deleteConfirmMsg")}
        confirmLabel={t("rules.confirmDelete")}
        cancelLabel={t("rules.cancel")}
        onConfirm={confirmDelete}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
    </div>
  );
}