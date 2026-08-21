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
  const [expanded, setExpanded] = useState(streamingOrRunning);

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
          {messages.map((msg) => (
            <div key={msg.id} id={`msg-${msg.id}`} className={styles.step}>
              {!!msg.thinking?.trim() && (
                <div className={styles.thinkingContent}>{msg.thinking}</div>
              )}
              {!!msg.content?.trim() && (
                <div className={styles.intermediateSection}>
                  <div className={styles.intermediateLabel}>
                    {t("chat.intermediateReply")}
                  </div>
                  <div className={styles.intermediateContent}>
                    <Markdown content={msg.content} />
                  </div>
                </div>
              )}
              {(msg.toolExecutions ?? []).map((tool) => (
                <ToolExecution key={tool.id} execution={tool} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default memo(ThinkingTools);