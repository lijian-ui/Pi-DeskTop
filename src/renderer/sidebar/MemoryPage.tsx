import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, FileText, Pencil, Trash2, X, Search, Star, AlertTriangle, History } from "lucide-react";
import styles from "./ContextPage.module.css";
import switchStyles from "./MemoryPage.module.css";
import ConfirmDialog from "./ConfirmDialog";
import type { MemoryView, SnapshotInfo, MemoryConfigView, MemoryConfigPatch, EpisodicResult } from "../../preload/api";

const MEMORY_CATEGORIES = [
  "failure",
  "correction",
  "insight",
  "preference",
  "convention",
  "tool-quirk",
];

/**
 * 规则与记忆。
 * 1) 导入设置：两个滑块开关控制 Pi SDK 是否把 AGENTS.md 与 CLAUDE.md
 *    （含 CLAUDE.local.md）注入系统提示词，拨动即保存。
 * 2) 规则：单一 rules.md 文件（~/.pi/agent/rules/rules.md），以
 *    `<rules>…</rules>` 追加到系统提示词最末尾，所有会话与定时任务遵循。
 * 3) 记忆库：浏览 / 搜索 / 编辑 / 删除 / 置顶 Hermes 记忆（可编辑）。
 * 4) 快照：记忆库 7 天轮转备份的手动触发与列表。
 * 5) 记忆设置：核心记忆旋钮（沉淀/复习/衰减/锚点/守卫），改完热重载生效。
 *
 * 注：曾有一节「常驻指令」（hermes STANDING.md，注入 <standing-instructions>），
 * 与「规则」在语义和注入时机上完全重叠，已移除 —— 需要"必须始终遵守"的约束
 * 请统一写进「规则」，它覆盖所有会话且包括定时任务。
 */

/** 一行开关（记忆设置用）。 */
function CfgSwitch({
  label,
  desc,
  on,
  onClick,
}: {
  label: string;
  desc: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <div className={switchStyles.cardRow}>
      <div className={switchStyles.cardText}>
        <div className={styles.toggleLabel}>{label}</div>
        <div className={switchStyles.cardDesc}>{desc}</div>
      </div>
      <button
        type="button"
        className={`${switchStyles.switch} ${switchStyles.switchRight} ${on ? switchStyles.switchOn : ""}`}
        onClick={onClick}
        title={label}
      >
        <span className={switchStyles.switchKnob} />
      </button>
    </div>
  );
}

