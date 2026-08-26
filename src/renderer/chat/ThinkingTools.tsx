import { memo, useState, useEffect, useRef } from "react";
import { ChevronDown, ChevronRight, Check, AlertTriangle, Loader2 } from "lucide-react";
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
 * 流式输出期间自动展开（过程实时可见）；一旦整回合完成（无流式消息
 * 且无运行中的工具），自动折叠为一行摘要，只保留最终回复正文（由
 * AssistantTurn 独立渲染，点击标题行可手动展开回看）。
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
  const streamingOrRunning =
    messages.some((m) => m.isStreaming) || tools.some((tool) => tool.isRunning);
  // 折叠面板：流式展开、完成折叠（由下方 useEffect 同步活跃态翻转）。
  const [expanded, setExpanded] = useState(streamingOrRunning);
  // 思考内容默认始终折叠（流式/完成态均折叠），用户手动点开「思考过程」查看。
  // 大段思考不撑爆回复区；与外层面板独立，不受展开/折叠自动同步影响。
  const [thinkingExpanded, setThinkingExpanded] = useState(false);

  // 仅在活跃状态翻转时自动同步面板展开/折叠：
  //  - 空闲 → 运行中：自动展开（流式中的思考/工具实时可见）
  //  - 运行中 → 空闲：自动折叠（只保留最终回复正文）
  // 运行期间（或完全空闲后）用户手动开合不回退。
  const prevActiveRef = useRef(streamingOrRunning);
  useEffect(() => {
    const prev = prevActiveRef.current;
    if (streamingOrRunning !== prev) {
      setExpanded(streamingOrRunning);
      prevActiveRef.current = streamingOrRunning;
    }
  }, [streamingOrRunning]);

  // 没有任何过程性内容 → 不渲染面板。
  if (!hasThinking && !hasTools && !hasIntermediate) return null;

  const anyError = tools.some((tool) => tool.isError);
  const overallStatus = streamingOrRunning ? "running" : anyError ? "error" : "done";

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
        <span className={styles.chevron}>
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>
      {expanded && (
        <div className={styles.body}>
          {hasThinking && (
            <button
              type="button"
              className={styles.thinkingToggle}
              onClick={() => setThinkingExpanded((e) => !e)}
              aria-expanded={thinkingExpanded}
            >
              <span className={styles.thinkingToggleChevron}>
                {thinkingExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
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