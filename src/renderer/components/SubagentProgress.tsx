import { useEffect, useMemo, useRef, useState } from "react";
import {
  X,
  GitBranch,
  ArrowRight,
  Check,
  CircleX,
  CornerDownRight,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import {
  useSubagentStore,
  SubagentRunStatus,
  SubagentRun,
  SubagentStep,
} from "../store/subagent-store";
import styles from "./SubagentProgress.module.css";

const STATUS_LABEL: Record<SubagentRunStatus, string> = {
  pending: "等待中",
  running: "运行中",
  done: "完成",
  error: "失败",
  skipped: "已跳过",
};

/** Status pill variant per run — colored text on a shared subtle pill. */
const PILL: Record<SubagentRunStatus, string> = {
  pending: styles.pillPending,
  running: styles.pillRunning,
  done: styles.pillDone,
  error: styles.pillError,
  skipped: styles.pillSkipped,
};

function StepIcon({ step }: { step: SubagentStep }) {
  if (step.isError) return <CircleX size={12} className={styles.iconError} />;
  if (step.kind === "tool_call")
    return <ArrowRight size={12} className={styles.iconTool} />;
  return <Check size={12} className={styles.iconOk} />;
}

/** Longest dependency path to this run → its depth in the DAG. */
function depthOf(
  run: SubagentRun,
  byRunId: Map<string, SubagentRun>,
  seen: Set<string>
): number {
  const deps = run.dependsOn ?? [];
  if (deps.length === 0 || seen.has(run.runId)) return 0;
  seen.add(run.runId);
  let max = 0;
  for (const d of deps) {
    const parent = byRunId.get(d);
    if (parent) max = Math.max(max, depthOf(parent, byRunId, seen) + 1);
  }
  return max;
}

function RunItem({
  r,
  depth,
  parentNames,
}: {
  r: SubagentRun;
  depth: number;
  parentNames: string[];
}) {
  const [collapsed, setCollapsed] = useState(false);
  const hasBody = (parentNames.length > 0) || (r.steps != null && r.steps.length > 0);

  return (
    <div className={styles.run} style={{ marginLeft: depth * 12 }}>
      <div
        className={styles.row}
        title={r.error ? `${r.agent} · ${r.error}` : r.agent}
        onClick={() => hasBody && setCollapsed((c) => !c)}
        role="button"
        aria-expanded={!collapsed}
      >
        {hasBody && (
          <span className={styles.chevron}>
            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </span>
        )}
        <span className={styles.agent}>{r.agent}</span>
        {r.model && (
          <span className={styles.modelChip} title="该子 Agent 使用的模型">
            {r.model}
          </span>
        )}
        <span className={`${styles.pill} ${PILL[r.status]}`}>
          {r.status === "running" && <span className={styles.liveDot} />}
          {r.status === "error" && <span className={styles.errDot} />}
          {STATUS_LABEL[r.status]}
        </span>
      </div>
      {!collapsed && (
        <>
          {parentNames.length > 0 && (
            <div className={styles.depLine}>
              <CornerDownRight size={11} className={styles.depGlyph} />
              <span className={styles.depLabel}>依赖</span>
              {parentNames.map((n) => (
                <span key={n} className={styles.depName}>
                  {n}
                </span>
              ))}
            </div>
          )}
          {r.steps && r.steps.length > 0 && (
            <ul className={styles.steps}>
              {r.steps.map((s, i) => (
                <li
                  key={i}
                  className={`${styles.step} ${s.isError ? styles.stepError : ""}`}
                  title={s.detail ? `${s.tool ?? ""} ${s.detail}` : undefined}
                >
                  <span className={styles.iconWrap}>
                    <StepIcon step={s} />
                  </span>
                  {s.tool && <span className={styles.stepTool}>{s.tool}</span>}
                  {s.label && <span className={styles.stepLabel}>{s.label}</span>}
                  {s.detail && <span className={styles.stepDetail}>{s.detail}</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Right-rail subagent progress block — embedded in the chat right rail (same
 * column family as the Todo panel) instead of a floating overlay. Shows the
 * delegated work as a dependency DAG: each run is a card, indented by its depth
 * and annotated with the parent runs it waits on; status flows
 * pending → running → done/error/skipped. The X hides the current batch.
 */
export default function SubagentProgress() {
  const runs = useSubagentStore((s) => s.runs);
  const dismissed = useSubagentStore((s) => s.dismissed);
  const visible = useMemo(
    () => runs.filter((r) => !dismissed.includes(r.runId)),
    [runs, dismissed]
  );
  const listRef = useRef<HTMLDivElement | null>(null);

  const byRunId = useMemo(
    () => new Map(visible.map((r) => [r.runId, r])),
    [visible]
  );
  // Collapse toggle: collapsed = header only, expanded = fixed-height list.
  const [collapsed, setCollapsed] = useState(false);

  // Only the most recent 6 runs are shown when expanded; older ones are
  // reachable by scrolling the list up. Newest stays at the bottom so the
  // live stream stays in view. Depth/dependency names still resolve against
  // the full set (byRunId) so annotations remain meaningful.
  const recent = useMemo(() => visible.slice(-6), [visible]);
  const recentOrdered = useMemo(
    () => recent.map((r) => ({ r, d: depthOf(r, byRunId, new Set()) })),
    [recent, byRunId]
  );
  const hiddenOlder = visible.length - recent.length;

  // Follow the live stream: keep the newest step in view while entries arrive.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible]);

  if (visible.length === 0) return null;

  const running = visible.filter((r) => r.status === "running").length;
  const pending = visible.filter((r) => r.status === "pending").length;
  const failed = visible.some((r) => r.status === "error");
  const skipped = visible.some((r) => r.status === "skipped");

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <button
          className={styles.iconBtn}
          title={collapsed ? "展开子 Agent 面板" : "收起子 Agent 面板"}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
        <span className={styles.headerIcon}>
          <GitBranch size={14} />
        </span>
        <span className={styles.headerTitle}>子 Agent</span>
        <span className={styles.spacer} />
        {running > 0 ? (
          <span className={`${styles.pill} ${styles.pillRunning}`}>
            <span className={styles.liveDot} />
            {running} 运行中{pending > 0 ? ` · ${pending} 等待` : ""}
          </span>
        ) : failed ? (
          <span className={`${styles.pill} ${styles.pillError}`}>
            <span className={styles.errDot} />
            失败
          </span>
        ) : skipped ? (
          <span className={`${styles.pill} ${styles.pillSkipped}`}>部分跳过</span>
        ) : (
          <span className={`${styles.pill} ${styles.pillDone}`}>
            <Check size={11} />
            完成
          </span>
        )}
        <button
          className={styles.iconBtn}
          title="隐藏子 Agent 面板"
          onClick={() =>
            useSubagentStore
              .getState()
              .dismissRuns(visible.map((r) => r.runId))
          }
        >
          <X size={14} />
        </button>
      </div>
      {!collapsed && (
        <div className={styles.list} ref={listRef}>
          {hiddenOlder > 0 && (
            <div className={styles.moreHint}>
              向上滚动查看更早的 {hiddenOlder} 个子 Agent
            </div>
          )}
          {recentOrdered.map(({ r, d }) => (
            <RunItem
              key={r.runId}
              r={r}
              depth={d}
              parentNames={(r.dependsOn ?? [])
                .map((id) => byRunId.get(id)?.agent)
                .filter((n): n is string => !!n)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
