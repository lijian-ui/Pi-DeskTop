import { memo, useState, useEffect, useRef } from "react";
import { ChevronRight, Check, AlertTriangle, Loader2 } from "lucide-react";
import type { Message } from "../store/agent-store";
import { useTranslation } from "react-i18next";
import Markdown from "./Markdown";
import ToolExecution from "./ToolExecution";
import styles from "./ThinkingTools.module.css";

interface Props {
  /**
   * 同一回合内需要聚合进面板的消息。调用方（AssistantTurn）已把最终回复
   * 消息的 content 置空（其正文由 AssistantTurn 单独渲染），因此面板内
   * 只展示：思考过程、工具调用、中间回复内容。
   */
  messages: Message[];
}

/**
 * 「思考与工具」折叠面板：聚合同一回合内所有中间过程（思考过程、
 * 工具调用、中间回复内容）。
 *
 * 面板默认始终折叠——流式输出期间也不会自动展开，避免过程内容随
 * 每个流式 token 反复跳动，只靠标题行的状态徽标表达进行中/完成；
 * 想实时围观时手动展开查看，展开后保持到手动收起。最终回复正文由
 * AssistantTurn 独立渲染，不受本面板状态影响。
 */
function ThinkingTools({ messages }: Props) {
  const { t } = useTranslation();

  const hasThinking = messages.some((m) => !!m.thinking?.trim());
  const tools = messages.flatMap((m) => m.toolExecutions ?? []);
  const hasTools = tools.length > 0;
  // 中间回复内容 = 除最终正文外其余消息的 content。
  const hasIntermediate = messages.some((m) => !!m.content?.trim());

  // 流式时展开，全部完成后折叠。Hooks 必须先于任何条件返回，
  // 保证 hooks 调用次数稳定（组件可能在同一会话中被复用渲染）。
  const isStreaming = messages.some((m) => m.isStreaming);
  const isToolRunning = tools.some((tool) => tool.isRunning);
  const streamingOrRunning = isStreaming || isToolRunning;
  // 面板默认始终折叠：流式过程中也不自动展开（避免过程内容每 token 跳动），
  // 运行状态只通过标题行徽标表达（运行中 spinner / 完成 ✓ / 出错 ⚠）。
  // 完全由用户手动开合；展开后保持到手动收起，不被状态翻转回退。
  const [expanded, setExpanded] = useState(false);
  // 思考内容默认始终折叠（流式/完成态均折叠），用户手动点开「思考过程」查看。
  // 大段思考不撑爆回复区；与外层面板独立，不受展开/折叠自动同步影响。
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  // peek 是否已收起：回合真正结束后由延时器置 true；新回合 / 段间空隙恢复 false。
  const [peekCollapsed, setPeekCollapsed] = useState(false);

  const turnSettled = !isStreaming && !isToolRunning;
  // 所有 hooks 必须在 early return 之前调用，否则违反 React Rules of Hooks
  // （跨渲染 hooks 顺序不一致会白板）。用 ref 区分「刚结束」与「早已结束」、
  // 区分「回合内部段间空隙」与「回合真正完成」——后者用延时器收起 peek，
  // 前者在空隙结束（turnSettled 翻回 false）时取消收起，避免误收导致跳变。
  const prevSettledRef = useRef(turnSettled);
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (turnSettled && !prevSettledRef.current) {
      // 回合刚结束：收起手动展开的面板；延时收起 peek，留出段间空隙缓冲。
      setExpanded(false);
      setThinkingExpanded(false);
      if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = setTimeout(() => setPeekCollapsed(true), 350);
    } else if (!turnSettled && prevSettledRef.current) {
      // 回合重新开始（段间空隙结束 / 新回合）：取消待收起，允许 peek 重新显示。
      if (collapseTimerRef.current) {
        clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = null;
      }
      setPeekCollapsed(false);
    }
    prevSettledRef.current = turnSettled;
    return () => {
      if (collapseTimerRef.current) {
        clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = null;
      }
    };
  }, [turnSettled]);

  // 没有任何过程性内容 → 不渲染面板。
  if (!hasThinking && !hasTools && !hasIntermediate) return null;

  const anyError = tools.some((tool) => tool.isError);
  const overallStatus = streamingOrRunning ? "running" : anyError ? "error" : "done";

  // 流式思考有界预览（方向 B：2–3 行渐隐 peek）。
  // 关键：预览在**整个多步回合内持续挂载**——只要「仍在流式」或「本回合
  // 已有工具调用」就保持显示，避免工具结束瞬间 isToolRunning 翻 false、
  // streamingOrRunning 随之翻转导致 peek 卸载、下方内容上下跳动。
  // 回合真正结束由上方 effect 的延时器（peekCollapsed）收起回安静行；
  // 段间空隙（turnSettled 瞬间翻 true）因 < 延时会被取消收起，不抖动。
  // 有界预览显示条件：
  //  - 面板未手动展开；
  //  - 存在思考内容；
  //  - 回合进行中（流式 / 工具运行）或本回合出现过工具调用（hasTools 用于桥接
  //    「思考→工具→思考」段间空隙，避免空隙瞬间 turnSettled 翻 true 导致 peek 卸载跳动）；
  //  - 尚未被回合结束的延时器收起（peekCollapsed）。
  const showPeek =
    !expanded && hasThinking && (isStreaming || isToolRunning || hasTools) && !peekCollapsed;
  const peekText = showPeek
    ? [...messages].reverse().find((m) => m.thinking?.trim())?.thinking?.trim() ?? ""
    : "";

  return (
    <div className={styles.panel}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <span className={`${styles.statusIcon} ${styles[overallStatus]}`}>
          {overallStatus === "running" ? (
            <Loader2 size={11} className={styles.spin} />
          ) : anyError ? (
            <AlertTriangle size={11} />
          ) : (
            <Check size={11} />
          )}
        </span>
        <span className={styles.title}>{t("chat.thinkingAndTools")}</span>
        {hasTools && (
          <span className={styles.count}>
            {tools.length} {t("chat.toolsCount")}
          </span>
        )}
        <span className={`${styles.chevron} ${expanded ? styles.chevronOpen : ""}`}>
          <ChevronRight size={12} />
        </span>
      </button>
      {peekText && (
        <div className={styles.thinkingPeek}>
          <div className={styles.thinkingPeekText}>
            <span>{peekText}</span>
          </div>
          <button
            type="button"
            className={styles.peekHint}
            onClick={() => {
              setExpanded(true);
              setThinkingExpanded(true);
            }}
          >
            {t("chat.expandThinking")}
          </button>
        </div>
      )}
      {expanded && (
        <div className={styles.body}>
          {hasThinking && (
            <button
              type="button"
              className={styles.thinkingToggle}
              onClick={() => setThinkingExpanded((e) => !e)}
              aria-expanded={thinkingExpanded}
            >
              <span
                className={`${styles.thinkingToggleChevron} ${
                  thinkingExpanded ? styles.chevronOpen : ""
                }`}
              >
                <ChevronRight size={12} />
              </span>
              <span className={styles.thinkingToggleLabel}>{t("chat.thinking")}</span>
            </button>
          )}
          {messages.map((msg) => {
            const thinking = thinkingExpanded ? msg.thinking?.trim() : "";
            const content = msg.content?.trim();
            const tools = msg.toolExecutions ?? [];
            // 仅当该 step 有可见内容（展开的思考 / 中间回复 / 工具）才渲染，
            // 避免折叠态下留下空的 step 分隔线。
            if (!thinking && !content && tools.length === 0) return null;
            return (
              <div key={msg.id} id={`msg-${msg.id}`} className={styles.step}>
                {!!thinking && (
                  <div className={styles.thinkingContent}>{thinking}</div>
                )}
                {!!content && (
                  <div className={styles.intermediateSection}>
                    <div className={styles.intermediateLabel}>
                      {t("chat.intermediateReply")}
                    </div>
                    <div className={styles.intermediateContent}>
                      <Markdown content={msg.content} />
                    </div>
                  </div>
                )}
                {tools.map((tool) => (
                  <ToolExecution key={tool.id} execution={tool} />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default memo(ThinkingTools);