/**
 * piwork-compress 冒烟脚本（不入构建：tsconfig.node.json 已排除本文件）。
 *
 * 跑法（PowerShell，仓库根）：
 *   $env:PI_CODING_AGENT_DIR 由脚本自己设到临时目录，不碰真实 ~/.pi
 *   node src/main/pi/compress/smoke-test.ts
 *
 * 手法照 pi-preamble 冒烟：假 pi 对象 + 假 ctx + 临时 agent 目录，逐条断言，
 * 失败即非零退出。断言清单见 COMPRESS_EXTENSION_DEV_PLAN.md §9.1。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 必须在 import 扩展之前设好：getAgentDir() 读的就是这个变量。
const agentDir = mkdtempSync(join(tmpdir(), "piwork-compress-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const mod = await import("./piwork-compress.ts");
const {
  COMPRESS_DOCTRINE,
  assignRefs,
  computeProtectedRefs,
  createSessionState,
  deriveBlocks,
  projectMessages,
  refreshView,
  runCompress,
  sessionStateFor,
  stripWcTag,
} = mod;

// ── 断言小工具 ─────────────────────────────────────────────────────────────
let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function checkThrows(name: string, fn: () => unknown, needle: string): void {
  try {
    fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(name, msg.includes(needle), msg.slice(0, 160));
    return;
  }
  check(name, false, "no throw");
}

// ── 假消息构造器 ───────────────────────────────────────────────────────────
// 测试夹具：假消息与 SDK 的 AgentMessage 联合类型双向都要能塞，用 any 最省事
// （本文件不进构建，只做冒烟断言）。
type Msg = any;

function user(text: string): Msg {
  return { role: "user", content: text, timestamp: 1 };
}
function assistantCall(id: string, name: string, args: unknown): Msg {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    usage: {},
    stopReason: "toolUse",
    timestamp: 1,
  };
}
function toolResult(toolCallId: string, toolName: string, text: string, isError = false): Msg {
  return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError, timestamp: 1 };
}

const BIG = "x".repeat(4000); // ≈1000 token
const SUMMARY = `TASK AS OF THIS BLOCK: 已完成侦察。
- server/src/bridge.ts:524 sendToBridge() 超时未清理。
- 决定：改成 5s 超时并加重试，因为下游会积压。
- 报错原文：Error: ESOCKETTIMEDOUT at Bridge.send (bridge.ts:524)`;

/** 首条 user + N 组 bash 调用/结果 + 末条 user。 */
function transcript(pairCount: number, size: string = BIG): Msg[] {
  const msgs: Msg[] = [user("原始需求：把 bridge 的超时与重试拆开重写，保持向后兼容。")];
  for (let k = 0; k < pairCount; k += 1) {
    msgs.push(assistantCall(`c${k}`, "bash", { command: `grep -rn x${k} src/` }));
    msgs.push(toolResult(`c${k}`, "bash", `${size}\n# pair ${k}`));
  }
  msgs.push(user("继续下一步。"));
  return msgs;
}

const asMsgs = (list: readonly Msg[]) => list as any;
const asParams = (v: unknown) => v as any;

const probe = (over: Partial<{ tokens: number | null; contextWindow: number; systemPrompt: string }> = {}) => ({
  tokens: null,
  contextWindow: 200_000,
  systemPrompt: "BASE PROMPT",
  ...over,
});

function freshState(msgs: readonly Msg[], over: Parameters<typeof probe>[0] = {}) {
  const state = createSessionState();
  const view = refreshView(state, asMsgs(msgs), probe(over));
  return { state, view };
}

