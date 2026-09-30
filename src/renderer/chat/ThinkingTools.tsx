import { memo, useState, useEffect, useRef } from "react";
import { ChevronRight, Brain } from "lucide-react";
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
 * 单条思考（DSH 风格）：一行 disclosure，形如
 *   `🧠 思考 · <内容>`
 * 默认折叠——内容超出宽度用省略号截断，只显示一行；点击该行展开显示
 * 全部思考内容，再点收起。每条思考各自独立，互不影响。
 */
function ThinkingRow({ text }: { text: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      className={styles.thinkingRow}
      data-open={open ? "true" : undefined}
      onClick={() => setOpen((o) => !o)}
      aria-expanded={open}
      title={open ? undefined : text}
    >
      <Brain size={14} className={styles.thinkingIcon} />
      <span className={styles.thinkingLabel}>{t("chat.thinking")}</span>
      <span className={styles.thinkingSep} aria-hidden="true">
        ·
      </span>
      <span className={styles.thinkingText}>{text}</span>
    </button>
  );
}

/**
 * 「思考与工具」折叠面板：聚合同一回合内所有中间过程（思考过程、
 * 工具调用、中间回复内容）。
 *
 * **顺序**：严格按 message 的时间顺序交错渲染——每条消息内部依次为
 * 「思考 → 中间回复 → 该步的工具调用」，还原真实回合时间线
 * （思考 → 工具 → 思考 → 中间回复 → 工具 → …），不再把思考堆在一起、
 * 工具统一聚合到末尾。
 *
 * **思考样式**：对标 DSH——每段思考是一条独立的一行 disclosure
 * （图标 + 「思考」 + 内容），默认折叠（单行省略号截断），点击展开全文；
 * 不再用一个「思考过程」开关统一控制所有思考。
 *
 * 面板默认始终折叠——流式输出期间也不会自动展开，避免过程内容随
 * 每个流式 token 反复跳动，只靠标题行的状态徽标表达进行中/完成；
 * 想实时围观时手动展开查看。最终回复正文由 AssistantTurn 独立渲染，
 * 不受本面板状态影响。
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
  // 运行状态只通过标题行徽标表达（2px 状态点）。完全由用户手动开合。
  const [expanded, setExpanded] = useState(false);

  const turnSettled = !isStreaming && !isToolRunning;
  // 回合真正结束时，自动收起用户手动展开的面板（回到安静的一行）。
  const prevSettledRef = useRef(turnSettled);
  useEffect(() => {
    if (turnSettled && !prevSettledRef.current) setExpanded(false);
    prevSettledRef.current = turnSettled;
  }, [turnSettled]);

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
        <span className={styles.statusDot} data-state={overallStatus} aria-hidden="true" />
        <span className={styles.srOnly}>
          {overallStatus === "running"
            ? t("chat.statusRunning")
            : anyError
              ? t("chat.statusError")
              : t("chat.statusDone")}
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
      {expanded && (
        <div className={styles.body}>
          {/* 按 message 时间顺序交错渲染：思考 → 中间回复 → 该步工具调用。
              每段思考是一条独立的 DSH 风格 disclosure 行（默认折叠单行省略）。 */}
          {messages.map((msg) => {
            const thinking = msg.thinking?.trim();
            const content = msg.content?.trim();
            const msgTools = msg.toolExecutions ?? [];
            if (!thinking && !content && msgTools.length === 0) return null;
            return (
              <div key={msg.id} id={`msg-${msg.id}`} className={styles.step}>
                {!!thinking && <ThinkingRow text={thinking} />}
                {!!content && (
                  <div className={styles.intermediateSection}>
                    <div className={styles.intermediateContent}>
                      <Markdown content={msg.content} />
                    </div>
                  </div>
                )}
                {msgTools.length > 0 && (
                  <div className={styles.stepTools}>
                    {msgTools.map((tool) => (
                      <ToolExecution key={tool.id} execution={tool} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default memo(ThinkingTools);
