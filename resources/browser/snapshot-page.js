/**
 * Pi Desktop Browser — 页面快照脚本（静态 MAIN-world 脚本）。
 *
 * 由主进程读取源码文本，通过 CDP 作为 init script 注入到每个页面。
 * 安装 globalThis.__piBrowserSnapshotPage(maxElements, containingText, roleFilter, mode, query, delta)。
 *
 * 2026-09-22：本文件原在 `resources/chrome-extension/` 下（那时还靠浏览器扩展注入），
 * 现在随扩展一起退出 —— 它是**唯一**从那个目录保留下来的东西，改名为 snapshot-page.js
 * 并搬到 `resources/browser/`。**不要**把它当作浏览器扩展的一部分。
 *
 * ⚠️ 本文件必须保持**零 eval / 零 new Function** —— 这是它在
 *    `script-src 'self'`（无 'unsafe-eval'）严格 CSP 页面仍能工作的前提。
 *
 * 产出「读」视图：标题/URL/视口、可交互元素（稳定 uid + id/name + 遮挡标记）、
 * 表单字段（密码/卡号掩码）、文本片段、与上次快照的差异。
 *
 * 可见性策略（2026-09-15 依据 baidu 实测修正）：
 *  - **硬过滤**（直接从列表剔除）：display:none / visibility:hidden/collapse / opacity:0 /
 *    `[hidden]` / `[inert]` / 零尺寸 / 完全在视口外。用于挡掉「sr-only / 视觉隐藏」的假控件
 *    （如百度把内部 CSS 容器做成隐藏 `<textarea>`）。
 *  - **软标记**（保留但降序）：`occluded`（中心点被别的元素盖住）——元素可能只是滚动到视口外，
 *    仍可用（点击时会先 scrollIntoView），故不剔除，只排到后面。
 *  - 另带 `id` / `name`：无 placeholder/aria-label 的输入框（如 `#kw`）靠它才能被辨认。
 *
 * 增量（delta）：
 *  - `delta: true` 时额外返回结构化差异：元素增/删/改、字段值变、文本增/删/改、
 *    焦点/滚动/标题/URL 变化。默认关闭（不传 = 行为与旧版完全一致）。
 *  - 「无实质变化」判定**不含滚动**——自动化过程中滚动时刻在变，若把滚动算作变化，
 *    增量就永远"有变化"，省不下 token。
 *  - 筛选参数（maxElements / containingText / roleFilter）变化时不可比，直接标记
 *    `filtersChanged` 而不是硬凑差异。
 *  - ⚠️ 密码/卡号等**敏感字段完全不参与增量**（连"值变没变"都不报），避免任何
 *    与凭据相关的信息经 delta 进入模型上下文或审计日志。
 */