// ── 1. ref 稳定性 / BLOCKED ────────────────────────────────────────────────
{
  const core = projectMessages(asMsgs(transcript(6)));
  const a = assignRefs(core);
  const b = assignRefs(core);
  check("ref 确定性", JSON.stringify([...a.byId]) === JSON.stringify([...b.byId]));
  check("ref 形态 mNNNNN", a.byId.get("e0") === "m00001");
  check("compress 调用不分配 ref", !a.byId.has("e1") || core[1].toolCalls[0].name !== "compress");

  const withCompress = [
    user("hi"),
    assistantCall("cc", "compress", { content: [] }),
    toolResult("cc", "compress", "ok"),
    user("bye"),
  ];
  const core2 = projectMessages(asMsgs(withCompress));
  const refs2 = assignRefs(core2);
  check("compress 对 BLOCKED", refs2.blocked.has("e1") && refs2.blocked.has("e2"));
  check("compress 对两侧无 ref", !refs2.byId.has("e1") && !refs2.byId.has("e2"));

  const withImage = [
    user("hi"),
    { role: "user", content: [{ type: "text", text: "看图" }, { type: "image", data: "AAA", mimeType: "image/png" }], timestamp: 1 },
    user("bye"),
  ];
  const refs3 = assignRefs(projectMessages(asMsgs(withImage)));
  check("带图 BLOCKED（无 ref）", !refs3.byId.has("e1") && refs3.byId.get("e2") === "m00002");
}

// ── 2. 保护区 ──────────────────────────────────────────────────────────────
{
  const msgs = transcript(24);
  const core = projectMessages(asMsgs(msgs));
  const refs = assignRefs(core);
  const prot = computeProtectedRefs(core, refs);
  check("末条 user 受保护", prot.has(refs.byId.get("e49") ?? ""));
  check("首条 user 不在保护区", !prot.has(refs.byId.get("e0") ?? ""));
  const lastRef = Number((refs.byId.get("e49") ?? "m00000").slice(1));
  const firstProt = Math.min(...[...prot].map((r) => Number(r.slice(1))));
  check("尾部保护区约 5-9 条", lastRef - firstProt <= 9 && lastRef - firstProt >= 4, `${firstProt}..${lastRef}`);
}

