import { useEffect, useMemo, useRef, useState } from "react";
import { X, GitBranch, ChevronRight, Check, CircleX, Play } from "lucide-react";
import {
  useSubagentStore,
  SubagentRun,
  SubagentRunStatus,
  SubagentStep,
} from "../store/subagent-store";
import { useSessionStore } from "../store/session-store";
import styles from "./SubagentProgress.module.css";

const STATUS_LABEL: Record<SubagentRunStatus, string> = {
  pending: "未开始",
  running: "运行中",
  done: "已完成",
  error: "失败",
  skipped: "已跳过",
};

/* ── 小工具（演示页口径移植） ───────────────────────────────────── */

function stableHash(v: string): number {
  let h = 0;
  for (let i = 0; i < v.length; i += 1) h = ((h << 5) - h + v.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** 头像五色：仓库既有语义色（蓝/绿/橙/紫/浅蓝），token 驱动、双主题可用。 */
const AVATAR_COLORS = [
  "var(--status-primary-default)",
  "var(--status-success-default)",
  "var(--status-warning-default)",
  "var(--code-action)",
  "var(--code-constant)",
];

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function fmtCost(c: number): string {
  if (c <= 0) return "$0";
  return c < 0.01 ? `$${c.toFixed(3)}` : `$${c.toFixed(2)}`;
}

/** 模型短名：只留型号段（全名放 title），先保住 agent 名的显示宽度。 */
function shortModel(m: string): string {
  return m.slice(m.lastIndexOf("/") + 1).replace(/^claude-/i, "");
}

/** 被会话停止级联中止的 run（runner 固定文案「已被用户停止」）。 */
function isCancelled(r: SubagentRun): boolean {
  return r.status === "error" && (r.error ?? "").includes("已被用户停止");
}

/* ── DAG 图派生计算 ─────────────────────────────────────────────── */

type RunMap = Map<string, SubagentRun>;

/** 到该 run 的最长依赖路径深度（未知依赖忽略）。 */
function depthOf(id: string, byId: RunMap, seen: Set<string> = new Set()): number {
  const deps = (byId.get(id)?.dependsOn ?? []).filter((d) => byId.has(d));
  if (deps.length === 0 || seen.has(id)) return 0;
  seen.add(id);
  let max = 0;
  for (const d of deps) max = Math.max(max, depthOf(d, byId, seen) + 1);
  return max;
}

/** 上游祖先 ∪ 下游后代（含自身）——hover/pin 的“全链高亮”集合。 */
function relatedIds(id: string, byId: RunMap): Set<string> {
  const out = new Set<string>([id]);
  const walkUp = (cur: string) => {
    for (const d of byId.get(cur)?.dependsOn ?? []) {
      if (!byId.has(d) || out.has(d)) continue;
      out.add(d);
      walkUp(d);
    }
  };
  walkUp(id);
  const expandDown = (cur: string) => {
    for (const r of byId.values()) {
      if (out.has(r.runId) || !(r.dependsOn ?? []).includes(cur)) continue;
      out.add(r.runId);
      expandDown(r.runId);
    }
  };
  expandDown(id);
  return out;
}

/** 未满足的前置依赖（未知依赖视为已满足；已 dismiss 的不算等待对象）。 */
function unmetDeps(r: SubagentRun, byId: RunMap): SubagentRun[] {
  return (r.dependsOn ?? [])
    .map((d) => byId.get(d))
    .filter((d): d is SubagentRun => !!d && d.status !== "done");
}

/** 因哪个上游失败/跳过而被级联跳过（渲染端派生，事件里不带）。 */
function skippedByOf(r: SubagentRun, byId: RunMap): string {
  const culprit = (r.dependsOn ?? [])
    .map((d) => byId.get(d))
    .find((d) => d && (d.status === "error" || d.status === "skipped"));
  return culprit?.agent ?? "上游任务";
}

function elapsedOf(r: SubagentRun, now: number): number | null {
  if (typeof r.stats?.elapsedMs === "number") return r.stats.elapsedMs;
  if (r.startedAt == null) return null;
  const end = r.status === "running" ? now : r.endedAt;
  return end == null ? null : Math.max(0, end - r.startedAt);
}

/* ── 一句汇总（演示页 summarize 口径移植） ───────────────────────── */

type Tone = "run" | "ok" | "err" | "warn" | "idle";

function summarize(runs: SubagentRun[], byId: RunMap): { tone: Tone; text: string } {
  const names = (st: SubagentRunStatus) =>
    runs.filter((r) => r.status === st).map((r) => r.agent);
  const c: Record<SubagentRunStatus, number> = {
    pending: 0,
    running: 0,
    done: 0,
    error: 0,
    skipped: 0,
  };
  runs.forEach((r) => (c[r.status] += 1));
  const cancelled = runs.filter(isCancelled).length;
  const failed = c.error - cancelled;

  if (c.running + c.pending === 0) {
    const parts: string[] = [];
    if (c.done) parts.push(`${c.done} 完成`);
    if (failed) parts.push(`${failed} 失败`);
    if (c.skipped) parts.push(`${c.skipped} 因级联跳过`);
    if (cancelled) parts.push(`${cancelled} 已取消`);
    return {
      tone: failed || cancelled ? "err" : "ok",
      text: `本轮结束 · ${parts.join(" · ") || "无任务"}`,
    };
  }
  const parts: string[] = [];
  const run = names("running");
  if (run.length) parts.push(`${run.join("、")} 正在执行`);
  const pend = runs.filter((r) => r.status === "pending");
  const wait = pend.filter((r) => unmetDeps(r, byId).length > 0).map((r) => r.agent);
  const ready = pend.filter((r) => unmetDeps(r, byId).length === 0).map((r) => r.agent);
  if (wait.length) parts.push(`${wait.join("、")} 等待上游`);
  if (ready.length) parts.push(`${ready.join("、")} 等待调度`);
  const errNames = runs.filter((r) => r.status === "error" && !isCancelled(r)).map((r) => r.agent);
  if (errNames.length) parts.push(`${errNames.join("、")} 失败`);
  const done = names("done");
  if (done.length) {
    const groups = new Map<string, number>();
    done.forEach((id) => {
      const base = id.replace(/-[a-z]$/i, "");
      groups.set(base, (groups.get(base) ?? 0) + 1);
    });
    parts.push(
      `${[...groups].map(([g, n]) => (n > 1 ? `${g}×${n}` : g)).join("、")} 已完成`
    );
  }
  if (c.skipped) parts.push(`${c.skipped} 项已跳过`);
  return { tone: failed ? "err" : c.running ? "run" : "warn", text: parts.join("；") };
}

/* ── DAG 布局（演示页同款：depth 分列 + 贝塞尔） ─────────────────── */

const DW = 84;
const DH = 26;
const GAPX = 30;
const GAPY = 12;

interface DagLayout {
  pos: Map<string, { x: number; y: number }>;
  edges: { from: string; to: string; d: string }[];
  width: number;
  height: number;
}

function dagLayout(runs: SubagentRun[], byId: RunMap): DagLayout | null {
  if (runs.length === 0) return null;
  const cols: string[][] = [];
  runs.forEach((r) => {
    const d = depthOf(r.runId, byId);
    (cols[d] = cols[d] ?? []).push(r.runId);
  });
  const rows = Math.max(...cols.map((c) => c.length));
  const height = rows * DH + (rows - 1) * GAPY;
  const pos = new Map<string, { x: number; y: number }>();
  cols.forEach((col, ci) => {
    const off = (height - (col.length * DH + (col.length - 1) * GAPY)) / 2;
    col.forEach((id, ri) => pos.set(id, { x: ci * (DW + GAPX), y: off + ri * (DH + GAPY) }));
  });
  const edges: DagLayout["edges"] = [];
  runs.forEach((r) => {
    (r.dependsOn ?? []).forEach((d) => {
      const a = pos.get(d);
      const b = pos.get(r.runId);
      if (!a || !b) return;
      const x1 = a.x + DW;
      const y1 = a.y + DH / 2;
      const x2 = b.x;
      const y2 = b.y + DH / 2;
      edges.push({ from: d, to: r.runId, d: `M${x1} ${y1}C${x1 + 14} ${y1},${x2 - 14} ${y2},${x2} ${y2}` });
    });
  });
  return { pos, edges, width: cols.length * DW + (cols.length - 1) * GAPX, height };
}

/* ── 子组件：一句话状态（演示页 statusLine 五口径移植） ───────────── */

function StatusLine({ r, byId }: { r: SubagentRun; byId: RunMap }) {
  if (r.status === "pending") {
    const unmet = unmetDeps(r, byId);
    if (unmet.length === 0)
      return (
        <span className={styles.msg} data-tone="idle">
          已就绪 · <b>等待调度</b>
        </span>
      );
    return (
      <span className={styles.msg} data-tone="idle">
        等待 <b>{unmet.map((d) => d.agent).join("</b>、<b>")}</b> · 等待前置
      </span>
    );
  }
  if (r.status === "running") {
    const last = r.steps?.[r.steps.length - 1];
    return (
      <span className={styles.msg} data-tone="run">
        正在执行
        {last && (
          <code className={styles.msgCode}>
            {(last.tool ?? "step") + (last.label ? ` ${last.label}` : "")}
          </code>
        )}
      </span>
    );
  }
  if (r.status === "done") {
    const s = r.stats;
    const tokens =
      s && [s.input, s.output, s.cacheRead, s.cacheWrite].some((n) => typeof n === "number")
        ? (s.input ?? 0) + (s.output ?? 0) + (s.cacheRead ?? 0) + (s.cacheWrite ?? 0)
        : null;
    return (
      <span className={styles.msg} data-tone="ok">
        已完成 · {(r.steps?.length ?? 0) + " 步"}
        {tokens != null && ` · ${fmtTokens(tokens)} tok`}
        {typeof s?.cost === "number" && ` · ${fmtCost(s.cost)}`}
      </span>
    );
  }
  if (isCancelled(r))
    return (
      <span className={styles.msg} data-tone="idle">
        已取消 · <b>由会话停止级联中止</b>
      </span>
    );
  if (r.status === "error")
    return (
      <span className={styles.msg} data-tone="err" title={r.error}>
        失败 · {r.error ?? "未知错误"}
      </span>
    );
  return (
    <span className={styles.msg} data-tone="idle">
      因上游 <b>{skippedByOf(r, byId)}</b> 失败而跳过
    </span>
  );
}

/* ── 子组件：step 流（贴底跟随） ─────────────────────────────────── */

function StepRow({ step, latest }: { step: SubagentStep; latest: boolean }) {
  return (
    <li
      className={styles.step}
      data-ok={step.kind === "tool_result" && !step.isError ? "1" : undefined}
      data-err={step.isError ? "1" : undefined}
      data-latest={latest ? "1" : undefined}
      title={step.detail ? `${step.tool ?? ""} ${step.detail}` : undefined}
    >
      <span className={styles.stepMark}>
        {step.kind === "tool_result" ? (
          step.isError ? (
            <CircleX size={10} />
          ) : (
            <Check size={10} />
          )
        ) : (
          <Play size={9} fill="currentColor" strokeWidth={0} />
        )}
      </span>
      {step.tool && <span className={styles.stepTool}>{step.tool}</span>}
      {step.label && <span className={styles.stepLabel}>{step.label}</span>}
      {step.detail && <span className={styles.stepDetail}>{step.detail}</span>}
    </li>
  );
}

/* ── 子组件：run 卡 ─────────────────────────────────────────────── */

function RunCard({
  r,
  byId,
  dim,
  open,
  onToggle,
  now,
}: {
  r: SubagentRun;
  byId: RunMap;
  dim: boolean;
  open: boolean;
  onToggle: () => void;
  now: number;
}) {
  const steps = r.steps ?? [];
  const hasSteps = steps.length > 0;
  const el = elapsedOf(r, now);
  const boxRef = useRef<HTMLDivElement | null>(null);
  // 贴底跟随：仅当用户本来贴着底（或刚展开）时，新 step 到达才滚到底部。
  const stickRef = useRef(true);

  const onScroll = () => {
    const b = boxRef.current;
    if (b) stickRef.current = b.scrollTop + b.clientHeight >= b.scrollHeight - 4;
  };
  useEffect(() => {
    const b = boxRef.current;
    if (b && open && stickRef.current) b.scrollTop = b.scrollHeight;
  }, [open, steps.length]);

  return (
    <article
      className={styles.card}
      data-s={r.status}
      data-open={open && hasSteps ? "1" : undefined}
      data-dim={dim ? "1" : undefined}
      title={r.task ?? r.agent}
    >
      <div
        className={styles.cardRow1}
        onClick={() => hasSteps && onToggle()}
        role={hasSteps ? "button" : undefined}
        aria-expanded={hasSteps ? open : undefined}
      >
        <span
          className={styles.avatar}
          style={{ background: AVATAR_COLORS[stableHash(r.agent) % AVATAR_COLORS.length] }}
        >
          {r.agent.slice(0, 1).toUpperCase()}
        </span>
        <span className={styles.name}>{r.agent}</span>
        {r.model && (
          <span className={styles.modelChip} title={r.model}>
            {shortModel(r.model)}
          </span>
        )}
        <span className={styles.pill} data-s={r.status}>
          {r.status === "running" && <span className={styles.pillDot} />}
          {STATUS_LABEL[r.status]}
        </span>
        <span className={styles.cardRight}>
          <span className={styles.stepsCount}>{steps.length} 步</span>
          <span className={styles.elapsed}>{el === null ? "--:--" : fmtClock(el)}</span>
          {hasSteps && (
            <span className={styles.toggle}>
              <ChevronRight size={11} />
            </span>
          )}
        </span>
      </div>
      <div className={styles.cardRow2}>
        <StatusLine r={r} byId={byId} />
      </div>
      {hasSteps && (
        <div className={styles.steps} ref={boxRef} onScroll={onScroll}>
          <ol className={styles.stepList}>
            {steps.map((s, i) => (
              <StepRow
                key={i}
                step={s}
                latest={i === steps.length - 1 && r.status === "running"}
              />
            ))}
          </ol>
        </div>
      )}
    </article>
  );
}

/* ── 面板主体（右栏，ChatPanel rightRail 原位） ──────────────────── */

/**
 * 子 Agent 运行面板 —— 头部图例计数、段条总览、depth 分列 DAG（hover 高亮
 * 全链 / 点击 pin / Esc 取消）、run 卡（一句话状态 + step 流贴底跟随）。
 * 只渲染当前会话的 run（sessionPath 过滤，缺省放行）；终态保留到切会话
 * 或手动 X，done 默认折叠。面板不做停止/重试：停止走会话停止既有链路，
 * 会级联 abort 子会话（子会话 inMemory，无 transcript 可跳）。
 */
export default function SubagentProgress() {
  const runs = useSubagentStore((s) => s.runs);
  const dismissed = useSubagentStore((s) => s.dismissed);
  const currentPath = useSessionStore((s) => s.currentPath);

  const visible = useMemo(
    () =>
      runs.filter(
        (r) =>
          !dismissed.includes(r.runId) &&
          (!r.sessionPath || r.sessionPath === currentPath)
      ),
    [runs, dismissed, currentPath]
  );

  // 切会话：离开会话的终态卡片在这里清掉（运行中的留在 store，回来可见）。
  const prevPathRef = useRef(currentPath);
  useEffect(() => {
    const prev = prevPathRef.current;
    prevPathRef.current = currentPath;
    if (prev && prev !== currentPath) useSubagentStore.getState().cleanupSession(prev);
  }, [currentPath]);

  const byId = useMemo(() => new Map(visible.map((r) => [r.runId, r])), [visible]);

  const [hover, setHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focus = pinned ?? hover;

  // 180ms 驻留才响应 hover，避免划过整排节点时的闪烁。
  const scheduleHover = (id: string | null) => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    if (id === null) {
      setHover(null);
      return;
    }
    if (hover === id) return;
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      setHover(id);
    }, 180);
  };
  useEffect(
    () => () => {
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    },
    []
  );

  // pin 的 run 被隐藏/清理后自动解除聚焦。
  useEffect(() => {
    if (pinned && !byId.has(pinned)) setPinned(null);
  }, [pinned, byId]);

  // Esc 取消 pin + hover。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setHover(null);
      setPinned(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const counts = useMemo(() => {
    const c: Record<SubagentRunStatus, number> = {
      pending: 0,
      running: 0,
      done: 0,
      error: 0,
      skipped: 0,
    };
    visible.forEach((r) => (c[r.status] += 1));
    return c;
  }, [visible]);

  // running 走表：每秒滴答刷新耗时。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (counts.running === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [counts.running]);

  const layout = useMemo(() => dagLayout(visible, byId), [visible, byId]);
  const rel = useMemo(() => (focus ? relatedIds(focus, byId) : null), [focus, byId]);
  const sum = useMemo(() => summarize(visible, byId), [visible, byId]);

  const [showDone, setShowDone] = useState(false);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggleCard = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const togglePin = (id: string) => setPinned((p) => (p === id ? null : id));

  if (visible.length === 0) return null;

  const activeList = visible.filter((r) => r.status !== "done");
  const doneList = visible
    .filter((r) => r.status === "done")
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));

  const LEGEND: [SubagentRunStatus, string, number][] = [
    ["running", "●", counts.running],
    ["pending", "○", counts.pending],
    ["done", "✓", counts.done],
    ["error", "✕", counts.error],
    ["skipped", "▨", counts.skipped],
  ];
  const LEGEND_LABEL: Record<string, string> = {
    running: "运行",
    pending: "等待",
    done: "完成",
    error: "失败",
    skipped: "跳过",
  };

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.headerIcon}>
          <GitBranch size={13} />
        </span>
        <span className={styles.headerTitle}>子 Agent</span>
        <div className={styles.legend}>
          {LEGEND.map(([k, glyph, n]) => (
            <span key={k} data-k={k} data-zero={n === 0 ? "1" : undefined}>
              <i>{glyph}</i>
              {n} {LEGEND_LABEL[k]}
            </span>
          ))}
        </div>
        <button
          className={styles.iconBtn}
          title="隐藏子 Agent 面板（停止运行请点会话停止按钮，会级联中止子 Agent）"
          onClick={() =>
            useSubagentStore
              .getState()
              .dismissRuns(visible.map((r) => r.runId))
          }
        >
          <X size={13} />
        </button>
      </div>

      <div className={styles.ov}>
        <div className={styles.segs}>
          {visible.map((r) => (
            <b
              key={r.runId}
              data-s={r.status}
              data-focus={focus === r.runId ? "1" : undefined}
              title={`${r.agent} · ${STATUS_LABEL[r.status]}`}
              onClick={() => togglePin(r.runId)}
            />
          ))}
        </div>
        <div className={styles.sum} data-tone={sum.tone}>
          <i />
          <span className={styles.sumText}>{sum.text}</span>
          {focus && byId.has(focus) && (
            <span className={styles.sumFocus}>
              · 聚焦 {byId.get(focus)!.agent}
              {pinned ? "（已固定）" : ""}
            </span>
          )}
        </div>
      </div>

      {layout && layout.pos.size > 0 && (
        <div className={styles.dag}>
          <svg
            className={styles.dagSvg}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            style={{ maxWidth: layout.width }}
            role="img"
            aria-label="子 Agent 依赖图"
            onMouseLeave={() => scheduleHover(null)}
          >
            {layout.edges.map((e) => {
              const active = rel !== null && rel.has(e.from) && rel.has(e.to);
              return (
                <path
                  key={`${e.from}->${e.to}`}
                  className={styles.dagEdge}
                  d={e.d}
                  data-active={active ? "1" : undefined}
                  data-dim={rel !== null && !active ? "1" : undefined}
                />
              );
            })}
            {visible.map((r) => {
              const p = layout.pos.get(r.runId);
              if (!p) return null;
              return (
                <g
                  key={r.runId}
                  className={styles.dagNode}
                  data-s={r.status}
                  data-dim={rel !== null && !rel.has(r.runId) ? "1" : undefined}
                  data-pinned={pinned === r.runId ? "1" : undefined}
                  data-focus={focus === r.runId ? "1" : undefined}
                  transform={`translate(${p.x},${p.y})`}
                  tabIndex={0}
                  role="button"
                  aria-label={`${r.agent} · ${STATUS_LABEL[r.status]}`}
                  onMouseEnter={() => scheduleHover(r.runId)}
                  onClick={() => togglePin(r.runId)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") {
                      ev.preventDefault();
                      togglePin(r.runId);
                    }
                  }}
                >
                  <title>{`${r.agent} · ${STATUS_LABEL[r.status]}`}</title>
                  <rect width={DW} height={DH} rx={13} />
                  <circle className={styles.dagDot} data-s={r.status} cx={12} cy={DH / 2} r={3.2} />
                  <text x={21} y={DH / 2 + 0.5}>
                    {r.agent.length > 10 ? `${r.agent.slice(0, 9)}…` : r.agent}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}

      <div className={styles.cards}>
        {activeList.length > 0 ? (
          activeList.map((r) => (
            <RunCard
              key={r.runId}
              r={r}
              byId={byId}
              dim={rel !== null && !rel.has(r.runId)}
              open={open.has(r.runId)}
              onToggle={() => toggleCard(r.runId)}
              now={now}
            />
          ))
        ) : (
          <p className={styles.empty}>当前没有未结束的任务</p>
        )}
        {doneList.length > 0 && (
          <>
            <button
              className={styles.doneToggle}
              data-open={showDone ? "1" : undefined}
              onClick={() => setShowDone((v) => !v)}
            >
              <ChevronRight size={10} />
              {showDone ? "收起已完成（" : "展开已完成（"}
              {doneList.length}）
            </button>
            {showDone &&
              doneList.map((r) => (
                <RunCard
                  key={r.runId}
                  r={r}
                  byId={byId}
                  dim={rel !== null && !rel.has(r.runId)}
                  open={open.has(r.runId)}
                  onToggle={() => toggleCard(r.runId)}
                  now={now}
                />
              ))}
          </>
        )}
      </div>

      {counts.running > 0 && (
        <div className={styles.stopHint}>
          要中止运行中的子 Agent，请点会话停止按钮（会级联中止，已完成结果保留）
        </div>
      )}
    </div>
  );
}
