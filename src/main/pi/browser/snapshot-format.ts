/**
 * Snapshot formatting — 把浏览器回传的页面快照对象渲染成 agent 友好的文本。
 *
 * 目标：低扫描成本、稳定 uid、可定位。截断上限与 pi-chrome 对齐（文本 30k 字）。
 *
 * 增量（2026-09-22）：快照脚本在 `delta:true` 时会附带结构化差异 `snapshot.delta`。
 * 此处负责两件事：
 *  1. 有变化 → 在头部之后插入「## 变化」段，让模型先看到"变了什么"再读全量清单；
 *  2. 无实质变化 → 输出**精简形态**（省略元素/字段/文本清单），只保留页面身份 +
 *     滚动/焦点 + "无变化"结论。自动化循环里"点一下看有没有反应"是最常见的调用，
 *     这一条省下的是每轮 40 个元素 + 20 个字段 + 20 段文本的 token。
 */

const MAX_TEXT_CHARS = 30_000;
const MAX_ELEMENTS_SHOWN = 40;
const MAX_FIELDS_SHOWN = 20;
const MAX_SNIPPETS_SHOWN = 20;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SnapElement {
  uid: string;
  role?: string;
  tag?: string;
  label?: string;
  id?: string;
  name?: string;
  disabled?: boolean;
  /** 中心点被遮挡时给出标记（如 `occluded-by-div#mask`），未被遮挡则缺省。 */
  occluded?: string;
  rect?: Rect;
}

interface SnapField {
  uid: string;
  role?: string;
  label?: string;
  id?: string;
  name?: string;
  value?: string;
  valueRedacted?: boolean;
  required?: boolean;
}

interface SnapSnippet {
  uid: string;
  text: string;
}

interface SnapTab {
  id?: number;
  title?: string;
  url?: string;
}

/** 由快照脚本 `delta:true` 时产出的结构化差异。 */
export interface SnapDelta {
  firstSnapshot?: boolean;
  /** 筛选条件变化导致无法与上次对比（此时不应把差异当真）。 */
  incomparable?: boolean;
  filtersChanged?: boolean;
  /** 是否有实质变化（**不含**滚动位置）。false 时渲染层可省略全量清单。 */
  substantive?: boolean;
  counts?: Record<string, number>;
  elementsAdded?: Array<{ uid: string; role?: string; label?: string; disabled?: boolean; occluded?: string }>;
  elementsRemoved?: Array<{ uid: string; role?: string; label?: string }>;
  elementsChanged?: Array<{ uid: string; text?: string; notes?: string[] }>;
  fieldsAdded?: Array<{ uid: string; role?: string; label?: string }>;
  fieldsRemoved?: Array<{ uid: string; role?: string; label?: string }>;
  fieldsChanged?: Array<{ uid: string; label?: string; text?: string }>;
  snippetsAdded?: Array<{ uid: string; text?: string }>;
  snippetsRemoved?: Array<{ uid: string; text?: string }>;
  snippetsChanged?: Array<{ uid: string; from?: string; to?: string }>;
  titleChanged?: { from: string; to: string } | null;
  urlChanged?: { from: string; to: string } | null;
  focusChanged?: { from: string | null; to: string | null } | null;
  scrollChanged?: boolean;
}

export interface BrowserSnapshot {
  title?: string;
  url?: string;
  mode?: string;
  viewport?: { width: number; height: number; scrollX: number; scrollY: number };
  summary?: { focused?: { uid: string; role?: string; label?: string } | null };
  elements?: SnapElement[];
  forms?: { fields?: SnapField[] };
  textSnippets?: SnapSnippet[];
  /** 粗粒度差异（历史字段，始终存在）。 */
  diff?: { firstSnapshot?: boolean; changed?: boolean };
  /** 结构化差异（仅 `delta:true` 时存在）。 */
  delta?: SnapDelta;
  /** `excludeOccluded:true` 时被略去的「被浮层遮挡」节点数。 */
  occludedSkipped?: number;
  tab?: SnapTab;
}

function compact(value: unknown, max = 140): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function rectText(rect: Rect | undefined): string {
  return rect ? `${rect.x},${rect.y} ${rect.width}x${rect.height}` : "?";
}