// ── 3. 校验链 11 条 ────────────────────────────────────────────────────────
{
  const msgs = transcript(24);
  const bigRange = { startId: "m00002", endId: "m00011", summary: SUMMARY };

  // (1) 非法 ref
  checkThrows(
    "校验1 非法 ref",
    () => runCompress(freshState(msgs).state, "t1", asParams({ content: [{ ...bigRange, startId: "5" }] })),
    'Invalid boundary ref(s): startId="5", endId="m00011". Use mNNNNN.',
  );
  // (2) 不存在
  checkThrows(
    "校验2 ref 不存在",
    () => runCompress(freshState(msgs).state, "t1", asParams({ content: [{ ...bigRange, startId: "m09999" }] })),
    'startId="m09999" does not exist in this session (typo or wrong session).',
  );
  // (3) 反向交换（不报错，块边界自动纠正）
  {
    const { state } = freshState(msgs);
    const r = runCompress(state, "t1", asParams({ content: [{ startId: "m00011", endId: "m00002", summary: SUMMARY }] }));
    check("校验3 反向交换成活", r.text.includes("b1=m00002–m00011"), r.text.slice(0, 120));
  }
  // (4) 全已覆盖
  {
    const { state } = freshState(msgs);
    runCompress(state, "t1", asParams({ content: [bigRange] }));
    checkThrows(
      "校验4 已覆盖",
      () => runCompress(state, "t2", asParams({ content: [{ ...bigRange, startId: "m00004", endId: "m00009" }] })),
      "contains no new compressible messages — every message in it is already covered by active block(s) b1",
    );
  }
  // (5) 全在保护区
  {
    const { state, view } = freshState(msgs);
    const refs = state.refs;
    const tail = [...refs.byId.values()].slice(-6);
    const ok = tail.length >= 2;
    checkThrows(
      "校验5 全在保护区",
      () => runCompress(state, "t1", asParams({ content: [{ startId: tail[tail.length - 2], endId: tail[tail.length - 1], summary: SUMMARY }] })),
      "Range is entirely within the protected zone",
    );
    check("视图规模合理", ok && view.messages.length > 10);
  }
  // (6) 部分在保护区 → 剔除 + 警告
  {
    const { state } = freshState(msgs);
    const r = runCompress(state, "t1", asParams({ content: [{ startId: "m00002", endId: "m00050", summary: SUMMARY }] }));
    check("校验6 剔除受保护并警告", r.text.includes("Excluded") && r.text.includes("do not target them in another compress call"), r.text.slice(0, 200));
  }
  // (7) 拆对：单独一条 tool-result 全撤光
  checkThrows(
    "校验7 拆对全撤光",
    () => runCompress(freshState(msgs).state, "t1", asParams({ content: [{ startId: "m00003", endId: "m00003", summary: SUMMARY }] })),
    "would split a tool call/result pair",
  );
  {
    const { state } = freshState(msgs);
    const r = runCompress(state, "t1", asParams({ content: [{ startId: "m00003", endId: "m00011", summary: SUMMARY }] }));
    check("校验7 边界撤回警告", r.text.includes("Withdrew 1 boundary message(s) m00003"), r.text.slice(0, 200));
  }
  // (8) 太小：大量正文把尾部保护区挤到后面，中间夹一小段「不够压」的区间
  {
    const mixed: Msg[] = [user("小会话")];
    const pushPair = (k: number, size: string) => {
      mixed.push(assistantCall(`m${k}`, "bash", { command: "ls" }));
      mixed.push(toolResult(`m${k}`, "bash", size));
    };
    for (let k = 0; k < 8; k += 1) pushPair(k, BIG);
    const tinyStart = `m${String(2 + 2 * 8).padStart(5, "0")}`; // 第 9 组（下标从 1 起算）
    for (let k = 8; k < 10; k += 1) pushPair(k, "a".repeat(100));
    const tinyEnd = `m${String(2 + 2 * 10 - 1).padStart(5, "0")}`;
    for (let k = 10; k < 18; k += 1) pushPair(k, BIG);
    mixed.push(user("结束"));
    const { state } = freshState(mixed);
    checkThrows(
      "校验8 内容过小",
      () => runCompress(state, "t1", asParams({ content: [{ startId: tinyStart, endId: tinyEnd, summary: SUMMARY }] })),
      "Total compressible content too small",
    );
  }
  // (9)(10) 摘要长度
  checkThrows(
    "校验9 摘要过短",
    () => runCompress(freshState(msgs).state, "t1", asParams({ content: [{ ...bigRange, summary: "too short" }] })),
    "Summary too short (9 chars, min 50)",
  );
  checkThrows(
    "校验10 摘要过长",
    () => runCompress(freshState(msgs).state, "t1", asParams({ content: [{ ...bigRange, summary: "y".repeat(20_001) }] })),
    "Summary too long (20001 chars, max 20000)",
  );
  // (11) 同批重叠
  {
    const { state } = freshState(msgs);
    const r = runCompress(state, "t1", asParams({
      content: [
        { startId: "m00002", endId: "m00011", summary: SUMMARY },
        { startId: "m00008", endId: "m00015", summary: SUMMARY },
      ],
    }));
    check("校验11 批内重叠跳过", r.text.includes("overlaps an earlier range in the batch"), r.text.slice(0, 220));
  }
  // 死循环防线
  {
    const { state } = freshState(msgs);
    const bad = asParams({ content: [{ startId: "m00003", endId: "m00003", summary: SUMMARY }] });
    checkThrows("死循环 第1次原错", () => runCompress(state, "t1", bad), "would split a tool call/result pair");
    checkThrows("死循环 第2次硬拒", () => runCompress(state, "t2", bad), "REJECTED");
  }
  {
    const { state } = freshState(msgs);
    const variants = [
      asParams({ content: [{ startId: "m00003", endId: "m00003", summary: SUMMARY }] }),
      asParams({ content: [{ startId: "m09999", endId: "m00011", summary: SUMMARY }] }),
      asParams({ content: [{ startId: "m00002", endId: "m00011", summary: "short" }] }),
    ];
    let last = "";
    for (const [i, p] of variants.entries()) {
      try {
        runCompress(state, `t${i}`, p);
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
    }
    check("死循环 三次暂停", last.includes("PAUSED — 3 compress attempts already failed this turn"), last.slice(0, 120));
  }
}

// ── 4. derive 账本（重放）──────────────────────────────────────────────────
function textOf(m: Msg | undefined): string {
  if (!m) return "";
  const c = (m as { content?: unknown }).content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((p) => p && typeof p === "object" && (p as { type?: string }).type === "text")
      .map((p) => String((p as { text?: string }).text ?? ""))
      .join("\n");
  }
  return "";
}