(() => {
  const STATE_KEY = "__PI_BROWSER_STATE__";
  const INTERACTIVE_SELECTOR =
    'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="switch"],[contenteditable="true"]';
  const SENSITIVE_RE = /password|passwd|card|cc[-_]?num|cvv|cvc|ssn|secret|token/i;
  const TEXT_SELECTOR = "h1,h2,h3,h4,th,label,button,[role=heading]";
  /** 每类差异最多列出多少条（其余只给计数）。 */
  const DELTA_CAP = 8;

  function state() {
    // docToken：每个文档一份随机前缀。uid 形如 `d7f3a1-el-13`。
    // 目的：导航到新页面后计数会从 1 重来，若 uid 是裸 `el-13`，旧页面拿到的
    // `el-13` 会在新文档里**命中另一个元素** → 静默点错目标。带 token 后旧 uid
    // 在新文档中查不到 → 直接报"uid 已失效"，逼调用方重新 browser_snapshot。
    const existing = window[STATE_KEY] || {
      docToken: "d" + Math.random().toString(36).slice(2, 8),
      nextUid: 1,
      elements: {},
      lastDigest: null,
      lastSummary: null,
    };
    window[STATE_KEY] = existing;
    return existing;
  }

  function remember(element) {
    const s = state();
    if (!element.__piUid) element.__piUid = `${s.docToken}-el-${s.nextUid++}`;
    s.elements[element.__piUid] = element;
    return element.__piUid;
  }

  /**
   * 清理已脱离 DOM 的旧元素引用。
   * 长驻页面（SPA 业务系统）反复重渲染会不断产生新元素，若只记不删，
   * `s.elements` 会无限增长（游离元素无法被 GC）。已脱离 DOM 的元素本就不可能
   * 再被操作（所有消费点都要求 `isConnected`），故可安全删除。
   */
  function pruneDetached() {
    const s = state();
    for (const uid in s.elements) {
      const el = s.elements[uid];
      if (!el || !el.isConnected) delete s.elements[uid];
    }
  }

  /** 硬过滤：true = 不可见，从列表剔除。 */
  function isHidden(element) {
    if (!element || !element.getBoundingClientRect) return true;
    if (element.hasAttribute && element.hasAttribute("hidden")) return true;
    if (element.closest && (element.closest("[hidden]") || element.closest("[inert]"))) return true;
    const style = getComputedStyle(element);
    if (style.display === "none") return true;
    if (style.visibility === "hidden" || style.visibility === "collapse") return true;
    const opacity = Number.parseFloat(style.opacity ?? "1");
    if (Number.isFinite(opacity) && opacity === 0) return true;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return true;
    if (rect.bottom < 0 || rect.right < 0) return true;
    if (rect.top > innerHeight || rect.left > innerWidth) return true;
    return false;
  }

  /** 软标记：中心点被谁盖住（null = 没被盖）。 */
  function occlusionOf(element) {
    const rect = element.getBoundingClientRect();
    const cx = Math.min(Math.max(rect.left + rect.width / 2, 0), innerWidth - 1);
    const cy = Math.min(Math.max(rect.top + rect.height / 2, 0), innerHeight - 1);
    const top = document.elementFromPoint(cx, cy);
    if (!top) return "offscreen";
    if (top === element || element.contains(top) || top.contains(element)) return null;
    return `occluded-by-${top.tagName.toLowerCase()}${top.id ? "#" + top.id : ""}`;
  }

  function rectOf(element) {
    const r = element.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  }

  function accessibleLabel(element) {
    const labelledBy = element.getAttribute && element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => (document.getElementById(id)?.innerText || ""))
        .join(" ")
        .trim();
      if (text) return text;
    }
    if (element.id) {
      try {
        const label = document.querySelector('label[for="' + CSS.escape(element.id) + '"]');
        if (label?.innerText) return label.innerText.trim();
      } catch {
        // CSS.escape 不可用时忽略
      }
    }
    const wrapping = element.closest && element.closest("label");
    const raw =
      (element.getAttribute &&
        (element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("placeholder"))) ||
      (element.innerText || "") ||
      (wrapping && wrapping.innerText) ||
      (element.value || "");
    return String(raw).replace(/\s+/g, " ").trim().slice(0, 120);
  }

  function isSensitiveField(element) {
    const type = String(element.getAttribute("type") || "").toLowerCase();
    if (type === "password") return true;
    return (
      SENSITIVE_RE.test(element.getAttribute("name") || "") ||
      SENSITIVE_RE.test(element.id || "") ||
      SENSITIVE_RE.test(element.getAttribute("autocomplete") || "")
    );
  }

  /** 只带非空字段，避免快照里塞满 undefined。 */
  function identOf(element) {
    const out = {};
    const id = element.id;
    const name = element.getAttribute && element.getAttribute("name");
    if (id) out.id = id;
    if (name) out.name = name;
    return out;
  }

  // -------------------------------------------------------------------------
  // 增量（delta）
  // -------------------------------------------------------------------------

  /** 把一次快照压成可比较的摘要（全部以 uid 为键，与列表顺序无关）。 */
  function summarize(out, filters) {
    const elements = {};
    for (const element of out.elements || []) {
      elements[element.uid] = {
        uid: element.uid,
        role: element.role || "",
        label: element.label || "",
        disabled: Boolean(element.disabled),
        occluded: element.occluded || "",
      };
    }
    const fields = {};
    for (const field of out.forms?.fields || []) {
      // ⚠️ 敏感字段（密码/卡号）**完全不进摘要**：快照本身已把它的 value 抹成 ""，
      // 这里也不再做"长度指纹"之类的推断 —— 宁可检测不到这类字段的变化，也不让
      // 任何与密码相关的信息经 delta 流进模型上下文或桥日志。
      // 这类字段的写入结果以 fill / type 工具自身的返回值（valueMatches）为准。
      if (field.valueRedacted) continue;
      fields[field.uid] = {
        uid: field.uid,
        role: field.role || "",
        label: field.label || "",
        value: String(field.value ?? ""),
      };
    }
    const snippets = {};
    for (const snippet of out.textSnippets || []) {
      snippets[snippet.uid] = { uid: snippet.uid, text: snippet.text || "" };
    }
    return {
      title: out.title || "",
      url: out.url || "",
      focused: out.summary?.focused?.uid || null,
      filters,
      scrollX: out.viewport?.scrollX ?? 0,
      scrollY: out.viewport?.scrollY ?? 0,
      elements,
      fields,
      snippets,
    };
  }

  function diffMaps(prev, next) {
    const added = [];
    const removed = [];
    const changed = [];
    for (const uid in next) if (!(uid in prev)) added.push(next[uid]);
    for (const uid in prev) if (!(uid in next)) removed.push(prev[uid]);
    return { added, removed, changed };
  }

  /** 对比两次摘要，产出结构化差异。`prev` 为空或筛选条件变化时返回首快照 / 不可比。 */
  function diffSummaries(prev, next) {
    if (!prev) return { firstSnapshot: true, substantive: true, incomparable: false };
    if (JSON.stringify(prev.filters) !== JSON.stringify(next.filters)) {
      return { firstSnapshot: false, incomparable: true, filtersChanged: true, substantive: true };
    }

    const result = {
      firstSnapshot: false,
      incomparable: false,
      substantive: false,
      counts: {},
      elementsAdded: [],
      elementsRemoved: [],
      elementsChanged: [],
      fieldsAdded: [],
      fieldsRemoved: [],
      fieldsChanged: [],
      snippetsAdded: [],
      snippetsRemoved: [],
      snippetsChanged: [],
      titleChanged: null,
      urlChanged: null,
      focusChanged: null,
      scrollChanged: prev.scrollX !== next.scrollX || prev.scrollY !== next.scrollY,
    };

    // —— 元素 ——
    const elDiff = diffMaps(prev.elements, next.elements);
    result.elementsAdded = elDiff.added.map((e) => ({ uid: e.uid, role: e.role, label: e.label, ...(e.disabled ? { disabled: true } : {}), ...(e.occluded ? { occluded: e.occluded } : {}) }));
    result.elementsRemoved = elDiff.removed.map((e) => ({ uid: e.uid, role: e.role, label: e.label }));
    for (const uid in next.elements) {
      const before = prev.elements[uid];
      if (!before) continue;
      const after = next.elements[uid];
      const notes = [];
      if (before.label !== after.label) notes.push(`标签「${before.label}」→「${after.label}」`);
      if (before.disabled !== after.disabled) notes.push(after.disabled ? "变为禁用" : "变为可用");
      if (before.occluded !== after.occluded) notes.push(after.occluded ? `被遮挡（${after.occluded}）` : "不再被遮挡");
      if (notes.length) result.elementsChanged.push({ uid: uid, text: `${after.role} ${after.label}`.trim(), notes: notes });
    }

    // —— 表单字段 ——
    const fDiff = diffMaps(prev.fields, next.fields);
    result.fieldsAdded = fDiff.added.map((f) => ({ uid: f.uid, role: f.role, label: f.label }));
    result.fieldsRemoved = fDiff.removed.map((f) => ({ uid: f.uid, role: f.role, label: f.label }));
    for (const uid in next.fields) {
      const before = prev.fields[uid];
      if (!before) continue;
      const after = next.fields[uid];
      if (before.value === after.value) continue;
      result.fieldsChanged.push({
        uid: uid,
        label: after.label || after.role,
        text: `字段值「${before.value}」→「${after.value}」`,
      });
    }

    // —— 文本片段 ——
    const sDiff = diffMaps(prev.snippets, next.snippets);
    result.snippetsAdded = sDiff.added.map((s) => ({ uid: s.uid, text: s.text }));
    result.snippetsRemoved = sDiff.removed.map((s) => ({ uid: s.uid, text: s.text }));
    for (const uid in next.snippets) {
      const before = prev.snippets[uid];
      if (!before) continue;
      const after = next.snippets[uid];
      if (before.text !== after.text) result.snippetsChanged.push({ uid: uid, from: before.text, to: after.text });
    }

    // —— 页面级 ——
    if (prev.title !== next.title) result.titleChanged = { from: prev.title, to: next.title };
    if (prev.url !== next.url) result.urlChanged = { from: prev.url, to: next.url };
    if (prev.focused !== next.focused) result.focusChanged = { from: prev.focused, to: next.focused };

    // —— 计数 + 实质变化判定（滚动不算实质变化）——
    const counts = {
      elementsAdded: result.elementsAdded.length,
      elementsRemoved: result.elementsRemoved.length,
      elementsChanged: result.elementsChanged.length,
      fieldsAdded: result.fieldsAdded.length,
      fieldsRemoved: result.fieldsRemoved.length,
      fieldsChanged: result.fieldsChanged.length,
      snippetsAdded: result.snippetsAdded.length,
      snippetsRemoved: result.snippetsRemoved.length,
      snippetsChanged: result.snippetsChanged.length,
    };
    result.counts = counts;
    let total = 0;
    for (const key in counts) total += counts[key];
    result.substantive = total > 0 || Boolean(result.titleChanged) || Boolean(result.urlChanged) || Boolean(result.focusChanged);

    // —— 截断（只影响列表长度，计数保持真实值）——
    for (const key of ["elementsAdded", "elementsRemoved", "elementsChanged", "fieldsAdded", "fieldsRemoved", "fieldsChanged", "snippetsAdded", "snippetsRemoved", "snippetsChanged"]) {
      if (result[key].length > DELTA_CAP) result[key] = result[key].slice(0, DELTA_CAP);
    }
    return result;
  }

  globalThis.__piBrowserSnapshotPage = async function snapshotPage(
    maxElements,
    containingText,
    roleFilter,
    mode,
    query,
    delta,
  ) {
    const limit = maxElements || 80;
    const needle = containingText ? String(containingText).toLowerCase() : null;
    const roleNeedle = roleFilter ? String(roleFilter).toLowerCase() : null;

    const out = {
      title: document.title,
      url: location.href,
      mode: mode || "auto",
      viewport: {
        width: innerWidth,
        height: innerHeight,
        scrollX: Math.round(scrollX),
        scrollY: Math.round(scrollY),
      },
    };

    // —— 可交互元素 ——
    const elements = [];
    for (const element of document.querySelectorAll(INTERACTIVE_SELECTOR)) {
      if (isHidden(element)) continue;
      const role = element.getAttribute("role") || element.tagName.toLowerCase();
      if (roleNeedle && role.toLowerCase() !== roleNeedle && element.tagName.toLowerCase() !== roleNeedle) continue;
      const label = accessibleLabel(element);
      if (needle && !label.toLowerCase().includes(needle)) continue;
      const occluded = occlusionOf(element);
      elements.push({
        uid: remember(element),
        role,
        tag: element.tagName.toLowerCase(),
        label,
        ...identOf(element),
        disabled: Boolean(element.disabled),
        ...(occluded ? { occluded } : {}),
        rect: rectOf(element),
        _occluded: occluded ? 1 : 0,
      });
      if (elements.length >= limit * 2) break; // 多取一些，排序后再截断
    }
    // 未被遮挡的排前面（稳定排序），再按 limit 截断。
    elements.sort((a, b) => a._occluded - b._occluded);
    for (const element of elements) delete element._occluded;
    out.elements = elements.slice(0, limit);

    // —— 表单字段（敏感值掩码）——
    const fields = [];
    for (const element of document.querySelectorAll("input,textarea,select")) {
      if (isHidden(element)) continue;
      const sensitive = isSensitiveField(element);
      fields.push({
        uid: remember(element),
        role: String(element.getAttribute("type") || element.tagName.toLowerCase()),
        label: accessibleLabel(element),
        ...identOf(element),
        value: sensitive ? "" : String(element.value ?? "").slice(0, 60),
        valueRedacted: sensitive,
        required: Boolean(element.required),
        rect: rectOf(element),
      });
      if (fields.length >= 40) break;
    }
    out.forms = { fields };

    // —— 文本片段 ——
    const snippets = [];
    for (const element of document.querySelectorAll(TEXT_SELECTOR)) {
      if (isHidden(element)) continue;
      const text = String(element.innerText || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      snippets.push({ uid: remember(element), text: text.slice(0, 160) });
      if (snippets.length >= 40) break;
    }
    out.textSnippets = snippets;

    // —— 焦点 ——
    out.summary = { focused: null };
    const active = document.activeElement;
    if (active && active !== document.body) {
      out.summary.focused = {
        uid: remember(active),
        role: (active.getAttribute && active.getAttribute("role")) || active.tagName.toLowerCase(),
        label: accessibleLabel(active),
        ...identOf(active),
      };
    }

    // —— 与上次快照的差异 ——
    // 旧字段 `diff` 保留不动（粗粒度 uid+label 序列，供既有调用方/提示语使用）；
    // 新增 `delta` 为结构化差异，仅当调用方显式传 delta=true 时返回。
    const digest = JSON.stringify(out.elements.map((e) => e.uid + "|" + e.label));
    const s = state();
    if (s.lastDigest === null) out.diff = { firstSnapshot: true };
    else out.diff = { firstSnapshot: false, changed: s.lastDigest !== digest };
    s.lastDigest = digest;

    const filters = {
      limit: limit,
      needle: needle,
      role: roleNeedle,
      mode: out.mode,
    };
    if (delta) {
      out.delta = diffSummaries(s.lastSummary, summarize(out, filters));
    }
    s.lastSummary = summarize(out, filters);

    pruneDetached();

    if (query) out.query = String(query);
    return out;
  };
})();