function truncate(text: string, maxChars = MAX_TEXT_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[已截断 ${text.length - maxChars} 字符]`;
}

/** 页面身份行：标题 / URL / 标签 / 视口 / 焦点。有变化与无变化两种形态共用。 */
function pushHeader(lines: string[], snapshot: BrowserSnapshot): void {
  lines.push(`# 浏览器快照${snapshot.mode ? ` (${snapshot.mode})` : ""}`);
  lines.push(snapshot.title || "(无标题)");
  if (snapshot.url) lines.push(snapshot.url);
  if (snapshot.tab?.id !== undefined) lines.push(`tab=${snapshot.tab.id}`);
  if (snapshot.viewport) {
    lines.push(
      `viewport=${snapshot.viewport.width}x${snapshot.viewport.height} scroll=${snapshot.viewport.scrollX},${snapshot.viewport.scrollY}`,
    );
  }
  if (snapshot.summary?.focused) {
    const f = snapshot.summary.focused;
    lines.push(`focused: ${f.uid} ${f.role || ""} ${compact(f.label)}`.trim());
  }
}

/** 「## 变化」段：把结构化差异渲染成可执行的信息。 */
function formatDelta(delta: SnapDelta): string[] {
  const lines: string[] = ["\n## 变化（对比上次快照）"];

  if (delta.firstSnapshot) {
    lines.push("- 这是本页面的第一次快照，没有可比基准。");
    return lines;
  }
  if (delta.incomparable) {
    lines.push("- ⚠️ 筛选条件与上次不同（maxElements / containingText / roleFilter 变了），本次差异不可比对，忽略即可。");
    return lines;
  }

  if (delta.titleChanged) lines.push(`- 标题：「${compact(delta.titleChanged.from)}」→「${compact(delta.titleChanged.to)}」`);
  if (delta.urlChanged) lines.push(`- URL：「${compact(delta.urlChanged.from)}」→「${compact(delta.urlChanged.to)}」（已跳转，旧 uid 大概率失效）`);
  if (delta.focusChanged) {
    lines.push(`- 焦点：${delta.focusChanged.from ?? "(无)"} → ${delta.focusChanged.to ?? "(无)"}`);
  }

  const counts = delta.counts ?? {};
  const count = (key: string): number => counts[key] ?? 0;

  const elementLines: string[] = [];
  for (const e of delta.elementsAdded ?? []) {
    elementLines.push(`  + 新增 ${e.uid} ${e.role || ""} ${compact(e.label, 60)}`.trimEnd());
  }
  for (const e of delta.elementsRemoved ?? []) {
    elementLines.push(`  - 消失 ${e.uid} ${e.role || ""} ${compact(e.label, 60)}`.trimEnd());
  }
  for (const e of delta.elementsChanged ?? []) {
    elementLines.push(`  ~ 变化 ${e.uid} ${compact(e.text, 60)}：${(e.notes ?? []).join("；")}`.trimEnd());
  }
  const elementTotal = count("elementsAdded") + count("elementsRemoved") + count("elementsChanged");
  if (elementTotal) {
    const listed = (delta.elementsAdded?.length ?? 0) + (delta.elementsRemoved?.length ?? 0) + (delta.elementsChanged?.length ?? 0);
    lines.push(`- 可交互元素：${elementTotal} 处变化${listed < elementTotal ? `（下列仅前 ${listed} 条）` : ""}`);
    lines.push(...elementLines);
  }

  const fieldLines: string[] = [];
  for (const f of delta.fieldsAdded ?? []) fieldLines.push(`  + 新增 ${f.uid} ${compact(f.label, 60)}`.trimEnd());
  for (const f of delta.fieldsRemoved ?? []) fieldLines.push(`  - 消失 ${f.uid} ${compact(f.label, 60)}`.trimEnd());
  for (const f of delta.fieldsChanged ?? []) fieldLines.push(`  ~ ${compact(f.label || f.uid, 60)}：${compact(f.text, 120)}`);
  const fieldTotal = count("fieldsAdded") + count("fieldsRemoved") + count("fieldsChanged");
  if (fieldTotal) {
    lines.push(`- 表单字段：${fieldTotal} 处变化`);
    lines.push(...fieldLines);
  }

  const snippetLines: string[] = [];
  for (const s of delta.snippetsAdded ?? []) snippetLines.push(`  + ${s.uid} ${compact(s.text, 100)}`);
  for (const s of delta.snippetsRemoved ?? []) snippetLines.push(`  - ${s.uid} ${compact(s.text, 100)}`);
  for (const s of delta.snippetsChanged ?? []) snippetLines.push(`  ~ ${s.uid}：「${compact(s.from, 60)}」→「${compact(s.to, 60)}」`);
  const snippetTotal = count("snippetsAdded") + count("snippetsRemoved") + count("snippetsChanged");
  if (snippetTotal) {
    lines.push(`- 文本片段：${snippetTotal} 处变化`);
    lines.push(...snippetLines);
  }

  if (!delta.substantive) {
    lines.push(
      "- **无实质变化**：元素、表单值、文本、标题、URL、焦点均与上次一致" +
        (delta.scrollChanged ? "（仅滚动位置不同）" : "") +
        "。你的上一步操作没有改变页面。",
    );
  } else if (delta.scrollChanged) {
    lines.push("- （滚动位置也有变化）");
  }
  lines.push("- 提示：密码/卡号等敏感字段不参与差异比对。");
  return lines;
}

