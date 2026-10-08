import { memo, useState, useRef, useEffect } from "react";
import { Copy, Check, Volume2, Loader2, Square } from "lucide-react";
import type { Message, Artifact } from "../store/agent-store";
import { useTranslation } from "react-i18next";
import { useTtsStore } from "../store/tts-store";
import { PcmStreamPlayer } from "./pcm-player";
import Markdown from "./Markdown";
import ThinkingTools from "./ThinkingTools";
import ArtifactCards from "./ArtifactCards";
import styles from "./AssistantTurn.module.css";

interface Props {
  /** 同一回合的全部 assistant 消息（中间过程 + 最终回复）。 */
  messages: Message[];
  highlight?: boolean;
}

/**
 * 单个 LLM 回合的气泡：
 *
 *  - 始终只显示**一个** Pi 头像；
 *  - 思考过程 / 工具调用 / 中间回复内容折叠在「思考与工具」面板内
 *    （默认始终折叠，可手动展开；运行状态看标题行徽标）；
 *  - 最终回复正文始终独立显示在面板下方。
 *
 * 这样流式和完成态都只有一个 Pi 图标，中间过程不再拆成多个气泡。
 */
function AssistantTurn({ messages, highlight }: Props) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [ttsLoading, setTtsLoading] = useState(false);
  const [ttsPlaying, setTtsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pcmPlayerRef = useRef<PcmStreamPlayer | null>(null);
  const ttsRequestIdRef = useRef<string | null>(null);
  const prevStreamingRef = useRef(false);
  const ttsConfig = useTtsStore((s) => s.config);
  const ttsLoaded = useTtsStore((s) => s.loaded);
  const ttsLoad = useTtsStore((s) => s.load);

  useEffect(() => {
    if (!ttsLoaded) ttsLoad();
  }, [ttsLoaded, ttsLoad]);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (pcmPlayerRef.current) {
        pcmPlayerRef.current.stop();
        pcmPlayerRef.current = null;
      }
    };
  }, []);

  // 最终回复 = 有正文内容（content 非空）的最后一条 assistant 消息；
  // 如果都在流式中还没有正文，则取最后一条消息（用于显示打字指示）。
  let finalIdx = messages.length - 1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].content?.trim()) {
      finalIdx = i;
      break;
    }
  }
  const finalMsg = messages[finalIdx];
  const finalContent = finalMsg?.content ?? "";

  // 面板消息：所有消息都展示思考/工具/中间内容；最终回复消息的 content
  // 置空，避免与下方独立渲染的正文重复。
  const panelMessages: Message[] = messages.map((m, i) =>
    i === finalIdx && m.content?.trim() ? { ...m, content: "" } : m
  );

  // 过程区（思考/工具/中间回复）是否会有内容渲染 —— 与 ThinkingTools 内部
  // 的渲染条件保持一致，用于决定「过程区 ↔ 最终正文」之间是否显示浅分割线。
  const hasPanelContent = panelMessages.some(
    (m) => !!m.thinking?.trim() || (m.toolExecutions?.length ?? 0) > 0 || !!m.content?.trim()
  );

  const isStreaming = messages.some((m) => m.isStreaming);
  const hasTemporalContent = messages.some(
    (m) => !!m.thinking?.trim() || m.toolExecutions?.length
  );

  // 收集整轮所有 assistant 消息里的产物（去重），避免 artifacts 落在非
  // final 消息上时不显示。
  const turnArtifacts = (() => {
    const seen = new Set<string>();
    const out: Artifact[] = [];
    for (const m of messages) {
      if (m.role !== "assistant" || !m.artifacts?.length) continue;
      for (const a of m.artifacts) {
        if (!seen.has(a.filePath)) {
          seen.add(a.filePath);
          out.push(a);
        }
      }
    }
    return out;
  })();

  const copy = () => {
    navigator.clipboard
      ?.writeText(finalContent)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  const hasTts = !!ttsConfig.activeConfigId && ttsConfig.configs.some((c) => c.id === ttsConfig.activeConfigId);

  // ── Streaming TTS: auto-play when LLM streaming finishes & streamEnabled ──
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;
    if (wasStreaming && !isStreaming && finalContent.trim() && hasTts && ttsConfig.streamEnabled) {
      const requestId = `tts-stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      ttsRequestIdRef.current = requestId;
      const player = new PcmStreamPlayer();
      pcmPlayerRef.current = player;
      player.start();
      setTtsPlaying(true);

      const offChunk = window.piDesk.onTtsChunk((data) => {
        if (data.requestId === requestId && !player.isStopped) {
          player.feed(data.pcmBase64);
        }
      });
      const offDone = window.piDesk.onTtsDone((data) => {
        if (data.requestId === requestId) {
          setTtsPlaying(false);
          ttsRequestIdRef.current = null;
          offChunk();
          offDone();
        }
      });

      window.piDesk
        .ttsSynthesizeStream(finalContent, requestId)
        .catch(() => {
          setTtsPlaying(false);
          ttsRequestIdRef.current = null;
          offChunk();
          offDone();
        });
    }
  }, [isStreaming, finalContent, hasTts, ttsConfig.streamEnabled]);

  const speak = async () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
      setTtsPlaying(false);
      return;
    }
    if (pcmPlayerRef.current) {
      pcmPlayerRef.current.stop();
      pcmPlayerRef.current = null;
      ttsRequestIdRef.current = null;
      setTtsPlaying(false);
      return;
    }
    setTtsLoading(true);
    try {
      const { audioBase64, format } = await window.piDesk.ttsSynthesize(finalContent);
      const mime = format === "wav" ? "audio/wav" : `audio/${format}`;
      const audio = new Audio(`data:${mime};base64,${audioBase64}`);
      audioRef.current = audio;
      audio.onended = () => {
        setTtsPlaying(false);
        audioRef.current = null;
      };
      audio.onerror = () => {
        setTtsPlaying(false);
        setTtsLoading(false);
        audioRef.current = null;
      };
      setTtsLoading(false);
      setTtsPlaying(true);
      await audio.play();
    } catch {
      setTtsLoading(false);
      setTtsPlaying(false);
    }
  };

  const time = finalMsg?.timestamp
    ? new Date(finalMsg.timestamp).toLocaleString([], {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "";

  return (
    <div
      // 回合根 id 用于搜索定位。单条消息的回合里 messages[0] 与 finalMsg
      // 是同一条消息，若两处都挂 msg-<id> 就会产生重复 id（getElementById
      // 只能命中其中一个），故仅在两者不同时才给回合根挂 id。
      id={
        messages[0] && messages[0].id !== finalMsg?.id
          ? `msg-${messages[0].id}`
          : undefined
      }
      className={`${styles.assistantTurn} ${highlight ? styles.highlight : ""}`}
    >
      <div className={styles.avatarRow}>
        <div className={styles.avatar}>Pi</div>
        {isStreaming && !finalContent.trim() && !hasTemporalContent && (
          <span className={styles.typing} role="status" aria-label={t("chat.requesting")}>
            <span className={styles.typingText}>{t("chat.requesting")}</span>
            <span className={styles.typingDots}>
              <span></span>
              <span></span>
              <span></span>
            </span>
          </span>
        )}
      </div>
      <div className={styles.body}>
        {/* 思考 / 工具 / 中间回复：聚合折叠面板（默认始终折叠，
            流式时也不自动展开；想看过程可手动点开） */}
        <ThinkingTools messages={panelMessages} />
        {/* 过程区与最终正文之间的浅分割线：仅在两者同时存在时出现，
            不展开过程区、也没有正文时不渲染，避免出现悬空的分割线 */}
        {hasPanelContent && finalContent.trim() && (
          <div className={styles.divider} aria-hidden="true" />
        )}
        {/* 最终回复正文：始终独立展示 */}
        {finalContent.trim() && (
          <div id={`msg-${finalMsg.id}`} className={styles.content}>
            {/* Path links only once the turn has settled — enabling them
                mid-stream would re-run the markdown pipeline (and its stat()
                checks) on every streamed token. */}
            <Markdown content={finalContent} linkifyPaths={!isStreaming} />
          </div>
        )}
        {/* 产物文件卡片：一旦本回合产出第一个产物就固定显示（流式中也渲染），
            不再用 !isStreaming 门控——isStreaming 在多个工具步骤之间会反复翻转，
            门控反而导致卡片在流式过程中闪烁消失/出现。turnArtifacts 随工具执行
            单调累积、稳定不回退，故直接按产物数量渲染即可。 */}
        {turnArtifacts.length ? (
          <ArtifactCards artifacts={turnArtifacts} />
        ) : null}
        {(finalContent.trim() || finalMsg?.stoppedByUser) && (
          <div className={styles.meta}>
            <span className={styles.time}>{time}</span>
            {finalMsg?.stoppedByUser && (
              <span className={styles.stoppedBadge}>{t("chat.stoppedByUser")}</span>
            )}
            {finalContent.trim() && (
              <>
                <button
                  className={styles.copyBtn}
                  onClick={copy}
                  title={t("chat.copy")}
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  <span className={styles.copyLabel}>
                    {copied ? t("chat.copied") : t("chat.copy")}
                  </span>
                </button>
                {hasTts && (
                  <button
                    className={styles.copyBtn}
                    onClick={speak}
                    title={ttsPlaying ? t("chat.stopSpeak") : t("chat.speak")}
                    disabled={ttsLoading}
                  >
                    {ttsLoading ? (
                      <Loader2 size={12} className={styles.spin} />
                    ) : ttsPlaying ? (
                      <Square size={12} />
                    ) : (
                      <Volume2 size={12} />
                    )}
                    <span className={styles.copyLabel}>
                      {ttsLoading
                        ? t("chat.speakingLoading")
                        : ttsPlaying
                          ? t("chat.stopSpeak")
                          : t("chat.speak")}
                    </span>
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Only re-render when fields this component renders change. The messages array
 * is rebuilt on every stream token, so we compare by content/thinking/
 * toolExecutions references + isStreaming to skip identical turns.
 */
function areEqual(prev: Props, next: Props): boolean {
  const a = prev.messages;
  const b = next.messages;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.content !== y.content ||
      x.thinking !== y.thinking ||
      x.isStreaming !== y.isStreaming ||
      x.timestamp !== y.timestamp ||
      x.toolExecutions !== y.toolExecutions ||
      x.artifacts !== y.artifacts ||
      x.id !== y.id
    ) {
      return false;
    }
  }
  return prev.highlight === next.highlight;
}

export default memo(AssistantTurn, areEqual);