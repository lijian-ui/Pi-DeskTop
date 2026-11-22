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
import { isDeepStrictEqual } from "node:util";

// 必须在 import 扩展之前设好：getAgentDir() 读的就是这个变量。
const agentDir = mkdtempSync(join(tmpdir(), "piwork-compress-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const mod = await import("./piwork-compress.ts");
const {
  COMPRESS_DOCTRINE,
  assignRefs,
  computeProtectedRefs,
  createSessionState,
  deriveActiveBlocks,
  deriveBlocks,
  estimateTokens,
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

// 默认探针给 90K/200K（45%）：292c071 加了低占用硬门后，不喂用量的旧断言会全部
// 被 REFUSED 吞掉真实校验信息。要测闸门/低占用/应急截断的场景都显式传 tokens。
function freshState(msgs: readonly Msg[], over: Parameters<typeof probe>[0] = { tokens: 90_000 }) {
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
  // never-preserve 语义（BC protected.ts:31-36）：bash 结果完全不进尾部保护集，
  // 只有占名额的条目（user/assistant）与最近 user 在集内。
  check(
    "bash 结果不入保护区",
    !prot.has(refs.byId.get("e48") ?? "") && !prot.has(refs.byId.get("e46") ?? "") && !prot.has(refs.byId.get("e44") ?? ""),
    [...prot].join(","),
  );
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
      "covered by active block(s) b1=m00002–m00011",
    );
  }
  // (5) 全在保护区
  {
    const { state, view } = freshState(msgs);
    const refs = state.refs;
    const tail = [...refs.byId.values()].slice(-6);
    const ok = tail.length >= 2;
    // never-preserve 语义下尾部 bash 不再受保护，最稳的「全在保护区」样本是末条 user 本身。
    checkThrows(
      "校验5 全在保护区",
      () => runCompress(state, "t1", asParams({ content: [{ startId: tail[tail.length - 1], endId: tail[tail.length - 1], summary: SUMMARY }] })),
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
  // (7) 拆对：m00049（尾部 bash 结果）的 call m00048 受保护 → 拉不进只能撤回 → 撤空报错。
  checkThrows(
    "校验7 拆对全撤光",
    () => runCompress(freshState(msgs).state, "t1", asParams({ content: [{ startId: "m00049", endId: "m00049", summary: SUMMARY }] })),
    "would split a tool call/result pair",
  );
  // 首次校验失败也要附 LIVE 可压范围（BC 硬拒同款出路）。
  {
    let msg = "";
    try {
      runCompress(freshState(msgs).state, "t1", asParams({ content: [{ startId: "m00049", endId: "m00049", summary: SUMMARY }] }));
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    check("校验7 首次失败带候选清单", msg.includes("would split") && msg.includes("Compressible ranges ("), msg.slice(0, 200));
  }
  // BC 式加宽：m00003 的 call（m00002）不在区间但可拉 → 加宽进块而不是裁掉。
  {
    const { state } = freshState(msgs);
    const r = runCompress(state, "t1", asParams({ content: [{ startId: "m00003", endId: "m00011", summary: SUMMARY }] }));
    check(
      "校验7 边界加宽警告",
      r.text.includes("Widened 1 boundary message(s) m00002") && r.text.includes("b1=m00002–m00011"),
      r.text.slice(0, 200),
    );
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
    const bad = asParams({ content: [{ startId: "m00049", endId: "m00049", summary: SUMMARY }] });
    checkThrows("死循环 第1次原错", () => runCompress(state, "t1", bad), "would split a tool call/result pair");
    checkThrows("死循环 第2次硬拒", () => runCompress(state, "t2", bad), "REJECTED");
  }
  {
    const { state } = freshState(msgs);
    const variants = [
      asParams({ content: [{ startId: "m00049", endId: "m00049", summary: SUMMARY }] }),
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
    // 熔断上限与 BC 对齐为 3（回合级、新 user 消息清零），消息里的数字跟常量走。
    check("死循环 熔断暂停", last.includes("PAUSED — 3 compress attempts already failed this turn"), last.slice(0, 120));
    check("熔断暂停带候选清单", last.includes("Compressible ranges ("), last.slice(-200));
  }
}

// ── 3.5 content 形态宽容解析（对齐 BC parseCompressInput）───────────────────
{
  const msgs = transcript(24);
  const entry = { startId: "m00002", endId: "m00011", summary: SUMMARY };
  for (const [name, content] of [
    ["单对象不包数组", entry],
    ["整数组被 JSON 化成字符串", JSON.stringify([entry])],
    ["数组元素是 JSON 字符串", [JSON.stringify(entry)]],
    ["双重嵌套字符串", JSON.stringify(JSON.stringify([entry]))],
  ] as Array<[string, unknown]>) {
    const { state } = freshState(msgs);
    const r = runCompress(state, "t1", asParams({ content }));
    check(`coerce ${name}`, r.text.includes("b1=m00002–m00011"), r.text.slice(0, 140));
  }
  checkThrows(
    "coerce 不可解析字符串给可操作报错",
    () => runCompress(freshState(msgs).state, "t1", asParams({ content: "not json" })),
    "each entry must be an object with startId, endId and summary",
  );
  // 派生重放必须走同一套 coerce，否则账本会把成功压缩误跳过。
  {
    const base = transcript(30);
    const call = assistantCall("c10", "compress", { topic: "t", content: JSON.stringify([entry]) });
    const msgs2 = [...base.slice(0, 20), call, ...base.slice(20)];
    const core2 = projectMessages(asMsgs(msgs2));
    const refs2 = assignRefs(core2);
    const blocks = deriveBlocks(core2, refs2, computeProtectedRefs(core2, refs2));
    check("coerce 结果在重放里一致", blocks.length === 1 && blocks[0].startRef === "m00002", `blocks=${blocks.length}`);
  }
}

// ── 3.6 行式条目 + 截断 JSON 抢救（对齐 BC parse-compress-input）────────────
{
  const msgs = transcript(24);
  const longSum = "定档：把 bridge 超时与重试拆开重写，5s 超时加退避重试，报错原文 ESOCKETTIMEDOUT at Bridge.send";
  // 行式：`m起-m止: 摘要`，多行时每行都必须成形
  {
    const { state } = freshState(msgs);
    const r = runCompress(state, "t1", asParams({ content: `m00002-m00011: ${longSum}` }));
    check("行式条目成活", r.text.includes("b1=m00002–m00011"), r.text.slice(0, 140));
  }
  {
    const { state } = freshState(msgs);
    const r = runCompress(
      state,
      "t1",
      asParams({ content: `m00002–m00007: ${longSum}\nm00008-m00011: ${longSum}` }),
    );
    check("行式多段都成活", r.text.includes("b1=") && r.text.includes("b2="), r.text.slice(0, 160));
  }
  // 截断 JSON：尾巴被腰斩，完整闭合的第一条照常成活
  {
    const { state } = freshState(msgs);
    const cut = `[{"startId":"m00002","endId":"m00011","summary":"${longSum}"},{"startId":"m00012","endId":"m00015"`;
    const r = runCompress(state, "t1", asParams({ content: cut }));
    check("截断 JSON 抢救成活", r.text.includes("b1=m00002–m00011"), r.text.slice(0, 140));
  }
  checkThrows(
    "行式解析失败给可操作报错",
    () => runCompress(freshState(msgs).state, "t1", asParams({ content: "just prose, no refs" })),
    "or a line like `m00005-m00012: summary`",
  );
}

// ── 3.7 salvage 全家桶（BC parse-compress-input 逐条对齐）───────────────────
{
  const msgs = transcript(24);
  const longSum = "定档：把 bridge 超时与重试拆开重写，5s 超时加退避重试，报错原文 ESOCKETTIMEDOUT at Bridge.send";
  const runOk = (name: string, content: unknown, needle = "b1=m00002–m00011"): void => {
    const { state } = freshState(msgs);
    try {
      const r = runCompress(state, "t1", asParams({ content }));
      check(`salvage ${name}`, r.text.includes(needle), r.text.slice(0, 140));
    } catch (e) {
      check(`salvage ${name}`, false, e instanceof Error ? e.message.slice(0, 140) : String(e));
    }
  };
  // 围栏包裹
  runOk("围栏 JSON", `json\n${JSON.stringify([{ startId: "m00002", endId: "m00011", summary: longSum }])}\n`.replace(/^json/, "```json") + "```");
  // 尾逗号
  runOk("尾逗号", `[{"startId":"m00002","endId":"m00011","summary":"${longSum}"},]`);
  // 字符串里裸换行（摘要折行）
  runOk("裸换行", `[{"startId":"m00002","endId":"m00011","summary":"${longSum}\n补充：下游会积压"}]`);
  // 非法转义（Windows 路径单反斜杠 → 按报错位点双写修复）
  runOk("坏转义位点修", `[{"startId":"m00002","endId":"m00011","summary":"${longSum} 见 C:\\logs\\bridge.ts"}]`);
  // 单引号 JSON
  runOk("单引号", `[{'startId':'m00002','endId':'m00011','summary':'${longSum}'}]`);
  // 截断 + 条目内尾逗号（抢救切片也走宽容解析）
  runOk("截断+条目修", `[{"startId":"m00002","endId":"m00011","summary":"${longSum}",}, {"startId":"m00012","endId":"m00015"`);
  // 行式头 + 后续行摘要（BC 原生形态）
  runOk("行式头+体", `m00002-m00011 bridge 超时改造\n## TASK\n- ${longSum}`);
  // 兄弟拼接：只含 ref 头的字符串吞并紧随无 ref 兄弟当摘要
  runOk("兄弟拼接", [`m00002-m00011 bridge 超时改造`, `## TASK\n- ${longSum}`]);
  // 顶层就是单条目（没有 content 包装）
  {
    const { state } = freshState(msgs);
    const r = runCompress(state, "t1", asParams({ startId: "m00002", endId: "m00011", summary: longSum }));
    check("salvage 顶层单条目", r.text.includes("b1=m00002–m00011"), r.text.slice(0, 140));
  }
  // 混合批次：坏条目点名跳过、好条目照常成活
  {
    const { state } = freshState(msgs);
    const r = runCompress(
      state,
      "t1",
      asParams({ content: [{ startId: "m00002", endId: "m00011", summary: longSum }, "garbage entry without refs"] }),
    );
    check("salvage 坏条目不连坐", r.text.includes("b1=m00002–m00011") && r.text.includes("Skipped 1 malformed entry"), r.text.slice(0, 200));
  }
}

// ── 3.8 清单排除块跨度内夹缝（回归：已覆盖旧范围不再上报）─────────────────
{
  const msgs = transcript(24);
  const { state } = freshState(msgs);
  runCompress(state, "t1", asParams({ content: [{ startId: "m00002", endId: "m00011", summary: SUMMARY }] }));
  // 模拟回放剔除留下的洞：账本点集只留 b1 首尾两条，idx 3..8（refs m00004–m00009）变夹缝。
  state.blocks[0].directMessageIdxs = [1, 2, 9, 10];
  let msg = "";
  try {
    const tail = [...state.refs.byId.values()].slice(-1)[0];
    runCompress(state, "t2", asParams({ content: [{ startId: tail, endId: tail, summary: SUMMARY }] }));
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  check("3.8 清单不再上报块跨度内夹缝", !msg.includes("m00004–m00009"), msg.slice(0, 240));
  check("3.8 清单仍上报正常可压范围", msg.includes("m00012–"), msg.slice(0, 240));
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

// ── 4.5 分层压实：块边界蒸馏（b 边界）──────────────────────────────────────
const mRef = (n: number) => `m${String(n).padStart(5, "0")}`;
const BIG_SUMMARY = "y".repeat(20_000); // ≈5000 token 摘要，蒸馏残留门用
const DIGEST = `MASTER DIGEST (PHASES 1-3):
- 目标演化：先修超时，后加重试，最后决定只做背压。
- 已定决策：sendToBridge 走 5s 超时，因为下游会积压；否决 per-request abort。
- 指针：notes/bridge-plan.md、server/src/bridge.ts:524。
- 踩坑：ETIMEDOUT 复现于 c1，因为 keep-alive 未复用连接。
- Open objectives: 补齐重试测试与回归用例。`;
// 供第 9 节文案黑名单复核（蒸馏相关新增文案都在模型可见路径上）。
let digestNudgeText = "";
let mergeSuccessText = "";

/** 真实排布的账本转录：每 5 组调用后紧跟一条成功的 compress（旧 compress 对就是块间夹缝）。 */
function transcriptWithBlocks(blocksCount: number, pairCount: number, summary: string = SUMMARY): Msg[] {
  const msgs: Msg[] = [user("原始需求：把 bridge 的超时与重试拆开重写，保持向后兼容。")];
  const pushPair = (k: number) => {
    msgs.push(assistantCall(`c${k}`, "bash", { command: `grep -rn x${k} src/` }));
    msgs.push(toolResult(`c${k}`, "bash", `${BIG}\n# pair ${k}`));
  };
  let ref = 2;
  for (let k = 0; k < blocksCount; k += 1) {
    for (let j = 0; j < 5; j += 1) pushPair(5 * k + j);
    msgs.push(
      assistantCall(`mc${k}`, "compress", {
        content: [{ startId: mRef(ref), endId: mRef(ref + 9), summary, topic: `Phase ${k + 1}` }],
      }),
    );
    msgs.push(toolResult(`mc${k}`, "compress", "ok"));
    ref += 10;
  }
  for (let p = blocksCount * 5; p < pairCount; p += 1) pushPair(p);
  msgs.push(user("继续下一步。"));
  return msgs;
}

{
  const msgs = transcriptWithBlocks(8, 48); // 尾部留 8 组没压的调用，8 个块都落在保护区之外
  const { state } = freshState(msgs);
  check("蒸馏前 8 块全 active", state.blocks.length === 8 && deriveActiveBlocks(state.blocks).length === 8);

  // b 边界只给摘要，不给原文：整批没有 m 条目 ⇒ MIN_RANGE_CHARS 必须豁免。
  const mergeArgs = { content: [{ startId: "b1", endId: "b3", summary: DIGEST, topic: "Phases 1-3" }] };
  const merged = runCompress(state, "tD1", asParams(mergeArgs));
  mergeSuccessText = merged.text;
  check(
    "b 边界合并成活并点名被吞块",
    merged.text.includes("b9=m00002–m00031") && merged.text.includes("Merged 3 blocks (b1, b2, b3) → b9 (G2)"),
    merged.text.slice(0, 240),
  );
  const digestBlock = state.blocks[state.blocks.length - 1];
  check("合并块 generation=2 谱系三块", digestBlock.generation === 2 && digestBlock.directBlockIds.join(",") === "b1,b2,b3");
  check(
    "合并跨度闭合（夹缝的旧 compress 对也算）",
    digestBlock.directMessageIdxs.length === 34 && digestBlock.directMessageIdxs.includes(11) && digestBlock.directMessageIdxs.includes(24),
    JSON.stringify(digestBlock.directMessageIdxs.slice(0, 3)),
  );
  check(
    "被吞块退出 active，块号不复用",
    deriveActiveBlocks(state.blocks).map((b) => b.blockId).join(",") === "b4,b5,b6,b7,b8,b9",
  );
  const kids = state.blocks.slice(0, 3);
  check(
    "合并块按「被吞块 + 被吞摘要」记账（防重复计）",
    digestBlock.compressedTokens > kids.reduce((n, b) => n + b.compressedTokens, 0),
    `${digestBlock.compressedTokens}`,
  );

  // 把合并调用写回转录：derive 重放必须重现同一套编号 / 代数 / 谱系。
  const replayMsgs = [...msgs, assistantCall("tD1", "compress", mergeArgs), toolResult("tD1", "compress", "ok")];
  const core2 = projectMessages(asMsgs(replayMsgs));
  const refs2 = assignRefs(core2);
  const replay = deriveBlocks(core2, refs2, computeProtectedRefs(core2, refs2));
  check(
    "derive 重放与工具执行同谱系",
    JSON.stringify(replay.map((b) => [b.blockId, b.generation, b.directBlockIds])) ===
      JSON.stringify(state.blocks.map((b) => [b.blockId, b.generation, b.directBlockIds])),
  );
  const { view } = freshState(replayMsgs);
  const injected = view.messages.filter((m: Msg) => (m as { customType?: string }).customType === "wc-summary");
  check("合并后只注入 6 条摘要（被吞子摘要消失）", injected.length === 6, String(injected.length));
  check("总纪要已注入视图", injected.some((m: Msg) => textOf(m).includes("MASTER DIGEST (PHASES 1-3)")));
  check("合并跨度内的原文不再进视图", !view.messages.some((m: Msg) => /# pair 3$/m.test(textOf(m))));
}

{
  // 夹缝闭合：两块之间没压过的调用，合并跨度必须一并吃掉（原文消失 ⇒ 摘要得承接它们）。
  const gapArgs = {
    content: [
      { startId: "m00002", endId: "m00011", summary: SUMMARY },
      { startId: "m00026", endId: "m00035", summary: SUMMARY },
    ],
  };
  const msgsG = [...transcript(20), assistantCall("cG", "compress", gapArgs), toolResult("cG", "compress", "ok")];
  const { state: stG, view: viewG } = freshState(msgsG);
  const gapRun = (rs: readonly { startRef: string; endRef: string }[]) =>
    rs.some((r) => Number(r.startRef.slice(1)) <= 12 && Number(r.endRef.slice(1)) >= 25);
  check("合并前夹缝是候选区间", gapRun(viewG.ranges), JSON.stringify(viewG.ranges.map((r) => `${r.startRef}–${r.endRef}`)));
  check("合并前夹缝原文可见", viewG.messages.some((m: Msg) => /# pair 8$/m.test(textOf(m))));
  const mergeArgsG = { content: [{ startId: "b1", endId: "b2", summary: DIGEST }] };
  const resG = runCompress(stG, "tG", asParams(mergeArgsG));
  check("合并跨度含夹缝", resG.text.includes("b3=m00002–m00033"), resG.text.slice(0, 200));
  const { view: viewG2 } = freshState([
    ...msgsG,
    assistantCall("tG", "compress", mergeArgsG),
    toolResult("tG", "compress", "ok"),
  ]);
  check("合并后夹缝原文从视图消失", !viewG2.messages.some((m: Msg) => /# pair 8$/m.test(textOf(m))));
  check("合并后只剩总纪要一条注入", viewG2.messages.filter((m: Msg) => (m as { customType?: string }).customType === "wc-summary").length === 1);
  check(
    "合并后夹缝不再上报为候选",
    !gapRun(viewG2.ranges),
    JSON.stringify(viewG2.ranges.map((r) => `${r.startRef}–${r.endRef}`)),
  );
}

{
  // 混批 m + b：同批成活，块序按跨度起点（合并块在前）。
  const msgs = transcriptWithBlocks(6, 40);
  const { state, view } = freshState(msgs);
  const r0 = view.ranges[0];
  const res = runCompress(
    state,
    "tMix",
    asParams({
      content: [
        { startId: r0.startRef, endId: r0.endRef, summary: SUMMARY, topic: "New tail" },
        { startId: "b1", endId: "b2", summary: DIGEST, topic: "Digest 1-2" },
      ],
    }),
  );
  const created = state.blocks.slice(state.blocks.length - 2);
  check("混批两条都成活", created.length === 2 && res.text.includes("b7=") && res.text.includes("b8="), res.text.slice(0, 200));
  check(
    "混批按跨度起点排块号（合并块拿 b7）",
    created[0].blockId === "b7" && created[0].directBlockIds.length === 2 && created[1].blockId === "b8" && created[1].directBlockIds.length === 0,
    JSON.stringify(created.map((b) => [b.blockId, b.generation])),
  );
}

{
  // 同批两条 b 跨度相交：后来的让路 + 警告（对齐 m 批内相交语义）。
  const msgs = transcriptWithBlocks(8, 48);
  const { state } = freshState(msgs);
  const res = runCompress(
    state,
    "tClash",
    asParams({
      content: [
        { startId: "b1", endId: "b3", summary: DIGEST },
        { startId: "b2", endId: "b4", summary: DIGEST },
      ],
    }),
  );
  check(
    "同批 b 跨度相交让路",
    res.text.includes("Skipped block range b2..b4") && state.blocks.length === 9,
    res.text.slice(0, 300),
  );
}

{
  // b 边界校验：失效块号报错要列 active 清单；摘要长度门照旧生效。
  const msgs = transcriptWithBlocks(8, 48);
  const { state } = freshState(msgs);
  runCompress(state, "tD1", asParams({ content: [{ startId: "b1", endId: "b3", summary: DIGEST }] }));
  const msgs2 = transcriptWithBlocks(8, 48);
  const { state: st2 } = freshState(msgs2);
  runCompress(st2, "tD1", asParams({ content: [{ startId: "b1", endId: "b3", summary: DIGEST }] }));
  checkThrows(
    "b 校验：已被并掉的块再合报错并列 active 清单",
    () => runCompress(st2, "tD2", asParams({ content: [{ startId: "b1", endId: "b2", summary: DIGEST }] })),
    "contains no active block",
  );
  {
    let msg = "";
    try {
      runCompress(st2, "tD2", asParams({ content: [{ startId: "b1", endId: "b2", summary: DIGEST }] }));
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    check("失效 bN 报错给出当前 active 块清单", msg.includes("Active blocks now: b4="), msg.slice(0, 200));
  }
  const { state: st3 } = freshState(transcriptWithBlocks(8, 48));
  checkThrows(
    "b 条目仍过摘要长度门（过短即拒）",
    () => runCompress(st3, "tD3", asParams({ content: [{ startId: "b1", endId: "b2", summary: "too short" }] })),
    "Summary too short",
  );
  const { state: st4 } = freshState(transcriptWithBlocks(8, 48));
  checkThrows(
    "m / b 混边界报错（宁准不猜）",
    () => runCompress(st4, "tD4", asParams({ content: [{ startId: "b1", endId: "m00051", summary: DIGEST }] })),
    "Mixed boundary refs",
  );
  // 热区只护自动提议：模型显式指定最近的块照样能合。
  const { state: st5 } = freshState(transcriptWithBlocks(8, 48));
  const hot = runCompress(st5, "tD5", asParams({ content: [{ startId: "b7", endId: "b8", summary: DIGEST }] }));
  check("b 边界绕过保护区与热区", hot.text.includes("b9="), hot.text.slice(0, 200));
}

// ── 5. 标签：只落 user/tool、幂等 ──────────────────────────────────────────
{
  const msgs = transcript(6);
  const { view } = freshState(msgs);
  const texts = view.messages.map((m: Msg) => ({ role: (m as { role?: string }).role ?? "", text: textOf(m) }));
  // ctx 段只出现在游标（最新一条）上，正则留可选。
  check("user 带标签", texts.filter((t) => t.role === "user").every((t) => /<wc tokens="[^"]*" type="user"(?: ctx="[^"]*")?>m\d{5}<\/wc>$/.test(t.text)));
  check("tool 带标签（type=toolName）", texts.filter((t) => t.role === "toolResult").every((t) => /<wc tokens="[^"]*" type="bash"(?: ctx="[^"]*")?>m\d{5}<\/wc>$/.test(t.text)));
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

// ── 6.5 游标油表（最新一条标签带 ctx 读数）────────────────────────────────
{
  // 剥标签正则必须兼容带 ctx 的形态，否则下轮注入会叠加重复计费。
  const ctxTagged = '正文\n\n<wc tokens="2.1K" type="user" ctx="89K/200K 45%">m00002</wc>';
  check("stripWcTag 剥得掉带 ctx 的标签", stripWcTag(ctxTagged) === "正文", stripWcTag(ctxTagged));
  check("stripWcTag 不伤普通标签", stripWcTag('正文\n\n<wc tokens="2.1K" type="user">m00002</wc>') === "正文");

  // 高压回合（120K/200K=60%，且旧段落可回收 ≥GROWTH_FLOOR=50K）→ ctx 带 ⚠compress。
  // 夹具口径：每对 HUGE ≈ 5000 token 可压，20 对去掉尾部保护区仍有 ~75K 可压。
  const { view } = freshState(transcript(20, HUGE), { tokens: 120_000 });
  const tagged = view.messages
    .map((m: Msg) => textOf(m))
    .filter((t: string) => t.includes("<wc "));
  const withCtx = tagged.filter((t: string) => t.includes(' ctx="'));
  check("整个视图只有游标一处 ctx", withCtx.length === 1, `tagged=${tagged.length} withCtx=${withCtx.length}`);
  check("ctx 挂在最后一条带标签消息上", tagged.at(-1)?.includes(' ctx="120K/200K 60%') === true, String(tagged.at(-1)?.slice(-140)));
  check("过闸门 ctx 带 ⚠compress", tagged.at(-1)?.includes("⚠compress") === true, String(tagged.at(-1)?.slice(-140)));

  // 低占用回合（20K/200K=10%）→ 有读数但不催。
  const low = freshState(transcript(2), { tokens: 20_000 });
  const lowTagged = low.view.messages.map((m: Msg) => textOf(m)).filter((t: string) => t.includes("<wc "));
  check(
    "低占用有读数无 ⚠",
    lowTagged.at(-1)?.includes(' ctx="20K/200K 10%') === true && lowTagged.at(-1)?.includes("⚠") === false,
    String(lowTagged.at(-1)?.slice(-140)),
  );

  // 教义必须教会模型读表（TAGS 段）。
  check("教义 TAGS 段写明油表", COMPRESS_DOCTRINE.includes('ctx="used/window pct"') && COMPRESS_DOCTRINE.includes("⚠compress"));
}

// ── 6.8 BC 对齐：孤儿失败封顶隐藏 / 清单预筛 / 终态计数 ─────────────────────
{
  // 失败 compress 对封顶隐藏：只留最近 2 对（ref: kernel hide-consumed.ts:13）。
  const base = transcript(24);
  const bad = (k: number): Msg[] => [
    assistantCall(`bc${k}`, "compress", { content: [] }),
    toolResult(`bc${k}`, "compress", `REJECTED ${k}: compress expects a non-empty content array`),
  ];
  const msgsBad = [...base.slice(0, 3), ...bad(1), ...bad(2), ...bad(3), ...base.slice(3)];
  const { view } = freshState(msgsBad);
  const hay = JSON.stringify(view.messages);
  check("失败调用第 1 对被封顶隐藏", !hay.includes('"bc1"'));
  check("最近两对失败对保持可见", hay.includes('"bc2"') && hay.includes('"bc3"'));

  // 清单预筛：call 失踪的 dangling result 不得混进清单——模型照单去压必被拒。
  const dangle = toolResult("zz-no-call", "bash", "orphan output with no matching call");
  const msgsD = [...base.slice(0, 12), dangle, ...base.slice(12)];
  const { state: st2, view: view2 } = freshState(msgsD);
  const dRef = st2.refs.byId.get("e12") ?? "";
  const dn = Number(dRef.slice(1));
  check(
    "dangling result 被清退",
    dRef !== "" && view2.ranges.every((r) => !(Number(r.startRef.slice(1)) <= dn && dn <= Number(r.endRef.slice(1)))),
    JSON.stringify(view2.ranges.map((r) => `${r.startRef}–${r.endRef}`)),
  );
  {
    const r0 = view2.ranges[0];
    let outText = "";
    try {
      outText = runCompress(st2, "t1", asParams({ content: [{ startId: r0.startRef, endId: r0.endRef, summary: SUMMARY }] })).text;
    } catch (e) {
      outText = e instanceof Error ? e.message : String(e);
    }
    check("清单第一条照单去压成活", outText.includes("b1="), outText.slice(0, 160));
  }

  // 终态计数：高压 + 无可压区间 + 截不动 → 连续累计；条件解除即清零。
  const st = createSessionState();
  const tiny = [user("hi"), user("bye")];
  for (let k = 0; k < 3; k += 1) refreshView(st, asMsgs(tiny), probe({ tokens: 160_000 }));
  check("终态 stuckStreak 累计到 3", st.stuckStreak === 3);
  refreshView(st, asMsgs(tiny), probe({ tokens: 10_000 }));
  check("条件解除 stuckStreak 清零", st.stuckStreak === 0);
}

// ── 6.9 蒸馏提议（D 通路）与 stuck 闸 ──────────────────────────────────────
{
  const msgs = transcriptWithBlocks(8, 40, BIG_SUMMARY); // 8 块 × ≈5000 token 摘要
  const st = createSessionState();
  const view = refreshView(st, asMsgs(msgs), probe({ tokens: 90_000 }));
  const nudge = textOf(view.messages[view.messages.length - 1] as Msg);
  digestNudgeText = nudge;
  check("D 通路提议蒸馏（摘要残留达标）", view.nudged && nudge.includes("Digest older blocks") && nudge.includes('startId: "b1"'), nudge.slice(0, 240));
  check("D 通路把热区挡在提议之外（最近 3 块不合）", nudge.includes('endId: "b5"') && !nudge.includes('endId: "b6"'), nudge.slice(0, 240));
  check("D 通路守住 nudge 措辞纪律", nudge.includes("efficiency nudge") && !/\d+(\.\d+)?\s*%\s*(of|used|context|window)/i.test(nudge));
  const again = refreshView(st, asMsgs(msgs), probe({ tokens: 90_000 }));
  check("蒸馏提议不重复刷屏（未新增块即抑制）", !again.nudged);

  // 合并发生后：块清单标出蒸馏代数，D 通路接着提议剩下的老块。
  const mergedMsgs = [
    ...msgs,
    assistantCall("tD2", "compress", { content: [{ startId: "b1", endId: "b3", summary: BIG_SUMMARY, topic: "Digest 1-3" }] }),
    toolResult("tD2", "compress", "ok"),
  ];
  const { view: v2 } = freshState(mergedMsgs);
  const nudge2 = textOf(v2.messages[v2.messages.length - 1] as Msg);
  check("块清单标出蒸馏代数 G2", nudge2.includes("b9=m00002–m00031·G2"), nudge2.slice(-300));
  check("合并后 D 通路接着提议剩余老块", nudge2.includes('startId: "b4"') && nudge2.includes('endId: "b6"'), nudge2.slice(0, 240));
  check("合并后只注入 6 条摘要", v2.messages.filter((m: Msg) => (m as { customType?: string }).customType === "wc-summary").length === 6);

  // stuck 闸：无可压区间但还能蒸馏 ⇒ 不许累计终态、不许抢先放核弹。
  const st2 = createSessionState();
  for (let k = 0; k < 3; k += 1) refreshView(st2, asMsgs(msgs), probe({ tokens: 160_000 }));
  check("还能蒸馏时不累计终态 stuck", st2.stuckStreak === 0, String(st2.stuckStreak));
  // 蒸馏残留远低于阈值（摘要很小）→ 终态照旧累计。
  const st3 = createSessionState();
  const msgsSmall = transcriptWithBlocks(8, 40, SUMMARY);
  for (let k = 0; k < 3; k += 1) refreshView(st3, asMsgs(msgsSmall), probe({ tokens: 160_000 }));
  check("蒸馏残留不达标才累计终态", st3.stuckStreak === 3, String(st3.stuckStreak));
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

  const viewResult = on.handlers.get("context")?.({ type: "context", messages: asMsgs(transcript(24)) }, fakeCtx("s-exec", 120_000)) as
    | { messages?: unknown[] }
    | undefined;
  check("context 通路返回视图", Array.isArray(viewResult?.messages) && (viewResult?.messages.length ?? 0) > 0);
  check("context 后留下快照", sessionStateFor("s-exec")?.core.length === 50);

  // 工具端到端（走 ctx 拿快照）——快照是上一步 120K/200K=60% 的回合留下的，过得了硬门。
  const execCtx = fakeCtx("s-exec", 120_000);
  const tool = on.tools[0];
  const res = (await tool.execute(
    "call-1",
    { content: [{ startId: "m00002", endId: "m00011", summary: SUMMARY }] },
    undefined,
    undefined,
    execCtx,
  )) as { content: { text: string }[] };
  check("compress 工具端到端成活", res.content[0].text.includes("▣ wc |") && res.content[0].text.includes("b1=m00002–m00011"), res.content[0].text.slice(0, 150));

  // 终态逃生（ref: BC compress.ts:1081-1084 escapeAfter=3）：连续 3 轮高压终态
  // → session_before_compact 放行内置 compact，放行即清零。
  const stuckCtx = fakeCtx("s-stuck", 160_000);
  const stuckMsgs = asMsgs([user("hi"), user("bye")]);
  const compact0 = on.handlers.get("session_before_compact")?.({ type: "session_before_compact" }, stuckCtx);
  check("未达阈值仍 cancel", (compact0 as { cancel?: boolean } | undefined)?.cancel === true);
  for (let k = 0; k < 3; k += 1) on.handlers.get("context")?.({ type: "context", messages: stuckMsgs }, stuckCtx);
  check("接线终态计数到 3", sessionStateFor("s-stuck")?.stuckStreak === 3);
  const released = on.handlers.get("session_before_compact")?.({ type: "session_before_compact" }, stuckCtx);
  check("终态放行内置 compact", released === undefined, JSON.stringify(released));
  check("放行即清零", sessionStateFor("s-stuck")?.stuckStreak === 0);

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
    // 蒸馏新增文案：D 通路 nudge + 合并成功回显
    digestNudgeText,
    mergeSuccessText,
  ].join("\n");
  check(
    "文案零残留（acp/decompress/search_context/acp_status/tier）",
    !/\b(acp|acp_status|search_context|decompress|tier)\b/i.test(modelFacing),
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

// ── 10.5 nudge 碎屑抑制 + 「压无可压」一次性提示 ────────────────────────────
{
  const longSum = "定档：把 bridge 超时与重试拆开重写，5s 超时加退避重试，报错原文 ESOCKETTIMEDOUT at Bridge.send";
  const hasText = (v: { messages: readonly Msg[] }, needle: string) =>
    v.messages.some(
      (m: Msg) => m.role === "user" && typeof m.content?.[0]?.text === "string" && m.content[0].text.includes(needle),
    );

  // 碎屑：两个内嵌 compress 调用（derive 重放 b1=m00002–m00029、b2=m00042–m00049），
  // 中间剩 5~6 对自由 BIG ≈ 5050-6060 token、单条候选。高压带里 C 通路本会催压
  // （≥5000 且增长 8K），但 max(8000, 3%×200K)=8000 不够、候选 <2 条 → 必须沉默
  // （BC 碎屑风暴教训：2K 碎屑被连拒 25 回合）。
  const crumbMsgs = transcript(24);
  crumbMsgs.splice(
    -1,
    0,
    assistantCall("ccB1", "compress", { content: [{ startId: "m00002", endId: "m00029", summary: longSum }] }),
    toolResult("ccB1", "compress", "ok"),
    assistantCall("ccB2", "compress", { content: [{ startId: "m00042", endId: "m00049", summary: longSum }] }),
    toolResult("ccB2", "compress", "ok"),
  );
  const st10 = createSessionState();
  refreshView(st10, asMsgs(crumbMsgs), probe({ tokens: 152_000 })); // firstSight 只立基线
  const vSil = refreshView(st10, asMsgs(crumbMsgs), probe({ tokens: 160_000 })); // C 带 + 增长 8K
  check("碎屑回合 nudge 沉默（<8K 且候选 <2）", !hasText(vSil, "Compressible ranges ("),
    JSON.stringify(vSil.messages.slice(-1).map((m: Msg) => (m.content?.[0]?.text ?? "").slice(0, 60))));

  // 一次性「压无可压」：b1 覆盖全部对后候选归零、占用 ≥ 地板。首拍（firstSight 立
  // 基线那一拍）就会发 —— idle 不受 firstSight 门槛限制。
  const idleMsgs = transcript(24);
  idleMsgs.splice(
    -1,
    0,
    assistantCall("ccA", "compress", { content: [{ startId: "m00002", endId: "m00049", summary: longSum }] }),
    toolResult("ccA", "compress", "ok"),
  );
  const st = createSessionState();
  const vIdle0 = refreshView(st, asMsgs(idleMsgs), probe({ tokens: 152_000 }));
  check("压无可压发一次性状态行", hasText(vIdle0, "No compressible ranges"),
    JSON.stringify(vIdle0.messages.slice(-1).map((m: Msg) => (m.content?.[0]?.text ?? "").slice(0, 60))));
  const vIdle1 = refreshView(st, asMsgs(idleMsgs), probe({ tokens: 160_000 }));
  check("第二拍起沉默", !hasText(vIdle1, "No compressible ranges"));
  // 重武装：新增 7 对后，最旧几对同时掉出「尾部 5 条名额」与「5000-token」两个窗口
  // ⇒ 真正出现候选（新 append 的内容若只在窗口内，call 全被保护、bash 结果全是孤儿，
  // computeRanges 一律丢弃 ⇒ pendingTokens 仍为 0，复位不了）。复位后压掉 → 再发一次。
  const withZ = [...idleMsgs.slice(0, -1)];
  for (let k = 100; k < 107; k += 1) {
    withZ.push(assistantCall(`c${k}`, "bash", { command: "ls" }), toolResult(`c${k}`, "bash", BIG));
  }
  withZ.push(user("再续"));
  refreshView(st, asMsgs(withZ), probe({ tokens: 165_000 })); // c100/c101 出窗 → pending>0 → 复位
  check("真候选出现时复位 idle 标记", st.idleNoticeShown === false);
  const withZC = [
    ...withZ.slice(0, -1),
    assistantCall("ccZ", "compress", { content: [{ startId: "m00050", endId: "m00055", summary: longSum }] }),
    toolResult("ccZ", "compress", "ok"),
    user("再续"),
  ];
  const vIdle3 = refreshView(st, asMsgs(withZC), probe({ tokens: 165_000 }));
  check("候选复现后重武装（归零再发一次）", hasText(vIdle3, "No compressible ranges"),
    JSON.stringify(vIdle3.messages.slice(-1).map((m: Msg) => (m.content?.[0]?.text ?? "").slice(0, 60))));
}

// ── 11. 投影增量重放（会话文件膨胀防护 P4）：增量必须 == 全量 ────────────────
// 同一份转录跑两条路，逐拍深比较：
//   · 基准：每拍现造 state（projCache 缺省 ⇒ 必然走全量 project / assignRefs / derive）；
//   · 被测：同一个 state 反复 append + 逐拍 refresh（append-only 快路径续段）。
// 核对 core / refs / 保护区 / 账本 / 视图消息 / 候选区间 / nudge 与 state 快照，并要求
// 「blocks 续段重放」真的命中过、compress 落在续段里时块序号仍然连续。
{
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000; // 钉死 createdAt / nudge 时间戳，否则深比较必然不等
  try {
    const refOf = (ordinal: number) => `m${String(ordinal).padStart(5, "0")}`;
    const bashPair = (k: number): Msg[] => [
      assistantCall(`b${k}`, "bash", { command: `grep -rn x${k} src/` }),
      toolResult(`b${k}`, "bash", `${BIG}\n# pair ${k}`),
    ];
    const compressPair = (id: string, startId: string, endId: string): Msg[] => [
      assistantCall(id, "compress", { content: [{ startId, endId, summary: SUMMARY, topic: "纪要" }] }),
      toolResult(id, "compress", `Compressed 1 range. ${startId}–${endId}`),
    ];
    // user → 5 组 bash → compress#1（m00002–m00011）→ 10 组 bash → user
    // → compress#2（m00014–m00025，正落在增量续段里）→ 6 组 bash → user → 未知 role
    const seq: Msg[] = [user("原始需求：把 bridge 的超时与重试拆开重写，保持向后兼容。")];
    for (let k = 0; k < 5; k += 1) seq.push(...bashPair(k));
    seq.push(...compressPair("cmp1", refOf(2), refOf(11)));
    for (let k = 5; k < 15; k += 1) seq.push(...bashPair(k));
    seq.push(user("继续下一步。"));
    seq.push(...compressPair("cmp2", refOf(14), refOf(25)));
    for (let k = 15; k < 21; k += 1) seq.push(...bashPair(k));
    seq.push(user("收尾。"));
    seq.push({ role: "notAKnownRole", content: "未知 role，投影直接丢弃", timestamp: 1 } as Msg);

    const probeOf = probe({ tokens: 90_000 });
    const cur: Msg[] = [];
    const live = createSessionState();
    const firstBad = new Map<string, string>();

    /** 同类不等只记第一处（逐拍上百次比较不能刷爆断言计数）。 */
    const cmp = (kind: string, label: string, ok: boolean, detail = ""): void => {
      if (ok || firstBad.has(kind)) return;
      firstBad.set(kind, `${label}${detail ? ` — ${detail}` : ""}`);
    };
    const diffAt = (a: readonly unknown[], b: readonly unknown[]): number => {
      const n = Math.max(a.length, b.length);
      for (let i = 0; i < n; i += 1) if (!isDeepStrictEqual(a[i], b[i])) return i;
      return -1;
    };
    const counters = (s: any) => ({
      usage: s.usage,
      contextWindow: s.contextWindow,
      userCount: s.userCount,
      baseline: s.baseline,
      lastNudge: s.lastNudge,
      lastBlockCount: s.lastBlockCount,
      lastDigestNudge: s.lastDigestNudge,
      failCount: s.failCount,
      repeatSig: s.repeatSig,
      repeatCount: s.repeatCount,
      stuckStreak: s.stuckStreak,
    });

    const step = (label: string): void => {
      const snapshot = Object.assign(createSessionState(), live, { projCache: undefined });
      const gView = refreshView(snapshot, asMsgs(cur.slice()), probeOf);
      const lView = refreshView(live, asMsgs(cur.slice()), probeOf);
      cmp("core", label, isDeepStrictEqual(snapshot.core, live.core), `${snapshot.core.length}/${live.core.length} @ ${diffAt(snapshot.core, live.core)}`);
      cmp("refs", label, isDeepStrictEqual(snapshot.refs, live.refs), `${snapshot.refs.byId.size}/${live.refs.byId.size}`);
      cmp("保护区", label, isDeepStrictEqual(snapshot.protectedRefs, live.protectedRefs), `${[...snapshot.protectedRefs].join(",")} vs ${[...live.protectedRefs].join(",")}`);
      cmp("账本", label, isDeepStrictEqual(snapshot.blocks, live.blocks), `${JSON.stringify(snapshot.blocks.map((b) => b.blockId))} vs ${JSON.stringify(live.blocks.map((b) => b.blockId))}`);
      cmp("视图消息", label, isDeepStrictEqual(gView.messages, lView.messages), `${gView.messages.length}/${lView.messages.length} @ ${diffAt(gView.messages, lView.messages)}`);
      cmp("候选区间", label, isDeepStrictEqual(gView.ranges, lView.ranges), `${gView.ranges.length}/${lView.ranges.length}`);
      cmp(
        "用量与nudge",
        label,
        isDeepStrictEqual(
          { u: gView.usage, p: gView.pendingTokens, n: gView.nudged, t: gView.truncated },
          { u: lView.usage, p: lView.pendingTokens, n: lView.nudged, t: lView.truncated },
        ),
      );
      cmp("state快照", label, isDeepStrictEqual(counters(snapshot), counters(live)), JSON.stringify({ g: counters(snapshot), l: counters(live) }));
    };

    // 逐条 append（compress 结果晚一拍落盘的那些拍必须 bail 回全量），每拍再补一次
    // 「同一条转录重复 refresh」—— 零增量那一拍是 blocks 续段最典型的命中场景。
    const cmp2Call = seq.findIndex((m) => m.role === "assistant" && (m.content?.[0] as any)?.id === "cmp2");
    let idsAtCmp2Call = "";
    let idsAtCmp2Result = "";
    for (let i = 0; i < seq.length; i += 1) {
      cur.push(seq[i]);
      step(`append#${i}`);
      step(`repeat#${i}`);
      if (i === cmp2Call) idsAtCmp2Call = live.blocks.map((b) => b.blockId).join(",");
      if (i === cmp2Call + 1) idsAtCmp2Result = live.blocks.map((b) => b.blockId).join(",");
    }
    const replays = live.projCache?.incrementalReplays ?? 0;

    // 分支 / rewind 一：序列变短 ⇒ 缓存作废 ⇒ 必须与一次性全量逐字段一致。
    cur.length = 12;
    step("rewind->12");
    check("§11 序列变短回退全量", (live.projCache?.incrementalReplays ?? -1) === 0, `incrementalReplays=${live.projCache?.incrementalReplays}`);

    // 分支 / rewind 二：同长度但前缀里某个对象被换掉 ⇒ 引用身份扫描必须识破。
    const branch = cur.slice();
    branch[7] = assistantCall("b99", "bash", { command: "换了条命令" });
    cur.length = 0;
    cur.push(...branch);
    step("branch 前缀换对象");
    check("§11 前缀换对象回退全量", (live.projCache?.incrementalReplays ?? -1) === 0, `incrementalReplays=${live.projCache?.incrementalReplays}`);

    // 回到完整转录：块序必须与一次性全量重放完全一致（续段的 blockIdOffset 接得上）。
    cur.length = 0;
    cur.push(...seq);
    step("full 回到完整转录");
    const ids = live.blocks.map((b) => b.blockId);

    for (const kind of ["core", "refs", "保护区", "账本", "视图消息", "候选区间", "用量与nudge", "state快照"]) {
      check(`§11 增量==全量：${kind}`, !firstBad.has(kind), firstBad.get(kind) ?? "");
    }
    check("§11 blocks 续段重放命中过", replays > 0, `incrementalReplays=${replays}`);
    check(
      "§11 块序号连续（增量段接在全量段后面）",
      idsAtCmp2Call === "b1" && idsAtCmp2Result === "b1,b2" && ids.join(",") === "b1,b2",
      `${idsAtCmp2Call} -> ${idsAtCmp2Result} -> ${ids.join(",")}`,
    );
    check(
      "§11 第二个块由增量续段产出",
      live.blocks[1]?.compressCallId === "cmp2" && live.blocks[1]?.startRef === refOf(14) && live.blocks[1]?.endRef === refOf(25),
      JSON.stringify(live.blocks[1] ?? null),
    );
  } finally {
    Date.now = realNow;
  }
}

// ── 汇总 ───────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 项失败 / ${passed + failures.length} 项：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ 冒烟全通过：${passed} 项断言（agent dir=${agentDir}）`);