/** 无实质变化时的精简形态：不重发整份清单，只保留页面身份与结论。 */
function formatUnchangedSnapshot(snapshot: BrowserSnapshot, delta: SnapDelta): string {
  const lines: string[] = [];
  pushHeader(lines, snapshot);
  lines.push(...formatDelta(delta));
  lines.push(
    "\n已省略元素/字段/文本清单以节省上下文（`delta:true` 且页面无变化）。" +
      "可以直接基于上一份快照里的 uid 继续操作；只有当你确实需要重新核对元素清单时，" +
      "才再调一次 browser({action:\"snapshot\"})（不传 delta）。",
  );
  return truncate(lines.join("\n"));
}

export function formatBrowserSnapshot(snapshot: BrowserSnapshot): string {
  if (!snapshot || typeof snapshot !== "object") return JSON.stringify(snapshot ?? null, null, 2);

  const delta = snapshot.delta;
  // delta 模式 + 确知无实质变化 → 走精简形态（省掉全量清单）。
  if (delta && !delta.substantive && !delta.firstSnapshot && !delta.incomparable) {
    return formatUnchangedSnapshot(snapshot, delta);
  }

  const lines: string[] = [];
  pushHeader(lines, snapshot);
  if (delta) {
    lines.push(...formatDelta(delta));
  } else if (snapshot.diff && !snapshot.diff.firstSnapshot) {
    // 历史行为：未启用 delta 时只给一个粗粒度布尔。
    lines.push(`对比上次：${snapshot.diff.changed ? "有变化" : "无粗粒度变化"}`);
  }

  const elements = snapshot.elements ?? [];
  if (elements.length) {
    lines.push("\n## 可见操作");
    for (const element of elements.slice(0, MAX_ELEMENTS_SHOWN)) {
      const ident = element.id ? `#${element.id}` : element.name ? `[name=${element.name}]` : "";
      const bits = [
        element.uid,
        element.role || element.tag,
        ident,
        element.disabled ? "disabled" : "",
        element.occluded ? `[${element.occluded}]` : "",
        compact(element.label),
      ];
      lines.push(`- ${bits.filter(Boolean).join(" ")} @ ${rectText(element.rect)}`);
    }
    if (elements.length > MAX_ELEMENTS_SHOWN) {
      lines.push(`- … 另有 ${elements.length - MAX_ELEMENTS_SHOWN} 个；用 maxElements 或 containingText 收窄`);
    }
  }
  if (snapshot.occludedSkipped) {
    // excludeOccluded 生效时告知"少看了多少"，避免模型以为清单是全集。
    lines.push(`- （excludeOccluded：已略去 ${snapshot.occludedSkipped} 个被浮层遮挡的节点）`);
  }

  const fields = snapshot.forms?.fields ?? [];
  if (fields.length) {
    lines.push("\n## 表单字段");
    for (const field of fields.slice(0, MAX_FIELDS_SHOWN)) {
      const ident = field.id ? `#${field.id}` : field.name ? `[name=${field.name}]` : "";
      const bits = [
        field.uid,
        field.role || "field",
        ident,
        field.required ? "required" : "",
        compact(field.label, 90),
        field.valueRedacted ? "value=[已掩码]" : field.value ? `value=${compact(field.value, 50)}` : "",
      ];
      lines.push(`- ${bits.filter(Boolean).join(" ")}`);
    }
  }

  const snippets = snapshot.textSnippets ?? [];
  if (snippets.length) {
    lines.push("\n## 文本片段");
    for (const snippet of snippets.slice(0, MAX_SNIPPETS_SHOWN)) {
      lines.push(`- ${snippet.uid} ${compact(snippet.text, 160)}`);
    }
  }

  lines.push(
    "\n提示：用 uid 定位元素；页面变了就重新 browser({action:\"snapshot\"}) 取新 uid。" +
      "带 [occluded-by-…] 的元素中心被遮挡（可能只是滚出视口），优先选没有该标记的；" +
      "被浮层遮挡的重复控件太多时，可传 excludeOccluded:true 直接略去它们；" +
      "无标签的输入框看 #id / [name=…]。",
  );
  return truncate(lines.join("\n"));
}