function transcriptWithLedger(): Msg[] {
  const msgs = transcript(24);
  msgs.push(assistantCall("cc1", "compress", { content: [{ startId: "m00002", endId: "m00011", summary: SUMMARY, topic: "Recon" }] }));
  msgs.push(toolResult("cc1", "compress", "ok"));
  msgs.push(assistantCall("cc2", "compress", { content: [{ startId: "m00012", endId: "m00021", summary: SUMMARY }] }));
  msgs.push(toolResult("cc2", "compress", "boom", true)); // isError → 不重放
  msgs.push(assistantCall("cc3", "compress", {
    content: [
      { startId: "m00022", endId: "m00031", summary: SUMMARY },
      { startId: "m09999", endId: "m00035", summary: SUMMARY }, // 非法 → 整条跳过
    ],
  }));
  msgs.push(toolResult("cc3", "compress", "ok"));
  return msgs;
}

{
  const msgs = transcriptWithLedger();
  const core = projectMessages(asMsgs(msgs));
  const refs = assignRefs(core);
  const blocks = deriveBlocks(core, refs, computeProtectedRefs(core, refs));
  check("derive 成功调用成活", blocks.length === 1, JSON.stringify(blocks.map((b: { blockId: string }) => b.blockId)));
  check("derive 跳过 isError 调用", blocks.every((b: { compressCallId: string }) => b.compressCallId !== "cc2"));
  check("derive 整条跳过不部分成活", blocks.every((b: { compressCallId: string }) => b.compressCallId !== "cc3"));
  check("derive 块 id 从 b1 起", blocks[0]?.blockId === "b1");

  const { view } = freshState(msgs);
  const resultIds = view.messages
    .filter((m: Msg) => (m as { role?: string }).role === "toolResult")
    .map((m: Msg) => String((m as { toolCallId?: string }).toolCallId));
  check("hide 成活调用结果", !resultIds.includes("cc1"));
  check("失败调用保留为正常历史", resultIds.includes("cc2") && resultIds.includes("cc3"));
  const callKept = view.messages.some(
    (m: Msg) =>
      (m as { role?: string }).role === "assistant" &&
      Array.isArray((m as { content?: unknown[] }).content) &&
      ((m as { content: { type?: string; id?: string }[] }).content ?? []).some((b) => b.type === "toolCall" && b.id === "cc1"),
  );
  check("hide 成活调用本体", !callKept);

  const idx = view.messages.findIndex((m: Msg) => (m as { customType?: string }).customType === "wc-summary");
  check("摘要已注入", idx >= 0);
  const sText = textOf(view.messages[idx] as Msg);
  check("摘要全文在场（含 topic 与原文报错）", sText.includes("[Compressed conversation section] — Recon") && sText.includes("ESOCKETTIMEDOUT"));
  check("摘要不进 UI 渲染（display:false）", (view.messages[idx] as { display?: boolean }).display === false);
  const prev = view.messages[idx - 1] as Msg | undefined;
  const next = view.messages[idx + 1] as Msg | undefined;
  const prevIsCall =
    !!prev &&
    (prev as { role?: string }).role === "assistant" &&
    ((( prev as { content?: { type?: string }[] }).content) ?? []).some((b) => b.type === "toolCall");
  const nextIsResult = !!next && (next as { role?: string }).role === "toolResult";
  check("摘要锚点不拆 tool 对", !(prevIsCall && nextIsResult));
  check("被折叠区间已从视图移除", !view.messages.some((m: Msg) => /# pair 2$/m.test(textOf(m))));
}

// 首条 user 永不移除
{
  const msgs = transcript(12);
  msgs.push(assistantCall("ccF", "compress", { content: [{ startId: "m00001", endId: "m00011", summary: SUMMARY }] }));
  msgs.push(toolResult("ccF", "compress", "ok"));
  const { view } = freshState(msgs);
  check("首条 user 仍在视图首位（即使被块覆盖）", textOf(view.messages[0] as Msg).includes("原始需求"));
  check("摘要排在首条 user 之后", /Compressed conversation section/.test(textOf(view.messages[1] as Msg)));
}

// ── 5. 标签：只落 user/tool、幂等 ──────────────────────────────────────────
{
  const msgs = transcript(6);
  const { view } = freshState(msgs);
  const texts = view.messages.map((m: Msg) => ({ role: (m as { role?: string }).role ?? "", text: textOf(m) }));
  check("user 带标签", texts.filter((t) => t.role === "user").every((t) => /<wc tokens="[^"]*" type="user">m\d{5}<\/wc>$/.test(t.text)));
  check("tool 带标签（type=toolName）", texts.filter((t) => t.role === "toolResult").every((t) => /<wc tokens="[^"]*" type="bash">m\d{5}<\/wc>$/.test(t.text)));
  check("assistant 零标签", texts.filter((t) => t.role === "assistant").every((t) => !t.text.includes("<wc ")));
  check("标签不增殖（每条 ≤1）", texts.every((t) => (t.text.match(/<wc /g) ?? []).length <= 1));
  check("剥标签可还原原文", stripWcTag(texts[0].text) === textOf(msgs[0] as Msg));
  const again = freshState(view.messages as Msg[]);
  const againTexts = again.view.messages.map((m: Msg) => textOf(m));
  check("二次视图仍幂等", againTexts.every((t: string) => (t.match(/<wc /g) ?? []).length <= 1));
}

// ── 6. nudge 三通路 ────────────────────────────────────────────────────────
const HUGE = "x".repeat(20_000); // ≈5000 token/条
{
  // A. 首次见面即大量可压
  const a = freshState(transcript(24, HUGE));
  const aText = textOf(a.view.messages[a.view.messages.length - 1] as Msg);
  check("nudge-A 触发", a.view.nudged === true && aText.includes("efficiency nudge"), `pending=${a.view.pendingTokens} usage=${a.view.usage}`);
  check("nudge-A 附候选清单", aText.includes("Compressible ranges (") && aText.includes("Example: compress("));
  const ratio = Math.round((a.view.usage / 200_000) * 100);
  check(
    "nudge 不披露总占比",
    !aText.includes(`${ratio}%`) && !/\d+(\.\d+)?\s*%\s*(of|used|context|window)/i.test(aText),
    aText.slice(0, 160),
  );

  // B. 增长门（先建基线，再长大）
  const state = createSessionState();
  refreshView(state, asMsgs(transcript(2)), probe());
  const b = refreshView(state, asMsgs(transcript(24, HUGE)), probe());
  check("nudge-B 增长门触发", b.nudged === true, `usage=${b.usage} baseline=${state.baseline}`);

  // C. 高压带（可压量不足 50K，靠 provider floor 抬到 0.75 以上）
  const state2 = createSessionState();
  refreshView(state2, asMsgs(transcript(12)), probe({ tokens: 145_000 }));
  const c = refreshView(state2, asMsgs(transcript(12)), probe({ tokens: 190_000 }));
  check("nudge-C 高压带触发", c.nudged === true, `usage=${c.usage} pending=${c.pendingTokens}`);

  // 不触发：小会话 + 已建基线
  const state3 = createSessionState();
  refreshView(state3, asMsgs(transcript(2)), probe());
  const d = refreshView(state3, asMsgs(transcript(2)), probe());
  check("nudge 小会话不触发", d.nudged === false);
}

// ── 7. 应急截断不碰摘要 ────────────────────────────────────────────────────
{
  const msgs = transcript(24, HUGE);
  msgs.push(assistantCall("ccT", "compress", { content: [{ startId: "m00002", endId: "m00011", summary: SUMMARY, topic: "Old" }] }));
  msgs.push(toolResult("ccT", "compress", "ok"));
  const { view } = freshState(msgs, { tokens: 195_000 });
  check("应急截断已触发", view.truncated > 0, `truncated=${view.truncated}`);
  const summary = view.messages.find((m: Msg) => (m as { customType?: string }).customType === "wc-summary") as Msg | undefined;
  check("摘要仍在场且未被截", !!summary && textOf(summary).includes("ESOCKETTIMEDOUT") && !textOf(summary).includes("[truncated for context space]"));
  check("确有工具输出被截", view.messages.some((m: Msg) => textOf(m).includes("[truncated for context space]")));
}

// ── 8. 教义与接线（假 pi + 临时 agent 目录）───────────────────────────────
interface FakePi {
  handlers: Map<string, (e: unknown, c: unknown) => unknown>;
  tools: any[];
  api: any;
}

function fakePi(): FakePi {
  const handlers = new Map<string, (e: unknown, c: unknown) => unknown>();
  const tools: unknown[] = [];
  return {
    handlers,
    tools,
    api: {
      on: (name: string, handler: (e: unknown, c: unknown) => unknown) => {
        handlers.set(name, handler);
        return () => {};
      },
      registerTool: (tool: unknown) => {
        tools.push(tool);
      },
    },
  };
}

function fakeCtx(sessionId: string, tokens: number | null = null) {
  return {
    sessionManager: { getSessionId: () => sessionId },
    model: { contextWindow: 200_000 },
    getContextUsage: () => (tokens === null ? undefined : { tokens, contextWindow: 200_000, percent: null }),
    getSystemPrompt: () => "SYS PROMPT",
  };
}

{
  const configPath = join(agentDir, "compress-config.json");

  // 关（缺省）→ 零注册
  writeFileSync(configPath, JSON.stringify({}), "utf-8");
  const off = fakePi();
  mod.default(off.api);
  check("关：不注册不挂事件", off.handlers.size === 0 && off.tools.length === 0);

  // 开
  writeFileSync(configPath, JSON.stringify({ enabled: true }), "utf-8");
  const on = fakePi();
  mod.default(on.api);
  check(
    "开：三事件 + compress 工具",
    on.handlers.has("session_before_compact") && on.handlers.has("context") && on.handlers.has("before_agent_start") && on.tools.length === 1 && on.tools[0].name === "compress",
  );

  const ctx = fakeCtx("s-wire");
  const compact = on.handlers.get("session_before_compact")?.({ type: "session_before_compact" }, ctx);
  check("内置压缩被 cancel", (compact as { cancel?: boolean } | undefined)?.cancel === true);

  const prompt = on.handlers.get("before_agent_start")?.({ type: "before_agent_start", systemPrompt: "BASE" }, ctx) as
    | { systemPrompt?: string }
    | undefined;
  check("教义追加在提示词最末", (prompt?.systemPrompt ?? "").startsWith("BASE\n\n") && (prompt?.systemPrompt ?? "").endsWith("transcript for the user."));

  const viewResult = on.handlers.get("context")?.({ type: "context", messages: asMsgs(transcript(24)) }, fakeCtx("s-exec")) as
    | { messages?: unknown[] }
    | undefined;
  check("context 通路返回视图", Array.isArray(viewResult?.messages) && (viewResult?.messages.length ?? 0) > 0);
  check("context 后留下快照", sessionStateFor("s-exec")?.core.length === 50);

  // 工具端到端（走 ctx 拿快照）
  const execCtx = fakeCtx("s-exec");
  const tool = on.tools[0];
  const res = (await tool.execute(
    "call-1",
    { content: [{ startId: "m00002", endId: "m00011", summary: SUMMARY }] },
    undefined,
    undefined,
    execCtx,
  )) as { content: { text: string }[] };
  check("compress 工具端到端成活", res.content[0].text.includes("▣ wc |") && res.content[0].text.includes("b1=m00002–m00011"), res.content[0].text.slice(0, 150));

  // doctrineOverride 整段替换
  writeFileSync(configPath, JSON.stringify({ enabled: true, doctrineOverride: "MY OWN DOCTRINE" }), "utf-8");
  const custom = fakePi();
  mod.default(custom.api);
  const customPrompt = custom.handlers.get("before_agent_start")?.({ type: "before_agent_start", systemPrompt: "BASE" }, ctx) as
    | { systemPrompt?: string }
    | undefined;
  check("doctrineOverride 生效", (customPrompt?.systemPrompt ?? "").endsWith("MY OWN DOCTRINE"));
}

// ── 9. 模型可见文案里不得出现被砍工具字样 ─────────────────────────────────
{
  const modelFacing = [
    COMPRESS_DOCTRINE,
    // 视图里出现过的所有文本（nudge + 摘要 + 标签）
    textOf(freshState(transcript(24, HUGE)).view.messages.slice(-1)[0] as Msg),
  ].join("\n");
  check(
    "文案零残留（acp/decompress/search_context/acp_status/delegate）",
    !/\b(acp|acp_status|search_context|decompress)\b/i.test(modelFacing),
  );
}

// ── 10. 上下文用量明细（src/shared/context-breakdown.ts）────────────────────
const bd = await import("../../../shared/context-breakdown.ts");
const { countTokens, countMessageTokens, isToolMessage, computeContextBreakdown, SUMMARY_HEADER } = bd;
const bdMsg = (over: Record<string, unknown>) => ({ role: "user", text: "", contentType: "text", ...over }) as any;

{
  check("CJK 1:1", countTokens("你好世界") === 4);
  check("其余 4 字符:1（向上取整）", countTokens("abcd") === 1 && countTokens("abcde") === 2);
  check("混合按各自口径", countTokens("你好ab") === 3 && countTokens("") === 0);
  check("摘要前缀与扩展一致", SUMMARY_HEADER === "[Compressed conversation section]");

  check(
    "思考 token 守卫（NaN/负数/缺省不污染）",
    countMessageTokens(bdMsg({ text: "abcd", thinkingTokens: Number.NaN })) === 1 &&
      countMessageTokens(bdMsg({ text: "abcd", thinkingTokens: -50 })) === 1 &&
      countMessageTokens(bdMsg({ text: "abcd" })) === 1 &&
      countMessageTokens(bdMsg({ text: "abcd", thinkingTokens: 50 })) === 51,
  );

  // 判定顺序：summaries 抢在 tool 前
  const s = computeContextBreakdown([
    bdMsg({ role: "toolResult", contentType: "tool-result", text: `${SUMMARY_HEADER}\n已完成的活` }),
  ]);
  check("摘要抢在 tool 前", s.summaries > 0 && s.tool === 0, JSON.stringify(s));

  // toolName 不参与判定（BC issue #390）
  const named = bdMsg({ role: "assistant", contentType: "text", text: "普通说明", toolName: "bash" });
  const t2 = computeContextBreakdown([named]);
  check("带 toolName 的普通文本不算 tool", isToolMessage(named) === false && t2.tool === 0 && t2.text > 0);
  check("tool-call/tool-result 才算 tool", isToolMessage(bdMsg({ contentType: "tool-call" })) === true && isToolMessage(bdMsg({ contentType: "tool-result" })) === true);

  // tool 抢在 code 前；system 抢在 code 前；code 看 ```
  const mix = computeContextBreakdown([
    bdMsg({ role: "toolResult", contentType: "tool-result", text: "```js\ncode\n```" }),
    bdMsg({ role: "system", text: "prompt with ``` fence" }),
    bdMsg({ role: "user", text: "```python\nx=1\n```" }),
    bdMsg({ role: "user", text: "纯文本一句话" }),
  ]);
  check("tool 带代码块仍算 tool", mix.tool > 0 && mix.code > 0);
  check("system 优先于 code", mix.system > 0);
  check("code 只认含 ``` 的正文", mix.code === countTokens("```python\nx=1\n```"), JSON.stringify(mix));
  check("text 桶收纯文本", mix.text === countTokens("纯文本一句话"));

  // 地板：合计取大，不虚高
  const floored = computeContextBreakdown([bdMsg({ text: "abcd" })], 1000);
  check("provider 读数更高时取地板", floored.total === 1000 && floored.text === 1);
  const noFloor = computeContextBreakdown([bdMsg({ text: "abcd" })], null);
  check("无地板时合计=桶和", noFloor.total === 1);
  const lowerFloor = computeContextBreakdown([bdMsg({ text: "x".repeat(400) })], 10);
  check("地板更低时不拉低合计", lowerFloor.total === 100);
}

// ── 汇总 ───────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 项失败 / ${passed + failures.length} 项：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ 冒烟全通过：${passed} 项断言（agent dir=${agentDir}）`);
