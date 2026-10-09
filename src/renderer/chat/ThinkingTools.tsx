import { memo, useState } from "react";
import { ChevronRight, Brain } from "lucide-react";
import type { Message, ToolExecution as ToolExecutionData } from "../store/agent-store";
import { useTranslation } from "react-i18next";
import Markdown from "./Markdown";
import ToolExecution from "./ToolExecution";
import { summarizeArgs } from "./tool-args";
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
 * 折叠标题行的「实时尾巴」：单行展示此刻正在发生的事，随流式滚动。
 *
 * 取值优先级（与面板内的过程时间线同源，只是只取"最新一条"）：
 *  1. 有工具正在执行 → `工具名 · 参数摘要`
 *  2. 某条消息正在写思考（流式中且还没进正文）→ 该段思考的**最后一行**
 *     （最新写出来的部分，而不是开头——开头早就划过去了，滚动感来自尾部）
 *  3. 最近一个**已跑完**的工具 → 同 1 的格式。这一档是必须的：工具执行往往
 *     只有几百毫秒，若只在 isRunning 时显示，工具行会一闪而过、基本看不见。
 *     粘住它，直到被下一段思考或下一个工具顶掉，整行才是连续滚动的。
 *  4. 都没有 → 空串（回合已结束、或模型正在写正文且本轮还没跑过工具）
 *
 * 注意：这是"折叠态专属"的即时摘要，不是过程记录——回合结束即清空。
 */
function toolLine(tool: ToolExecutionData): string {
  const args = summarizeArgs(tool.toolName, tool.input);
  return args ? `${tool.toolName} · ${args}` : tool.toolName;
}

/** 思考文本的"最新一行"——流式时新内容总在尾部。 */
function tailLine(thinking: string | undefined): string {
  const text = thinking?.trim();
  if (!text) return "";
  const lines = text.split("\n").filter((l) => l.trim());
  return lines[lines.length - 1]?.trim() ?? "";
}

function liveStageText(messages: Message[], settled: boolean): string {
  if (settled) return "";
  const tools = messages.flatMap((m) => m.toolExecutions ?? []);

  // 1. 正在执行的工具
  for (let i = tools.length - 1; i >= 0; i--) {
    if (tools[i].isRunning) return toolLine(tools[i]);
  }

  // 2. 正在写的思考（消息还在流式、且尚未进入正文阶段）。否则已写完的思考
  //    会滞留在这里，正文流式时标题行会挂着一段旧内容。
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg.isStreaming || msg.content?.trim()) continue;
    const tail = tailLine(msg.thinking);
    if (tail) return tail;
  }

  // 3. 最近一个已跑完的工具
  const lastTool = tools[tools.length - 1];
  return lastTool ? toolLine(lastTool) : "";
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

  // Hooks 必须先于任何条件返回调用，保证调用次数稳定
  // （组件可能在同一会话中被复用渲染）。
  const isStreaming = messages.some((m) => m.isStreaming);
  const isToolRunning = tools.some((tool) => tool.isRunning);
  const streamingOrRunning = isStreaming || isToolRunning;
  // 面板默认始终折叠：流式过程中也不自动展开（避免过程内容每 token 跳动），
  // 运行状态只通过标题行徽标表达（2px 状态点）。开合完全由用户决定 ——
  // 手动展开后不再因「思考写完 / 工具跑完 / 回合结束」被自动收起。
  const [expanded, setExpanded] = useState(false);

  const turnSettled = !isStreaming && !isToolRunning;

  // 没有任何过程性内容 → 不渲染面板。
  if (!hasThinking && !hasTools && !hasIntermediate) return null;

  // 折叠态的实时尾巴：只在运行中显示，回合结束自动清空（回到干净标题行）。
  const liveText = liveStageText(messages, turnSettled);

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
        {/* 折叠态的实时尾巴：展开时由正文时间线承担表达，故隐藏，避免重复。
            单行 + 省略号截断，不换行、不撑高标题行。 */}
        {!expanded && liveText && (
          <span className={styles.liveText} title={liveText}>
            {liveText}
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
            // id 加 panel- 前缀：同一 msg.id 在回合级已由 AssistantTurn
            // 渲染成 msg-<id>，若这里也用 msg-<id> 会造成重复 id，
            // 搜索定位/高亮会命中面板内这个（文档顺序靠前）而非正文。
            return (
              <div key={msg.id} id={`panel-msg-${msg.id}`} className={styles.step}>
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