/** 一行数字输入（记忆设置用，失焦/回车提交）。 */
function CfgNumber({
  label,
  desc,
  value,
  min,
  step,
  onCommit,
}: {
  label: string;
  desc: string;
  value: number;
  min?: number;
  step?: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed) || parsed < (min ?? 0)) {
      setDraft(String(value));
      return;
    }
    if (parsed !== value) onCommit(parsed);
  };

  return (
    <div className={switchStyles.cardRow}>
      <div className={switchStyles.cardText}>
        <div className={styles.toggleLabel}>{label}</div>
        <div className={switchStyles.cardDesc}>{desc}</div>
      </div>
      <input
        type="number"
        className={switchStyles.cfgInput}
        value={draft}
        min={min}
        step={step}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
}

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

  // ── 记忆浏览面板（可编辑）──
  const [memories, setMemories] = useState<MemoryView[]>([]);
  const [memQuery, setMemQuery] = useState("");
  const [memLoading, setMemLoading] = useState(false);
  const [memError, setMemError] = useState("");
  const [editTarget, setEditTarget] = useState<MemoryView | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<MemoryView | null>(null);

  // ── Episodic 回溯（记忆 → 原始会话）──
  const [epiTarget, setEpiTarget] = useState<MemoryView | null>(null);
  const [epiData, setEpiData] = useState<EpisodicResult | null>(null);
  const [epiLoading, setEpiLoading] = useState(false);
  const [epiError, setEpiError] = useState("");

  // ── 快照 ──
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
  const [snapBusy, setSnapBusy] = useState(false);

  // ── 记忆功能配置 ──
  const [mcfg, setMcfg] = useState<MemoryConfigView | null>(null);
  const [cfgSaving, setCfgSaving] = useState(false);
  const [cfgMsg, setCfgMsg] = useState("");
  const [cfgError, setCfgError] = useState("");

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

  const loadMemories = useCallback(async () => {
    setMemLoading(true);
    setMemError("");
    try {
      const list = memQuery.trim()
        ? await window.piDesk.searchMemories(memQuery.trim())
        : await window.piDesk.listMemories();
      setMemories(list);
    } catch (err) {
      setMemError(err instanceof Error ? err.message : String(err));
    }
    setMemLoading(false);
  }, [memQuery]);

  useEffect(() => {
    loadMemories();
  }, [loadMemories]);

  const loadSnapshots = useCallback(async () => {
    try {
      setSnapshots(await window.piDesk.memoryListSnapshots());
    } catch {
      /* 快照不可用时不阻塞页面 */
    }
  }, []);

  useEffect(() => {
    loadSnapshots();
  }, [loadSnapshots]);

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

  const confirmDeleteRules = async () => {
    setConfirmDeleteOpen(false);
    setError("");
    try {
      await window.piDesk.deleteRulesFile();
      setRulesContent("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // ── 记忆编辑 / 删除 / 置顶 ──
  const openEdit = (m: MemoryView) => {
    setEditTarget(m);
    setEditContent(m.content);
    setEditCategory(m.category ?? "");
    setEditError("");
  };

  const saveEdit = async () => {
    if (!editTarget) return;
    setEditSaving(true);
    setEditError("");
    try {
      const res = await window.piDesk.updateMemory(
        editTarget.id,
        editContent,
        editCategory || null,
      );
      if (!res.success) {
        setEditError(res.error ?? "保存失败");
      } else {
        setEditTarget(null);
        await loadMemories();
      }
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err));
    }
    setEditSaving(false);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await window.piDesk.deleteMemory(deleteTarget.id);
      setDeleteTarget(null);
      await loadMemories();
    } catch (err) {
      setMemError(err instanceof Error ? err.message : String(err));
      setDeleteTarget(null);
    }
  };

  const togglePin = async (m: MemoryView) => {
    try {
      await window.piDesk.setMemoryPinned(m.id, !m.pinned);
      await loadMemories();
    } catch (err) {
      setMemError(err instanceof Error ? err.message : String(err));
    }
  };

  /** 忽略词法冲突标记（仅清除角标，两条记忆都保留）。 */
  const dismissConflict = async (m: MemoryView) => {
    try {
      await window.piDesk.resolveMemoryConflict(m.id);
      await loadMemories();
    } catch (err) {
      setMemError(err instanceof Error ? err.message : String(err));
    }
  };

  /** 回溯记忆的原始会话（episodic）。 */
  const openEpisodic = async (m: MemoryView) => {
    setEpiTarget(m);
    setEpiData(null);
    setEpiError("");
    setEpiLoading(true);
    try {
      setEpiData(await window.piDesk.getMemoryEpisodic(m.id, 40));
    } catch (err) {
      setEpiError(err instanceof Error ? err.message : String(err));
    }
    setEpiLoading(false);
  };

  const createSnapshot = async () => {
    setSnapBusy(true);
    try {
      await window.piDesk.memorySnapshotNow();
      await loadSnapshots();
    } catch (err) {
      setMemError(err instanceof Error ? err.message : String(err));
    }
    setSnapBusy(false);
  };

  const onMemSearch = (e: ChangeEvent<HTMLInputElement>) => {
    setMemQuery(e.target.value);
  };

  // ── 记忆功能配置 ──
  const loadMemoryConfig = useCallback(async () => {
    try {
      setMcfg(await window.piDesk.getMemoryConfig());
    } catch (err) {
      setCfgError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadMemoryConfig();
  }, [loadMemoryConfig]);

  /** Save a partial config patch and surface hot-reload status. */
  const saveCfg = async (patch: MemoryConfigPatch) => {
    setCfgSaving(true);
    setCfgError("");
    setCfgMsg("");
    try {
      const res = await window.piDesk.saveMemoryConfig(patch);
      setMcfg(res.view);
      setCfgMsg(
        res.hotReloaded
          ? "已保存并热重载生效"
          : "已保存（agent 未运行，重启后生效）",
      );
      setTimeout(() => setCfgMsg(""), 2500);
    } catch (err) {
      setCfgError(err instanceof Error ? err.message : String(err));
    }
    setCfgSaving(false);
  };

  /** Toggle a top-level boolean knob. */
  const flipCfg = (key: keyof MemoryConfigView) => {
    if (!mcfg) return;
    const value = !(mcfg[key] as boolean);
    setMcfg({ ...mcfg, [key]: value } as MemoryConfigView);
    void saveCfg({ [key]: value } as MemoryConfigPatch);
  };

  /** Commit a numeric knob from an input's value. */
  const setCfgNumber = (patch: MemoryConfigPatch, next: Partial<MemoryConfigView>) => {
    if (mcfg) setMcfg({ ...mcfg, ...next });
    void saveCfg(patch);
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

      {/* ── 记忆库（可编辑浏览面板）── */}
      <section className={styles.section}>
        <div className={switchStyles.sectionHeader}>
          <h2 className={styles.sectionTitle}>记忆库</h2>
          <button
            type="button"
            className={switchStyles.iconBtn}
            onClick={loadMemories}
            title="刷新"
          >
            <RefreshCw size={14} />
          </button>
        </div>
        <p className={styles.sectionDesc}>
          置顶的记忆会作为「锚点」在每轮对话注入上下文、并在上下文压缩时保留，不会被遗忘。
          「引用 N」是被检索/召回的次数，次数攒够阈值后会自动升级为锚点。
        </p>
        <div className={switchStyles.card}>
          <div className={switchStyles.cardHeader}>
            <div className={switchStyles.searchWrap}>
              <Search size={13} className={switchStyles.searchIcon} />
              <input
                className={switchStyles.searchInput}
                placeholder="搜索记忆…"
                value={memQuery}
                onChange={onMemSearch}
              />
            </div>
          </div>

          {memLoading ? (
            <div className={switchStyles.ruleEmpty}>加载中…</div>
          ) : memError ? (
            <div className={switchStyles.ruleEmpty}>{memError}</div>
          ) : memories.length === 0 ? (
            <div className={switchStyles.ruleEmpty}>暂无记忆</div>
          ) : (
            <div className={switchStyles.memList}>
              {memories.map((m) => (
                <div key={m.id} className={switchStyles.memItem}>
                  <div className={switchStyles.memMeta}>
                    {m.pinned && (
                      <Star size={12} className={switchStyles.pinned} fill="currentColor" />
                    )}
                    {m.category && (
                      <span className={switchStyles.badge}>{m.category}</span>
                    )}
                    <span
                      className={switchStyles.metaDim}
                      title="被检索/召回的次数，攒够阈值会自动升级为锚点（每轮注入上下文）"
                    >
                      引用 {m.accessCount}
                    </span>
                    <span className={switchStyles.metaDim}>{m.created}</span>
                    {m.conflictStatus === "flagged" && (
                      <span
                        className={switchStyles.conflictBadge}
                        title={
                          m.conflictWith
                            ? `与记忆 #${m.conflictWith} 可能相矛盾，请人工核对后保留其一`
                            : "检测到与既有记忆可能相矛盾，请人工核对"
                        }
                      >
                        <AlertTriangle size={11} /> 冲突
                        {m.conflictWith ? ` #${m.conflictWith}` : ""}
                      </span>
                    )}
                  </div>
                  <div className={switchStyles.memContent}>{m.content}</div>
                  <div className={switchStyles.memActions}>
                    <button
                      type="button"
                      className={switchStyles.memBtn}
                      onClick={() => togglePin(m)}
                      title={
                        m.pinned
                          ? "取消置顶：不再每轮注入上下文"
                          : "置顶：设为锚点，每轮注入上下文且在压缩时保留"
                      }
                    >
                      {m.pinned ? "取消置顶" : "置顶"}
                    </button>
                    <button
                      type="button"
                      className={switchStyles.memBtn}
                      onClick={() => void openEpisodic(m)}
                      title={
                        m.sourceSessionId
                          ? "回溯：查看这条记忆是从哪段对话中沉淀出来的"
                          : "查看原始会话（此条记忆创建较早，可能没有关联会话）"
                      }
                    >
                      <History size={12} /> 回溯
                    </button>
                    {m.conflictStatus === "flagged" && (
                      <button
                        type="button"
                        className={switchStyles.memBtn}
                        onClick={() => void dismissConflict(m)}
                        title="忽略冲突标记（两条记忆都保留）"
                      >
                        忽略冲突
                      </button>
                    )}
                    <button
                      type="button"
                      className={switchStyles.memBtn}
                      onClick={() => openEdit(m)}
                    >
                      <Pencil size={12} /> 编辑
                    </button>
                    <button
                      type="button"
                      className={switchStyles.memBtnDanger}
                      onClick={() => setDeleteTarget(m)}
                    >
                      <Trash2 size={12} /> 删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ── 快照 ── */}
      <section className={styles.section}>
        <div className={switchStyles.sectionHeader}>
          <h2 className={styles.sectionTitle}>记忆库快照</h2>
          <button
            type="button"
            className={switchStyles.createBtn}
            onClick={createSnapshot}
            disabled={snapBusy}
          >
            {snapBusy ? "备份中…" : "立即创建快照"}
          </button>
        </div>
        <div className={switchStyles.card}>
          {snapshots.length === 0 ? (
            <div className={switchStyles.ruleEmpty}>
              暂无快照（每 7 天自动轮转一份）
            </div>
          ) : (
            <div className={switchStyles.snapList}>
              {snapshots.map((s) => (
                <div key={s.name} className={switchStyles.snapRow}>
                  <span className={switchStyles.snapName}>{s.name}</span>
                  <span className={switchStyles.metaDim}>
                    {new Date(s.createdAt).toLocaleString()} ·{" "}
                    {(s.size / 1024).toFixed(0)} KB
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ── 记忆设置（热重载生效）── */}
      <section className={styles.section}>
        <div className={switchStyles.sectionHeader}>
          <h2 className={styles.sectionTitle}>记忆设置</h2>
          <button
            type="button"
            className={switchStyles.iconBtn}
            onClick={loadMemoryConfig}
            title="刷新"
          >
            <RefreshCw size={14} />
          </button>
        </div>

        {mcfg && (
          <>
            {/* 自动沉淀 */}
            <div className={switchStyles.cfgGroupTitle}>自动沉淀（对话结束/压缩前）</div>
            <div className={switchStyles.card}>
              <CfgSwitch
                label="对话结束时沉淀"
                desc="会话关闭前让 LLM 抽取值得记的耐久记忆"
                on={mcfg.flushOnShutdown}
                onClick={() => flipCfg("flushOnShutdown")}
              />
              <div className={switchStyles.cardDivider} />
              <CfgSwitch
                label="上下文压缩前沉淀"
                desc="压缩丢弃上下文前先兜底保存记忆"
                on={mcfg.flushOnCompact}
                onClick={() => flipCfg("flushOnCompact")}
              />
              <div className={switchStyles.cardDivider} />
              <CfgNumber
                label="最少用户轮次"
                desc="对话短于此轮数直接跳过，不调 LLM。0 = 不限制"
                value={mcfg.flushMinTurns}
                min={0}
                onCommit={(v) => setCfgNumber({ flushMinTurns: v }, { flushMinTurns: v })}
              />
              <div className={switchStyles.cardDivider} />
              <CfgNumber
                label="沉淀时回看的消息数"
                desc="0 = 整段对话都看"
                value={mcfg.flushRecentMessages}
                min={0}
                onCommit={(v) =>
                  setCfgNumber({ flushRecentMessages: v }, { flushRecentMessages: v })
                }
              />
            </div>

            {/* 后台复习 */}
            <div className={switchStyles.cfgGroupTitle}>后台复习（周期性提炼）</div>
            <div className={switchStyles.card}>
              <CfgSwitch
                label="启用后台复习"
                desc="周期性回顾近期对话，提炼/合并记忆"
                on={mcfg.reviewEnabled}
                onClick={() => flipCfg("reviewEnabled")}
              />
              <div className={switchStyles.cardDivider} />
              <CfgNumber
                label="复习间隔（用户轮次）"
                desc="每多少轮触发一次复习"
                value={mcfg.nudgeInterval}
                min={1}
                onCommit={(v) => setCfgNumber({ nudgeInterval: v }, { nudgeInterval: v })}
              />
              <div className={switchStyles.cardDivider} />
              <CfgNumber
                label="复习间隔（工具调用数）"
                desc="工具调用累计到此数也触发复习"
                value={mcfg.nudgeToolCalls}
                min={1}
                onCommit={(v) => setCfgNumber({ nudgeToolCalls: v }, { nudgeToolCalls: v })}
              />
              <div className={switchStyles.cardDivider} />
              <CfgNumber
                label="复习时回看的消息数"
                desc="0 = 整段对话都看"
                value={mcfg.reviewRecentMessages}
                min={0}
                onCommit={(v) =>
                  setCfgNumber({ reviewRecentMessages: v }, { reviewRecentMessages: v })
                }
              />
            </div>

            {/* 纠正检测 */}
            <div className={switchStyles.cfgGroupTitle}>纠正检测（实时）</div>
            <div className={switchStyles.card}>
              <CfgSwitch
                label="启用纠正检测"
                desc="检测到用户纠错/工具报错时当场沉淀教训"
                on={mcfg.correctionDetection}
                onClick={() => flipCfg("correctionDetection")}
              />
            </div>

            {/* 时间衰减 */}
            <div className={switchStyles.cfgGroupTitle}>时间衰减 / 强化（排序）</div>
            <div className={switchStyles.card}>
              <CfgSwitch
                label="启用综合排序"
                desc="关闭后退回纯关键词匹配（衰减公式不参与排序）"
                on={mcfg.rankingEnabled}
                onClick={() => flipCfg("rankingEnabled")}
              />
              <div className={switchStyles.cardDivider} />
              <CfgNumber
                label="半衰期（天）"
                desc="未被引用的记忆多少天后降到半权重"
                value={mcfg.halfLifeDays}
                min={1}
                onCommit={(v) =>
                  setCfgNumber(
                    { ranking: { halfLifeDays: v } },
                    { halfLifeDays: v },
                  )
                }
              />
              <div className={switchStyles.cardDivider} />
              <CfgNumber
                label="强化系数"
                desc="越大，被反复引用的记忆衰减越慢"
                value={mcfg.reinforcementFactor}
                min={0}
                step={0.1}
                onCommit={(v) =>
                  setCfgNumber(
                    { ranking: { reinforcementFactor: v } },
                    { reinforcementFactor: v },
                  )
                }
              />
              <div className={switchStyles.cardDivider} />
              <CfgNumber
                label="新记忆初始引用次数"
                desc="新写入记忆的初始强化分。设为 0 会退回旧行为：除非被主动检索，否则永远涨不到锚点阈值"
                value={mcfg.initialAccessCount}
                min={0}
                onCommit={(v) =>
                  setCfgNumber(
                    { ranking: { initialAccessCount: v } },
                    { initialAccessCount: v },
                  )
                }
              />
              <div className={switchStyles.cardDivider} />
              <CfgNumber
                label="新记忆衰减宽限（天）"
                desc="创建后多少天内按满权重参与排序，避免刚写入的记忆被年龄直接埋掉"
                value={mcfg.decayGraceDays}
                min={0}
                onCommit={(v) =>
                  setCfgNumber(
                    { ranking: { decayGraceDays: v } },
                    { decayGraceDays: v },
                  )
                }
              />
            </div>

            {/* 失败教训（两种模式都注入）*/}
            <div className={switchStyles.cfgGroupTitle}>失败教训（无条件注入）</div>
            <div className={switchStyles.card}>
              <CfgSwitch
                label="注入最近的失败教训"
                desc="把最近踩过的坑直接写进系统提示词。这条通道不受 memoryMode 影响 —— 教训必须「不请自来」，等模型主动检索就已经晚了"
                on={mcfg.failureInjectionEnabled}
                onClick={() => flipCfg("failureInjectionEnabled")}
              />
              <div className={switchStyles.cardDivider} />
              <CfgNumber
                label="只取最近多少天内"
                desc="超过这个天数的失败教训不再注入（默认 7 天）"
                value={mcfg.failureInjectionMaxAgeDays}
                min={0}
                onCommit={(v) =>
                  setCfgNumber(
                    { failureInjection: { maxAgeDays: v } },
                    { failureInjectionMaxAgeDays: v },
                  )
                }
              />
              <div className={switchStyles.cardDivider} />
              <CfgNumber
                label="最多注入几条"
                desc="每轮的条数上限，取最近写入的 N 条（默认 5，设为 0 等于关闭）"
                value={mcfg.failureInjectionMaxEntries}
                min={0}
                onCommit={(v) =>
                  setCfgNumber(
                    { failureInjection: { maxEntries: v } },
                    { failureInjectionMaxEntries: v },
                  )
                }
              />
            </div>

            {/* 记忆锚点 */}
            <div className={switchStyles.cfgGroupTitle}>记忆锚点（高频注入）</div>
            <div className={switchStyles.card}>
              <CfgSwitch
                label="启用锚点注入"
                desc="把置顶/高频记忆作为锚点，每轮注入上下文（面板手工置顶的优先）"
                on={mcfg.anchorsEnabled}
                onClick={() => flipCfg("anchorsEnabled")}
              />
              <div className={switchStyles.cardDivider} />
              <CfgNumber
                label="成为锚点的最小引用次数"
                desc="引用次数达到此值，压缩前自动升级为锚点（等于面板的置顶）"
                value={mcfg.minAccessCount}
                min={1}
                onCommit={(v) =>
                  setCfgNumber({ anchors: { minAccessCount: v } }, { minAccessCount: v })
                }
              />
              <div className={switchStyles.cardDivider} />
              <CfgNumber
                label="最多锚点数"
                desc="每轮最多注入几条锚点记忆"
                value={mcfg.maxAnchors}
                min={1}
                onCommit={(v) => setCfgNumber({ anchors: { maxAnchors: v } }, { maxAnchors: v })}
              />
            </div>

            {/* 守卫 */}
            <div className={switchStyles.cfgGroupTitle}>内容守卫（写入安检）</div>
            <div className={switchStyles.card}>
              <CfgSwitch
                label="启用守卫"
                desc="拦截凭据/提示注入/编码载荷写入记忆"
                on={mcfg.guardEnabled}
                onClick={() => flipCfg("guardEnabled")}
              />
              <div className={switchStyles.cardDivider} />
              <div className={switchStyles.cardRow}>
                <div className={switchStyles.cardText}>
                  <div className={styles.toggleLabel}>命中处理方式</div>
                  <div className={switchStyles.cardDesc}>
                    拦截（不写入）或仅警告（写入但记日志）
                  </div>
                </div>
                <select
                  className={switchStyles.cfgSelect}
                  value={mcfg.guardSeverity}
                  onChange={(e) =>
                    setCfgNumber(
                      { guard: { severity: e.target.value as "block" | "warn" } },
                      { guardSeverity: e.target.value as "block" | "warn" },
                    )
                  }
                >
                  <option value="block">拦截</option>
                  <option value="warn">仅警告</option>
                </select>
              </div>
            </div>

            {(cfgMsg || cfgError) && (
              <p className={cfgError ? styles.error : switchStyles.savedMsg}>
                {cfgError || cfgMsg}
              </p>
            )}
            {cfgSaving && <p className={switchStyles.metaDim}>保存中…</p>}
          </>
        )}
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
            {error && <p className={styles.error}>{error}</p>}
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

      {/* ── Memory edit modal ── */}
      {editTarget && (
        <div className={switchStyles.editorOverlay} onClick={() => setEditTarget(null)}>
          <div
            className={switchStyles.editorModal}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={switchStyles.editorHeader}>
              <h3 className={switchStyles.editorTitle}>编辑记忆 #{editTarget.id}</h3>
              <button
                type="button"
                className={switchStyles.iconBtn}
                onClick={() => setEditTarget(null)}
              >
                <X size={14} />
              </button>
            </div>
            <div className={switchStyles.editBody}>
              <select
                className={switchStyles.select}
                value={editCategory}
                onChange={(e) => setEditCategory(e.target.value)}
              >
                <option value="">（无分类）</option>
                {MEMORY_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <textarea
                className={switchStyles.editorTextarea}
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                autoFocus
              />
            </div>
            {editError && <p className={switchStyles.savedError}>{editError}</p>}
            <div className={switchStyles.editorFooter}>
              <button
                type="button"
                className={switchStyles.editorBtnGhost}
                onClick={() => setEditTarget(null)}
              >
                取消
              </button>
              <button
                type="button"
                className={switchStyles.editorBtnPrimary}
                onClick={saveEdit}
                disabled={editSaving}
              >
                {editSaving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Episodic 回溯 modal ── */}
      {epiTarget && (
        <div className={switchStyles.editorOverlay} onClick={() => setEpiTarget(null)}>
          <div
            className={`${switchStyles.editorModal} ${switchStyles.epiModal}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={switchStyles.editorHeader}>
              <h3 className={switchStyles.editorTitle}>回溯记忆 #{epiTarget.id}</h3>
              <button
                type="button"
                className={switchStyles.iconBtn}
                onClick={() => setEpiTarget(null)}
              >
                <X size={14} />
              </button>
            </div>
            <div className={switchStyles.epiBody}>
              <p className={switchStyles.epiMemory}>{epiTarget.content}</p>
              {epiLoading ? (
                <div className={switchStyles.ruleEmpty}>加载中…</div>
              ) : epiError ? (
                <div className={switchStyles.ruleEmpty}>{epiError}</div>
              ) : !epiData?.sessionId ? (
                <div className={switchStyles.ruleEmpty}>
                  这条记忆没有关联会话（创建于 episodic 关联启用之前）。
                </div>
              ) : (
                <>
                  <div className={switchStyles.epiMeta}>
                    <span className={switchStyles.metaDim}>
                      来源会话：{epiData.sessionId}
                    </span>
                    {epiData.sessionCwd && (
                      <span className={switchStyles.metaDim}>{epiData.sessionCwd}</span>
                    )}
                  </div>
                  {epiData.transcriptUnavailable ? (
                    <div className={switchStyles.ruleEmpty}>
                      原始会话记录已不可用（可能已被清理）。
                    </div>
                  ) : (
                    <div className={switchStyles.epiMsgs}>
                      {epiData.messages.map((msg, i) => (
                        <div key={i} className={switchStyles.epiMsg}>
                          <span className={switchStyles.epiRole}>{msg.role}</span>
                          <div className={switchStyles.epiText}>{msg.content}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
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
        onConfirm={confirmDeleteRules}
        onCancel={() => setConfirmDeleteOpen(false)}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        title="删除记忆"
        message="确定删除这条记忆吗？此操作不可撤销。"
        confirmLabel="删除"
        cancelLabel="取消"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
