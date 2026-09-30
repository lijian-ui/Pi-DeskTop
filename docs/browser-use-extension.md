# 业务系统 Browser-Use 开发文档（pi-desktop · 模块化改造自 pi-chrome）

> 状态：**v1.4 —— 全部落地（含 managed 自建 headless Chrome）**（2026-09-14/15）
> 目标场景：**公司自有业务系统**。员工在自己日常 Chrome 里登录业务系统后，由 pi-desktop 中的 LLM **在后台静默**操作该业务系统，**过程中用户不需要盯着看**，最终只要结果。
> 关键能力要求：**LLM 必须能看到页面里的图片与文字**（即：截图 → 视觉模型，不能走纯文本方案）。
> 参考源码：`参考项目/pi-chrome/`（MIT，作者 tianrendong / Earendil Inc.，v0.15.51）。
> 依据版本：`@earendil-works/pi-coding-agent` v0.84.4（只读，勿改 `node_modules`）。
> 配套文档：`docs/pi-tool-extension-guide.md`（工具双通道机制）、`docs/im-gateway.md`（结果回传）。

### ✅ 最终使用协议（简化版 —— 日常只记这一条）

```
① 用户把网址给 LLM
② LLM browser_navigate 打开 → browser_snapshot 看页面
③ 若目标是登录页（标题/URL 含 login、或页面有二维码/密码框）
   → **系统自动**把托管 Chrome 切为可见窗口并重开该 URL（无需用户或模型额外操作）
   → 用户在弹出的橙色窗口里扫码 / 验证码登录（LLM 不碰凭据）
   → 用户确认后 LLM 调 browser_window({action:"hide"}) 切回无头
   → LLM 重新 browser_navigate 继续干活
```

- **driver 用默认的 `managed`**（自建 headless Chrome）：平时**完全不可见**，只有需要登录时才弹窗。
- **用户无需预先打开浏览器**——托管实例由主进程按需 spawn；唯一的人工动作是"扫码"。
- 代码侧已内置**登录页识别**（URL/标题/密码框/扫码文案四路信号）→ 命中即**自动弹窗**；返回里也会写明已弹出，模型无需额外提示词。
- ⚠️ **绝不把账号密码给模型**——自动化登录易触发反爬、可能锁号（OpenClaw 文档同款警告）。

> 可选增强（非必需）：`driver: "existing"`（附着员工日常 Chrome 的既有登录态）、常驻可见窗口（`managed.headless: false`）。会话搬运（cookies/localStorage 迁移）**未实现且暂不做**。**主流程只用上面这一条。**

### 实现进度（截至 2026-09-14 · 全部完成）

| 模块 | 文件 | 状态 |
|---|---|---|
| M1 桥 | `src/main/pi/browser/browser-bridge.ts` | ✅ |
| M2 扩展 | `resources/chrome-extension/{manifest.json,service_worker.js,snapshot_injected.js}` | ✅（tabs/snapshot/screenshot + CDP 输入层 + 求值/拖拽/上传） |
| M3 工具层 | `src/main/pi/browser/browser-extension.ts`（14 个 `browser_*`） | ✅ |
| M3b 快照格式化 | `src/main/pi/browser/snapshot-format.ts` | ✅ |
| M4 后台策略 | `src/main/pi/browser/background-policy.ts` | ✅ |
| M5 授权 | `src/main/pi/browser/auth.ts` | ✅（配置驱动；交互 + 无人值守） |
| M6 视觉 | `toImageContent()` 内联在 `browser-extension.ts` | ✅ |
| M7 域名围栏 | `src/main/pi/browser/policy.ts`（前置）+ 扩展 `assertUrlAllowedByPolicy`（动作发生点） | ✅ 双层 |
| M8 配置 | `src/main/pi/browser/browser-config.ts`（含 `driver`/`managed`） | ✅ |
| M9 托管 Chrome | `src/main/pi/browser/managed-chrome.ts` + `paths.ts`（自建 headless Chrome，OpenClaw 同款） | ✅ |
| M10 端口隔离 | `src/main/pi/browser/extension-variant.ts`（生成 17319 端口的扩展副本，防命令被员工浏览器抢走） | ✅ |
| 挂载 | `session-manager.ts`（两数组）+ `tool-catalog.ts`（`office`） | ✅ |
| 打包 | `electron-builder.yml` `asarUnpack` | ✅ |

### 工具清单（15 个 `browser_*`，`office` feature）

| 工具 | 作用 |
|---|---|
| `browser_status` | 桥状态自检（连接/驱动/托管状态/扩展目录/配置/授权）——排查问题先用它 |
| `browser_window` | 仅 `managed`：`show`（可见窗口，供首次登录）/`hide`（切回无头）/`status` |
| `browser_tabs` | 列出标签（选目标） |
| `browser_snapshot` | 页面文本/结构快照（uid 定位；字段掩码） |
| `browser_screenshot` | 截图 → 视觉通道（`ImageContent`） |
| `browser_click` | 按 uid/selector/坐标点击（CDP；可 `includeSnapshot`） |
| `browser_type` | 输入文本（追加；可 `pressEnter`） |
| `browser_fill` | 清空并写入（可 `submit`） |
| `browser_press_key` | 按键（Enter/Tab/Escape/箭头；可带 ctrl/alt/shift/meta） |
| `browser_hover` | 悬停触发 hover 菜单 |
| `browser_scroll` | 视口滚动 |
| `browser_navigate` | 受控标签页导航 |
| `browser_evaluate` | CDP 求值（不受页面 CSP 限制） |
| `browser_drag` | 拖拽（排序 / 拖拽上传区） |
| `browser_upload_file` | 设置 `<input type=file>` 的文件（本机绝对路径） |

> 扩展侧动作名：`tab.version` / `tab.list` / `page.snapshot` / `page.screenshot` / `page.navigate` / `page.click` / `page.hover` / `page.key` / `page.type` / `page.fill` / `page.scroll` / `page.evaluate` / `page.drag` / `page.upload`。

### 启用与测试步骤（统一测试用）

**关键路径**

| 项 | 位置 |
|---|---|
| 配置 `browser-config.json` | Windows/Linux：`~/.pi/agent/browser-config.json`；macOS：`~/Documents/PiAgent/browser-config.json`（`getAgentDir()` 读 `PI_CODING_AGENT_DIR`，macOS 被重定向） |
| 扩展目录（dev） | `<项目>/resources/chrome-extension` |
| 扩展目录（打包） | `<安装目录>/resources/app.asar.unpacked/resources/chrome-extension`（`browser_status` 会打印精确路径） |
| 主进程日志 | `<agentDir>/logs/YYYY-MM-DD.log`（打包版唯一可查通道） |
| 桥状态 | `curl http://127.0.0.1:17318/status` |

**步骤**

0. 静态检查（不跑 build）：`npx tsc -p tsconfig.node.json --noEmit` 与 `npx tsc -p tsconfig.json --noEmit` 均应 0。
1. **rebuild + 启动**（用户侧）→ 「设置 → 可用工具 → 扩展工具」应出现「浏览器操作（office）」。
2. **桥自检（不依赖扩展/LLM）**：新建任意会话后执行 `curl http://127.0.0.1:17318/status`，应返回 JSON（`mode:"server"`）。返回连接失败＝桥没起（看主进程日志）。
3. 在「设置」开启「浏览器操作（office）」→ 写入 `enabled:true`（＝知情授权）。
4. 可选：编辑 `browser-config.json` 填 `allowedDomains`（如 `["oa.example.com"]`）收紧范围。
5. **浏览器来源**（`driver`）：
   - **`managed`（默认）**：**无需手动装扩展**——pi-desktop 首次调用 `browser_*` 时会自己起 Chrome（`--load-extension` 自动加载扩展）。首次登录用 `browser_window({action:"show"})` 打开可见窗口登录，再 `hide` 切回后台。
   - **`existing`**：员工自己 Chrome → `chrome://extensions` → 开发者模式 → **加载已解压的扩展** → 选 `resources/chrome-extension`。调试扩展：点该扩展的 **「Service Worker」** 链接看 SW DevTools。
6. 再 `curl .../status` 或调 `browser_status` → `connected` 应为 `true`（managed 模式下首次工具调用后成立）。
7. 登录业务系统 → 让模型"列出可用工具"应见 15 个 `browser_*`；按 `browser_status` → `browser_tabs` → `browser_snapshot` → `browser_click(uid)` 顺序冒烟。
8. 视觉：该会话模型切到**支持视觉的模型**（gemma-3-vision / Qwen-VL 类），`browser_screenshot` 应能看到图片（managed 模式下可稳定截图）。
9. 围栏：配了 `allowedDomains` 后，操作白名单外域名应被拒。

> 静态检查：主进程 `tsc -p tsconfig.node.json --noEmit` = 0；渲染端 `tsc -p tsconfig.json --noEmit` = 0；两个扩展脚本 `node --check` = OK。

### 常见故障对照表

| 现象 | 最可能原因 | 排查入口 | 处理 |
|---|---|---|---|
| `curl /status` 连不上 | 桥没起（没建会话／主进程崩） | 主进程日志 `<agentDir>/logs/` | 新建任意会话；查日志 |
| `connected:false`（扩展已加载） | ① 扩展 SW 没在轮询 ② 桥 403 拒了来源 | ① 扩展 SW DevTools Console ② 主进程日志搜 `[browser-bridge]` | 见下两行 |
| SW Console 出现 `[pi-browser] 轮询 /next 失败` | 桥未起 / 403 / 端口被占 | 该日志的 message | `Failed to fetch`→重载扩展；403→看主进程日志 |
| SW Console **一条日志都没有** | SW 根本没跑（加载失败/被禁用） | 扩展卡片是否有红色「错误」 | 重载扩展；修扩展页报错 |
| 主进程日志 `拒绝非扩展来源 origin=… sec-fetch-site=…` | 出现了未覆盖的请求形态 | 打印的 header 值 | 把值反馈，扩展放行规则 |
| 工具列表里没有 `browser_*` | `enabled` 未开 / 旧会话 / 会话模式剔除 | 设置页「office」；`browser_status` | 开启；**新建会话**；模式切「标准」 |
| 工具报「未授权」 | `enabled:false` | `browser-config.json` | 设 `enabled:true` |
| 工具报「Chrome 扩展未连接」 | `connected:false` | `browser_status` | 见上 |
| `browser_screenshot` 模型看不到图 | 会话模型非视觉模型 | 模型设置 | 换 gemma-3-vision / Qwen-VL 类 |
| `browser_screenshot` 报 `Detached while handling command` | 页面刚导航/重载，或后台标签未渲染 | 报错原文 | 已内置 3 次重试；持续失败则设 `background:false` 前台化 |
| 点击/输入无效，返回 `input:"dom-fallback"` | CDP attach 失败或被遮挡层挡 | 返回值 `input` 字段 | 遮挡→用 `browser_press_key` 发 Tab 绕开 |
| 报「快照 uid 已失效」 | 页面已跳转或结构变了（**uid 只在当前页面内有效**，形如 `d7f3a1-el-13`，带文档随机前缀） | — | 重新 `browser_snapshot` 取新 uid |
| 越域被拒 | `allowedDomains` 不匹配 | `browser_status` 的 `allowedDomains` | 补上业务域名 |
| **命令在你自己的浏览器里执行**（没弹托管窗口） | **旧版**共用一个桥端口 → 员工 Chrome 的扩展抢走了命令 | `browser_status` 的 `bridges.existing` / `bridges.managed` 的 `clientName` | 已修：`managed` 走 17319 独立桥。确认 `managedExtensionDir` 已生成（含 `17319`） |
| 报「托管浏览器已在运行，但不是本次运行启动的」 | 上次 pi-desktop 退出时未收尾，托管窗口还开着（句柄已丢） | — | 手动关掉那个橙色「Pi 自动化」窗口后重试 |
| 登录页**没**自动弹窗 | ① 页面不像登录页（信号未命中）② 当前已是可见窗口 ③ 弹窗失败 | 该次 `browser_navigate` 返回原文 | ① 把快照贴回补信号 ② 正常 ③ 看是否上面那行 |
| 报「托管 Chrome 已启动但扩展未连上（20s 超时）」 | **Chrome 冷启动 + 首次安装 unpacked 扩展**耗时可能 >30s（尤其模式切换重启后） | 主进程日志 `[browser] 等待托管扩展首次轮询…` | **已修**：不再抛错——预热 + 命令入队（兜底超时 60s），扩展开始轮询即自动执行。首次慢属正常，第二次起为秒级 |
| 报「无法自动结束它…请手动关闭」 | 安全软件拦了自动清理（PowerShell / pkill 失败） | 主进程日志 `清理遗留托管 Chrome 失败` | 手动结束命令行含 `browser-profile` 的 `chrome.exe`（**勿按进程名全杀**，会关掉日常 Chrome） |
| `browser_window show` 弹出的是**空白页** | 切换模式会重启浏览器 → 页面丢失；旧版 show 不带 url 就直接开空白 | 返回里的 `note` | **已修**：show 未给 `url` 时自动恢复「最近访问的页面」；也可显式传 `url`。若从未访问过任何页面，则只能开空白页（先 `browser_navigate`） |
| 已看到登录窗口，返回却仍提示"调 browser_window show" | 旧版 `LOGIN_HINT` 不区分可见性 | 返回文案 | **已修**：窗口已可见时改提示"无需再 show"（`LOGIN_HINT_VISIBLE`） |
| 主进程日志 `/next 拒绝：共享密钥缺失或错误`（反复出现） | 运行中的扩展是**旧副本**（Chrome 跑的是缓存的旧 SW） | 日志 + `browser_status` 的 `connected` | **已修**：副本生成会派生 manifest version，且副本变化时**自动重启**托管 Chrome → 下一次调用自愈。若持续出现，手动关掉橙色「Pi 自动化」窗口后重新调用 |
| `browser_status` 显示 `tokenEnforced: false` | ① 该桥是 existing（本就不校验）② token 文件未生成 | `bridge.url` | ① 正常 ② 检查 `<agentDir>/browser-bridge-token` |

> 排查顺序固定为：**`browser_status`（应用内）→ 扩展 SW Console（扩展侧）→ `<agentDir>/logs/`（主进程侧）**。三层各自独立可查。

> ⚠️ **MV3 service worker 会被 Chrome 挂起**（约 30s 空闲即回收）。挂起期间命令会排在队列里，直到 alarm（30s）唤醒 SW 重新长轮询。表现＝某次工具调用偶发超时并提示「扩展在轮询但未及时取走命令…可重试」，**重试即成功**——这是 MV3 特性，非链路故障。
> 缓解措施（已内置）：alarm 收紧到 30s + 工具超时 45s（容忍一次复活）+ 扩展 `pollLoop` 失败打日志。**并发批量发多个 `browser_*` 时更容易命中**（一条等 SW 醒、其余排队），需要时串行调用。

### 可复制的冒烟指令（逐条发给模型，等出结果再发下一条）

> ⚠️ **一次只发一条**。并发批量会放大 MV3 SW 挂起导致的超时。
> ⚠️ 不带 `targetId`/`urlIncludes` 时，工具作用于**本会话专属的自动化标签页**（初始 `about:blank`），**不会碰你正在看的标签**。所以下面用 `browser_navigate` 先把自动化标签页导航到目标站点，再操作它——这样测试不会打扰你，也不用先登录业务系统。

| # | 复制这段发给模型 | 期望 | 异常信号 |
|---|---|---|---|
| 1 | `调用 browser_status，把返回的 JSON 原样贴出来。` | `connected:true`、`enabled:true`、`extension` 含 `extensionVersion` | `extension.error` 出现 → SW 挂起，**重发一次**即可 |
| 2 | `调用 browser_tabs，列出所有标签页的 id、标题、URL。` | 标签清单（`*` 标活动标签） | 报「扩展未连接」→ 去 SW Console 看 |
| 3 | `用 browser_navigate 把受控标签页导航到 https://example.com ，然后 browser_snapshot 观察它，列出可见操作及 uid。` | 标题 `Example Domain` + 一个链接的 `uid` | — |
| 4 | `在上一步页面上，用 browser_click 点击那个「More information...」链接（按 uid），带 includeSnapshot=true 确认。` | `{"input":"chrome","x":…,"y":…}` | `"input":"dom-fallback"` → CDP attach 失败或被遮挡，看 `reason` |
| 5 | `用 browser_navigate 导航到 https://www.baidu.com ，然后用 browser_fill 往搜索框（uid）填入 "pi-desktop"，最后 browser_press_key 发 Enter。` | 页面跳到搜索结果 | 输入没进去 → 检查 uid 是否失效 |
| 6 | （需视觉模型）`用 browser_screenshot 截图，并描述页面里图片的内容。` | 模型描述出图片 | 模型说看不到图 → 该会话模型不是视觉模型 |
| 7 | （需已配 `allowedDomains`）`用 browser_navigate 打开 https://www.bing.com 。` | 被拒（不在白名单） | 未被拒 → 检查 `allowedDomains` 是否为空 |

> 第 3–5 步**成功即证明"真实操作能力"成立**（尤其第 4 步返回 `input:"chrome"` ＝ CDP 输入层生效）。之后再把标题换成业务系统页、按同样节奏跑真实流程。

---

## 0. TL;DR（30 秒）

- **要什么**：员工登录业务系统 → pi-desktop 里的 LLM 后台操作它 → 结果回给员工（文本 + 必要时截图）。
- **怎么做**：移植 pi-chrome 的**三层结构** —— ① 主进程本地回环桥（HTTP `127.0.0.1:17318`）；② 员工真实 Chrome 里的 **MV3 伴侣扩展**；③ pi-desktop 的 **InlineExtension + `browser_*` 工具**。整体登记到 `tool-catalog.ts` 的 `office` feature（**该 key 已预留**）。
- **为什么不是 dsh-browser 的纯文本方案**：需求明确要"LLM 能看图片" → 必须 `Page.captureScreenshot` + 视觉模型；纯文本方案没有像素通道。
- **为什么不用 CDP 直连/无头浏览器**：业务系统要**员工的登录态**（cookie/session/SSO）→ 必须操作员工真实 profile，不能另起无头实例。
- **"用户不可见"的正确含义**：= **不抢焦点、不打断员工**（后台静默 `background` 策略），**不是**隐身。用员工自己的登录态就必然在他浏览器里操作；真正隐身只能换独立浏览器，那就丢了登录态。这一点在本项目中是**明确的取舍**（§7）。
- **移植成本**：pi-chrome 是 MIT、单文件桥（`index.ts` ~1900 行）+ 三个扩展文件；本项目只需移植桥 + 扩展 + 工具层，**改两个地方**（`extensionFactories`、`FEATURES`）。

---

## 1. 需求 → 架构决策

| # | 需求 | 技术含义 | 决策 |
|---|---|---|---|
| R1 | 员工已登录的业务系统 | cookie/session/SSO 在员工真实 Chrome profile | **伴侣扩展**驱动真实 profile；禁用无头/独立 profile |
| R2 | LLM 能看到图片 + 文字 | 需要截图通道 + 视觉模型 | `chrome_screenshot`→ CDP `Page.captureScreenshot` → 工具返回 `ImageContent` 块 |
| R3 | 过程对用户不可见 | 不抢焦点、不激活标签、不打断 | 会话级 `background` **硬策略**（默认 on），`tab.new` 用 `active:false`，截图不激活后台标签 |
| R4 | 只要结果 | 结果需要一个出口 | 走 pi-desktop 现有 **IM 网关（钉钉）** 或聊天面板回传 |
| R5 | 公司自有业务系统（可能内网/严格 CSP） | 输入要走浏览器层、绕 CSP | 输入用 **CDP Input**（`chrome.debugger`）；快照/求值用 CDP `Runtime.evaluate`（不受页面 CSP 限制） |
| R6 | 安全 / 合规 | 不能让 LLM 乱点、不能泄密 | **配置授权** + **域名白名单（主进程+扩展双层）** + **敏感字段掩码** |

> ⚠️ **设计红线**：pi-chrome 的原话是"driver 是**员工真实浏览器**、**授权后才可用**"。本项目必须保留这条——它同时是**安全边界**和**合规依据**。任何"绕过授权自动操作"的改造都不做。

---

## 2. 目标架构（三层 + 数据流）

```text
┌──────────────────────────── pi-desktop 主进程 ────────────────────────────┐
│                                                                            │
│  LLM (Agent Loop)                                                          │
│    │  调用 browser_snapshot / browser_click / browser_screenshot …         │
│    ▼                                                                       │
│  InlineExtension  browserExtension  (src/main/pi/browser/browser-extension) │
│    │  authorizedBridgeSend(action, params)                                 │
│    ▼                                                                       │
│  BrowserBridge  (src/main/pi/browser/browser-bridge.ts)                    │
│    • HTTP 服务  127.0.0.1:17318                                            │
│    • 端点 GET /status · POST /command · GET /next(长轮询) · POST /result    │
│    • 多会话：首个会话当 server，其余当 client 复用                          │
└──────────────┬─────────────────────────────────────────────────────────────┘
               │  同机回环 HTTP（长轮询）
               ▼
┌──────────────── 员工真实 Chrome（MV3 伴侣扩展）────────────────────────────┐
│  service_worker.js                                                         │
│    pollLoop() → GET /next → handleCommand() → dispatch(action)             │
│      ├─ tabs.*        chrome.tabs / chrome.tabGroups                       │
│      ├─ page.snapshot executeScript(snapshot_injected.js)  ← 文本/结构      │
│      ├─ page.*        CDP Input.dispatch*（点击/输入/滚动…）                │
│      ├─ page.screenshot CDP Page.captureScreenshot ← 图片                   │
│      └─ page.evaluate  CDP Runtime.evaluate（绕 CSP）                      │
│    → POST /result                                                          │
└──────────────┬─────────────────────────────────────────────────────────────┘
               ▼
        员工已登录的业务系统标签页（业务域名白名单内）
```

**一次工具调用的完整时序**

```
LLM → browser_click(uid="el-12")
  → browser-extension.ts: authorizedBridgeSend("page.click", {uid:"el-12"})
     → auth.requireAuthorized()          # 未授权直接抛错
     → background 策略注入 background=true
     → policy.assertUrlAllowed(tab.url)  # 域名白名单
  → BrowserBridge.send() → 入队 → 扩展 GET /next 取走
  → service_worker.dispatch("page.click") → attachDebugger → CDP Input.dispatchMouseEvent
  → POST /result { ok:true, result:{...} }
  → BrowserBridge resolve → 工具返回文本（+可选 includeSnapshot）
  → LLM 收到结果，继续下一步
```

---

## 3. 模块划分与文件布局

```
src/main/pi/browser/
├── browser-bridge.ts        # M1  主进程回环桥（HTTP，多会话 server/client）
├── browser-extension.ts     # M3  InlineExtension + 15 个 browser_* 工具 + toImageContent()
├── browser-config.ts        # M8  browser-config.json 读写（enabled/driver/managed/白名单/截图）
├── managed-chrome.ts        # M9  自建 Chrome 的启动/切换（headless↔headed）/探测可执行文件
├── extension-variant.ts     # M10 托管扩展副本（端口 17318→17319，防命令串台）
├── paths.ts                 #     扩展目录 / 托管扩展副本目录 / 托管 profile 目录（避免循环依赖）
├── background-policy.ts     # M4  后台静默策略（纯逻辑）
├── auth.ts                  # M5  授权闸门（配置驱动；交互 + 无人值守）
├── policy.ts                # M7  业务域名围栏（主进程前置校验 + wirePolicy）
└── snapshot-format.ts       # M3b 快照 → agent 文本

resources/chrome-extension/  # M2  伴侣扩展源码（随包分发，需 asarUnpack 才能被 Chrome 加载）
├── manifest.json
├── service_worker.js        # 轮询 / 派发 / CDP 输入 / 截图 / 求值 / 拖拽 / 上传
└── snapshot_injected.js     # MAIN-world 快照实现（零 eval，严格 CSP 页可用）

docs/
└── browser-use-extension.md # 本文档
```

**与 pi-chrome 源码的映射（移植对照）**

| pi-chrome 文件 | 本项目目标 | 动作 |
|---|---|---|
| `extensions/chrome-profile-bridge/index.ts`（桥 `ChromeProfileBridge` 类 300–637 行） | `src/main/pi/browser/browser-bridge.ts` | 精简移植（去掉 `/chrome` 交互命令，保留协议） |
| 同上（`registerTool` 部分 1296–1930 行） | `src/main/pi/browser/browser-extension.ts` | 改写为 `InlineExtension` + `defineTool` |
| 同上（`before_agent_start` 注入 primer 960–990 行） | 改为 `promptGuidelines`（本项目禁用 `before_agent_start` 改写，见指南 §2.3） | **改写** |
| `browser-extension/manifest.json` | `resources/chrome-extension/manifest.json` | 改名字/端口 |
| `browser-extension/service_worker.js` | `resources/chrome-extension/service_worker.js` | 近乎原样移植 |
| `browser-extension/snapshot_injected.js` | `resources/chrome-extension/snapshot_injected.js` | 原样移植 |

> ⚠️ **本项目的两条硬约束（见 `docs/pi-tool-extension-guide.md`）**：
> 1. **禁用 `before_agent_start` 改写系统提示词**（会破 prompt-cache）。pi-chrome 用它注入 primer，本项目改为 `promptSnippet` + `promptGuidelines`（静态、只在 active 时贡献）。
> 2. **不跑 build**，只跑双端 `tsc --noEmit`；实机由用户 rebuild 验证。

---

## 4. M1 — 主进程回环桥 `browser-bridge.ts`

移植 pi-chrome `ChromeProfileBridge`（`index.ts:300-637`）。职责：给扩展一个可长轮询的本地 HTTP 端点，把工具调用变成"命令入队 → 扩展取走 → 回传结果"。

```ts
// src/main/pi/browser/browser-bridge.ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface BridgeCommand { id: string; action: string; params: Record<string, unknown>; }
export interface BridgeStatus {
  url: string; mode: "server" | "client" | "starting";
  connected: boolean; lastSeenAt?: number; clientName?: string;
  queuedCommands: number; pendingCommands: number;
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  deliveredAt?: number;
};

export const BRIDGE_HOST = "127.0.0.1";
export const BRIDGE_PORT = 17318;      // 固定端口：扩展 manifest host_permissions 已写死
const DEFAULT_TIMEOUT_MS = 30_000;
const LONG_POLL_MS = 25_000;           // 扩展侧一次 /next 长轮询的等待上限

export class BrowserBridge {
  private server?: Server;
  private pending = new Map<string, Pending>();
  private queue: BridgeCommand[] = [];
  private waiters: Array<(c: BridgeCommand | undefined) => void> = [];
  private lastSeenAt?: number;
  private clientName?: string;
  private mode?: "server" | "client";

  get url(): string { return `http://${BRIDGE_HOST}:${BRIDGE_PORT}`; }

  // MV3 service worker 会随时暂停；近期轮询过即视为连接，真正健康以一次 chrome_* 调用为准
  get connected(): boolean {
    return this.lastSeenAt !== undefined && Date.now() - this.lastSeenAt < 5 * 60_000;
  }

  status(): BridgeStatus {
    return {
      url: this.url,
      mode: this.mode ?? "starting",
      connected: this.connected,
      lastSeenAt: this.lastSeenAt,
      clientName: this.clientName,
      queuedCommands: this.queue.length,
      pendingCommands: this.pending.size,
    };
  }

  async start(): Promise<void> {
    if (this.server || this.mode === "client") return;
    await this.bindServerOrClient();
  }

  // 首个 pi 会话抢到端口当 server；后来的会话 EADDRINUSE → 当 client，命令转发给 owner。
  // 这样"一个扩展 ↔ 多个 pi 会话"不需要多开端口。
  private async bindServerOrClient(): Promise<void> {
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((e) => sendJson(res, 500, { error: (e as Error).message }));
    });
    try {
      await new Promise<void>((ok, no) => {
        server.once("error", no);
        server.listen(BRIDGE_PORT, BRIDGE_HOST, () => { server.off("error", no); ok(); });
      });
      this.server = server;
      this.mode = "server";
    } catch (e) {
      server.close();
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
      this.mode = "client"; // 已有 pi 会话占着端口，复用它
    }
  }

  stop(): void {
    if (this.mode === "client") { this.mode = undefined; return; }
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("browser bridge stopped")); }
    this.pending.clear();
    this.queue = [];
    for (const w of this.waiters) w(undefined);
    this.waiters = [];
    this.server?.close();
    this.server = undefined;
    this.mode = undefined;
  }

  send(action: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const command: BridgeCommand = { id, action, params };
    return new Promise((resolveCmd, rejectCmd) => {
      if (signal?.aborted) { rejectCmd(new Error("command aborted")); return; }
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        this.queue = this.queue.filter((c) => c.id !== id);
        rejectCmd(new Error("command aborted"));
      };
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        this.pending.delete(id);
        this.queue = this.queue.filter((c) => c.id !== id);
        rejectCmd(new Error(timeoutMessage(entry, this.lastSeenAt, timeoutMs)));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => resolveCmd(v),
        reject: (e) => rejectCmd(e),
        timer,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      const waiter = this.waiters.shift();
      if (waiter) waiter(command); else this.queue.push(command);
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);

    if (req.method === "GET" && url.pathname === "/status") {
      return sendJson(res, 200, this.status());
    }

    // 本机 pi 进程 → 转发调用（仅回环来源）
    if (req.method === "POST" && url.pathname === "/command") {
      if (!isLoopbackProcess(req)) return sendJson(res, 403, { ok: false, error: "local only" });
      const body = JSON.parse((await readBody(req)) || "{}") as { action?: string; params?: Record<string, unknown>; timeoutMs?: number };
      if (!body.action) return sendJson(res, 400, { ok: false, error: "missing action" });
      try { return sendJson(res, 200, { ok: true, result: await this.send(body.action, body.params ?? {}, body.timeoutMs) }); }
      catch (e) { return sendJson(res, 504, { ok: false, error: (e as Error).message }); }
    }

    // 扩展长轮询取命令
    if (req.method === "GET" && url.pathname === "/next") {
      if (!isExtensionOrigin(req)) return sendJson(res, 403, { ok: false, error: "browser origin not allowed" });
      this.lastSeenAt = Date.now();
      this.clientName = url.searchParams.get("name") ?? undefined;
      let aborted = false;
      let active: ((c: BridgeCommand | undefined) => void) | undefined;
      req.once("close", () => { aborted = true; if (active) this.waiters = this.waiters.filter((w) => w !== active); });

      let command = this.queue.shift();
      if (!command) {
        command = await new Promise<BridgeCommand | undefined>((done) => {
          let settled = false;
          const waiter = (c: BridgeCommand | undefined) => { if (settled) return; settled = true; clearTimeout(t); this.waiters = this.waiters.filter((w) => w !== waiter); done(c); };
          const t = setTimeout(() => waiter(undefined), LONG_POLL_MS);
          this.waiters.push(waiter);
          active = waiter;
        });
      }
      if (aborted) { if (command) this.queue.unshift(command); return; }
      if (command) { const e = this.pending.get(command.id); if (e) e.deliveredAt = Date.now(); }
      return sendJson(res, 200, command ? { type: "command", command } : { type: "none" });
    }

    // 扩展回传结果
    if (req.method === "POST" && url.pathname === "/result") {
      if (!isExtensionOrigin(req)) return sendJson(res, 403, { ok: false, error: "browser origin not allowed" });
      this.lastSeenAt = Date.now();
      const r = JSON.parse((await readBody(req)) || "{}") as { id: string; ok: boolean; result?: unknown; error?: string };
      const p = this.pending.get(r.id);
      if (!p) return sendJson(res, 404, { ok: false, error: "unknown command id" });
      clearTimeout(p.timer);
      this.pending.delete(r.id);
      if (r.ok) p.resolve(r.result); else p.reject(new Error(r.error ?? "extension command failed"));
      return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { error: "not found" });
  }
}

// —— 进程级单例：桥必须全局唯一（扩展只认一个 17318） ——
export function getBrowserBridge(): BrowserBridge {
  const g = globalThis as unknown as { __piDeskBrowserBridge?: BrowserBridge };
  return (g.__piDeskBrowserBridge ??= new BrowserBridge());
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, no) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", no);
  });
}
// 扩展来源：Chrome 扩展页发的请求带 chrome-extension:// origin
function isExtensionOrigin(req: IncomingMessage): boolean {
  const origin = String(req.headers.origin ?? "");
  return origin.startsWith("chrome-extension://");
}
// 本机 pi 进程：无 origin、无 sec-fetch-site（node fetch 形态）
function isLoopbackProcess(req: IncomingMessage): boolean {
  return !req.headers.origin && !req.headers["sec-fetch-site"];
}
// 超时三分法：扩展没轮询 / 轮询了没取走 / 取走了没回传
function timeoutMessage(entry: Pending | undefined, lastSeenAt: number | undefined, ms: number): string {
  if (entry?.deliveredAt) return `Timed out after ${ms}ms: 扩展已收到命令但未返回结果（动作可能过久或回传失败）。`;
  const age = lastSeenAt === undefined ? undefined : Date.now() - lastSeenAt;
  if (age === undefined || age > 60_000) return `Timed out after ${ms}ms: 扩展未在轮询。请在员工 Chrome 加载 resources/chrome-extension。`;
  return `Timed out after ${ms}ms: 扩展在轮询但未及时取走命令，可重试或重载扩展。`;
}
```

---

## 5. M2 — Chrome 伴侣扩展（MV3）

放在 `resources/chrome-extension/`，随包分发给员工，通过企业策略/内部方式安装为 unpacked 扩展。

### 5.1 `manifest.json`

```json
{
  "manifest_version": 3,
  "name": "Pi Desktop Browser Connector",
  "version": "0.1.0",
  "description": "让 Pi Desktop 在员工已登录的 Chrome 中操作业务系统（本地回环 127.0.0.1）。",
  "permissions": [
    "tabs", "tabGroups", "scripting", "storage",
    "activeTab", "alarms", "webNavigation", "debugger"
  ],
  "host_permissions": [
    "<all_urls>",
    "http://127.0.0.1:17318/*"
  ],
  "background": { "service_worker": "service_worker.js" },
  "action": { "default_title": "Pi Desktop Browser Connector" }
}
```

> ⚠️ `debugger` 权限是 CDP 输入/截图的前提。**升级过权限的扩展，Chrome 会要求员工重新在 `chrome://extensions` 确认一次**——这一步要写进员工手册。

### 5.2 `service_worker.js`（轮询 + 派发骨架）

移植 pi-chrome `service_worker.js`。核心是 `pollLoop`（长轮询 `/next`）+ `dispatch`（按 action 路由）。

```js
// resources/chrome-extension/service_worker.js
const BRIDGE_URL = "http://127.0.0.1:17318";
const CLIENT_NAME = `Pi Desktop Connector ${chrome.runtime.id}`;
const COMMAND_TIMEOUT_MS = 25_000;
let polling = false;

async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    while (true) {
      const res = await fetch(`${BRIDGE_URL}/next?name=${encodeURIComponent(CLIENT_NAME)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`/next HTTP ${res.status}`);
      const payload = await res.json();
      if (payload.type === "command") await handleCommand(payload.command);
    }
  } catch {
    await sleep(2000);           // 桥没起来就退避重试
  } finally {
    polling = false;
  }
}

async function handleCommand(command) {
  try {
    const result = await withTimeout(dispatch(command.action, command.params ?? {}), COMMAND_TIMEOUT_MS);
    await postResult({ id: command.id, ok: true, result });
  } catch (error) {
    await postResult({ id: command.id, ok: false, error: error?.message ?? String(error) });
  }
}

function postResult(r) {
  return fetch(`${BRIDGE_URL}/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(r),
  });
}

async function dispatch(action, params) {
  switch (action) {
    // —— 页面观察（文本/结构）——
    case "page.snapshot":  return snapshotInTab(params);
    case "page.evaluate":  return evaluateInTab(params);   // CDP Runtime.evaluate，绕 CSP

    // —— 交互（CDP Input，达到 isTrusted=true，过 user-activation 门）——
    case "page.click":     return chromeInputClick(params);
    case "page.type":      return chromeInputType(params);
    case "page.fill":      return chromeInputFill(params);
    case "page.key":       return chromeInputKey(params);
    case "page.scroll":    return chromeInputScroll(params);
    case "page.hover":     return chromeInputHover(params);

    // —— 图片（视觉通道）——
    case "page.screenshot": return takeScreenshot(params);

    // —— 标签管理 ——
    case "tab.list":       return (await chrome.tabs.query({})).map(formatTab);
    case "tab.new":        return createTab(params);       // background 时 active:false
    case "tab.activate":   return activateTab(params);

    // —— 健康 ——
    case "tab.version":    return { extensionId: chrome.runtime.id, extensionVersion: chrome.runtime.getManifest().version };
    default: throw new Error(`Unknown action: ${action}`);
  }
}

// 服务启动 + 保活（MV3 worker 会被暂停）
chrome.runtime.onStartup.addListener(pollLoop);
chrome.runtime.onInstalled.addListener(pollLoop);
armKeepaliveAlarm();       // chrome.alarms 周期唤醒 → pollLoop()
pollLoop();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function withTimeout(p, ms) {
  return Promise.race([p, sleep(ms).then(() => { throw new Error(`command timed out after ${ms}ms`); })]);
}
function formatTab(t) {
  return { id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId };
}
```

### 5.3 截图（视觉通道的关键）

```js
// resources/chrome-extension/service_worker.js （续）
async function attachDebugger(tabId) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3").catch((e) => {
    if (!String(e?.message || e).includes("Another debugger is already attached")) throw e;
  });
}
function cdp(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// 关键：fromSurface + captureBeyondViewport:false，且【绝不】回退到 captureVisibleTab
// （captureVisibleTab 需要激活标签 → 违反 R3 静默要求）
async function takeScreenshot(params) {
  const tab = await resolveTargetTab(params);
  const format = params.format || "png";
  await attachDebugger(tab.id);
  const captureParams = { format, fromSurface: true, captureBeyondViewport: false };
  if (format === "jpeg" && params.quality !== undefined) captureParams.quality = params.quality;
  const { data } = await cdp(tab.id, "Page.captureScreenshot", captureParams);
  if (typeof data !== "string" || !data) throw new Error("CDP returned no screenshot data");
  return { dataUrl: `data:image/${format};base64,${data}`, method: "cdp", tab: formatTab(tab) };
}
```

### 5.4 输入（CDP，绕 iframe/shadow DOM/CSP）

pi-chrome 的 `chromeInputClick/Type/Key/…`（`service_worker.js:752-1100`）用 `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`，并按 uid → 坐标 → 命中检测（`resolveTargetInTab` + `occluderAt`）。这段**建议整段移植**，是本方案能操作复杂业务系统的核心。要点：

- 先 `page.snapshot` 拿 `uid` 与 `rect`，点击时**按 uid 重新解算坐标**（SPA 重排后坐标易过期）。
- 输入用原生 setter + 派发 `input/change` 冒泡事件（React/Vue 受控组件不还原）。
- 失败时 `domClickFallback` / `domFillFallback` 兜底（老扩展/受限页）。

### 5.5 `snapshot_injected.js`（页面快照，纯文本）

注入 MAIN world，产出：标题/URL/视口、结构布局、可交互元素（`uid` + role + label + rect）、表单字段（**密码/卡号 `valueRedacted`**）、文本片段、以及**与上次快照的 diff**。**文件内禁止 `eval/new Function`**（保证严格 CSP 页可用）。

```js
// resources/chrome-extension/snapshot_injected.js （骨架）
(() => {
  function getPiChromeState() {
    const s = window.__PI_CHROME_STATE__ || { nextElementUid: 1, elements: {}, lastSnapshotDigest: null };
    window.__PI_CHROME_STATE__ = s;
    return s;
  }
  function rememberElement(el) {
    const s = getPiChromeState();
    if (!el.__piChromeUid) el.__piChromeUid = "el-" + s.nextElementUid++;
    s.elements[el.__piChromeUid] = el;
    return el.__piChromeUid;
  }
  function isElementVisible(el) { /* 见 pi-chrome 源码：getComputedStyle + getBoundingClientRect */ }
  function accessibleLabel(el) { /* aria-labelledby → label[for] → aria-label/title/placeholder */ }
  // …构建 { title,url,viewport,summary,elements,forms,textSnippets,diff } 并 return
})();
```

---

## 6. M3 — LLM 工具层 `browser-extension.ts`

按本项目规范：`InlineExtension` + `defineTool`，元数据走 `promptSnippet` / `promptGuidelines`（**不用** `before_agent_start`）。

```ts
// src/main/pi/browser/browser-extension.ts
import { Type } from "typebox";
import { defineTool, type AgentToolResult, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { getBrowserBridge } from "./browser-bridge";
import { readBrowserConfigSync } from "./browser-config";
import { requireAuthorized, isAuthorized } from "./auth";
import { effectiveBackground } from "./background-policy";
import { assertUrlAllowed } from "./policy";
import { formatSnapshot } from "./snapshot-format";
import { toImageContent } from "./vision";

type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image"; data: string; mimeType: string };

const TIMEOUT_MS = 30_000;

// 统一的"授权 + 后台策略 + 域名围栏"出口：所有工具都必须走这里
async function send(action: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  requireAuthorized();                                   // M5：未授权即抛错
  const cfg = readBrowserConfigSync();
  const background = effectiveBackground(params as { background?: boolean; foreground?: boolean }, cfg.background);
  if (action === "tab.activate" && background) {
    throw new Error("后台静默模式下禁止激活标签（需员工运行「关闭静默」）。");
  }
  return getBrowserBridge().send(action, { ...params, background, foreground: !background }, TIMEOUT_MS, signal);
}

export const browserExtension: InlineExtension = {
  name: "browser",
  factory: (pi) => {
    if (!readBrowserConfigSync().enabled) return;        // 总开关关 → 不注册任何工具
    void getBrowserBridge().start();                     // 幂等：桥只起一次

    pi.registerTool(defineTool({
      name: "browser_snapshot",
      label: "浏览器快照",
      description:
        "观察员工已登录 Chrome 中当前业务系统页面：标题/URL、结构布局、可见操作、表单字段、" +
        "以及相对上次快照的变化。用 uid 定位元素（优先 uid 而非坐标）。",
      promptSnippet:
        "Observe the employee's logged-in business-system tab: layout, visible actions, forms, stable uids, and changes since the last snapshot.",
      promptGuidelines: [
        "操作业务系统前，先用 browser_snapshot 观察页面、拿到元素 uid；点击/输入一律传 uid，不要猜坐标。",
        "browser_snapshot 默认只返回受控标签页，不会碰员工当前正在看的标签；需要指定页时传 targetId/urlIncludes。",
      ],
      parameters: Type.Object({
        targetId: Type.Optional(Type.String()),
        urlIncludes: Type.Optional(Type.String()),
        mode: Type.Optional(Type.Union([
          Type.Literal("auto"), Type.Literal("interactive"), Type.Literal("forms"),
          Type.Literal("pageMap"), Type.Literal("text"), Type.Literal("changes"), Type.Literal("full"),
        ])),
        query: Type.Optional(Type.String({ description: "按自然语言找元素，如 '提交按钮'、'审批'。" })),
        containingText: Type.Optional(Type.String()),
      }, { additionalProperties: false }),
      execute: async (_id, params, signal): Promise<AgentToolResult<unknown>> => {
        const snap = await send("page.snapshot", params, signal);
        return { content: [{ type: "text", text: formatSnapshot(snap) }], details: { snapshot: snap } };
      },
    }));

    pi.registerTool(defineTool({
      name: "browser_click",
      label: "浏览器点击",
      description: "在业务系统页面点击一个元素（按 browser_snapshot 返回的 uid）。可选择点击后立即附带新快照以确认结果。",
      promptSnippet: "Click an element by uid in the controlled business-system tab (CDP input, works through iframes/shadow DOM).",
      promptGuidelines: [
        "browser_click 传 uid（来自最近一次 browser_snapshot）；uid 过期就重新 browser_snapshot，不要盲目重试。",
        "点击后如结果不确定，用 includeSnapshot=true 在同一轮确认页面变化，而不是重复点击。",
      ],
      parameters: Type.Object({
        uid: Type.Optional(Type.String()),
        selector: Type.Optional(Type.String()),
        x: Type.Optional(Type.Number()),
        y: Type.Optional(Type.Number()),
        includeSnapshot: Type.Optional(Type.Boolean()),
        targetId: Type.Optional(Type.String()),
      }, { additionalProperties: false }),
      execute: async (_id, params, signal): Promise<AgentToolResult<unknown>> => {
        const result = await send("page.click", params, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: { result } };
      },
    }));

    pi.registerTool(defineTool({
      name: "browser_type",
      label: "浏览器输入",
      description: "向业务系统的输入框/文本域输入文本（按 uid）。replace=true 先清空。写入走原生 setter，React/Vue 受控组件不会还原。",
      promptSnippet: "Type into a business-system field by uid (framework-safe native setter + bubbling events).",
      promptGuidelines: ["browser_type 输入前先用 browser_snapshot 确认字段 uid 与当前值；提交类操作后务必核对页面反馈。"],
      parameters: Type.Object({
        uid: Type.Optional(Type.String()),
        text: Type.String({ maxLength: 4000 }),
        replace: Type.Optional(Type.Boolean()),
        targetId: Type.Optional(Type.String()),
      }, { additionalProperties: false }),
      execute: async (_id, params, signal): Promise<AgentToolResult<unknown>> => {
        const result = await send("page.type", params, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: { result } };
      },
    }));

    // ── 视觉通道：截图直接作为 image 块返回给模型（SDK 支持 content: (Text|Image)[]）──
    pi.registerTool(defineTool({
      name: "browser_screenshot",
      label: "浏览器截图",
      description:
        "对业务系统页面截图并通过视觉通道返回给模型（图片 + 文字）。用于需要看图表/图片/版式的场景。" +
        "默认不激活后台标签（静默模式）。",
      promptSnippet: "Capture the controlled business-system tab and return the image to the model (no tab activation in background mode).",
      promptGuidelines: [
        "当业务系统内容包含图片、图表、验证码位、或需要确认版式时，用 browser_screenshot 看实际渲染结果。",
        "优先用 browser_snapshot 做结构定位与点击；截图仅用于视觉确认，不作为定位坐标的手段。",
      ],
      parameters: Type.Object({
        targetId: Type.Optional(Type.String()),
        format: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg")])),
        quality: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
        fullPage: Type.Optional(Type.Boolean()),
      }, { additionalProperties: false }),
      execute: async (_id, params, signal): Promise<AgentToolResult<unknown>> => {
        const r = await send("page.screenshot", params, signal) as { dataUrl?: string; dimensions?: unknown };
        if (!r.dataUrl) throw new Error("截图失败：扩展未返回 dataUrl");
        const image = toImageContent(r.dataUrl);            // → { type:"image", data, mimeType }
        const content: (TextBlock | ImageBlock)[] = [
          { type: "text", text: "已捕获当前业务系统截图（见附图）。" },
          image,
        ];
        return { content, details: { dimensions: r.dimensions } };
      },
    }));

    pi.registerTool(defineTool({
      name: "browser_evaluate",
      label: "浏览器求值",
      description: "在业务系统页面 MAIN world 执行表达式（CDP Runtime.evaluate，不受页面 CSP 限制）。用于精确读取 DOM/状态。",
      promptSnippet: "Evaluate an expression in the business-system tab's MAIN world via CDP (bypasses page CSP).",
      promptGuidelines: ["browser_evaluate 只做读取与必要的最小写入；表达式返回 null 时用 JSON.stringify 包裹确认。"],
      parameters: Type.Object({
        expression: Type.String({ maxLength: 4000 }),
        targetId: Type.Optional(Type.String()),
      }, { additionalProperties: false }),
      execute: async (_id, params, signal): Promise<AgentToolResult<unknown>> => {
        const result = await send("page.evaluate", params, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: { result } };
      },
    }));
  },
};
```

> **工具命名**：建议统一 `browser_*`（不用 `chrome_*`，避免与"浏览器扩展"混淆、也避免与未来内置工具撞名）。若要与 pi-chrome 保持可对照，可保留 `chrome_*`——二选一，全项目统一。

---

## 7. M4 — 后台静默策略 `background-policy.ts`

"用户不可见"的落点。默认 **on（硬策略）**：禁一切显式聚焦/激活；工具**无法**用参数覆盖。

```ts
// src/main/pi/browser/background-policy.ts
export interface BackgroundParams { background?: boolean; foreground?: boolean }

/**
 * 计算本次调用是否走后台。
 * - 会话锁 background=true 时：硬策略，忽略调用方的 background:false / foreground:true。
 * - 会话未锁时：允许调用方显式 background:true。
 */
export function effectiveBackground(params: BackgroundParams, sessionBackgroundOn: boolean): boolean {
  const requested = params.background ?? (params.foreground !== undefined ? !params.foreground : false);
  return sessionBackgroundOn || requested;
}
```

配套（扩展侧，移植 pi-chrome）：
- `tab.new` 在 background 时用 `active:false`，且自动化窗口 `focused:false`。
- `tab.activate` 在 background 时**直接报错**（不是静默忽略）。
- 截图走 CDP，**失败也不回退** `captureVisibleTab`（那需要激活）。
- 长轮询期间不主动 `chrome.windows.update({focused:true})`。

> **边界（务必写进产品说明）**：这是"**不主动抢焦点**"，不是 OS 级沙箱。页面脚本 `window.open` / `window.focus`、调试黄条、原生弹窗仍可能改变焦点；后台标签的定时器/渲染可能被节流，**剪贴板/全屏/文件选择器等 focus-gated 流程可能失败**。

---

## 8. M5 — 授权 `auth.ts`（配置驱动）

**安全边界 + 合规依据**。pi-chrome 用每会话限时的 `/chrome authorize`；但**本项目的扩展 slash command 不执行**（`pi.registerCommand` 只展示不跑），所以 M0 采用**配置驱动授权**：

| 会话类型 | 放行条件（全部满足） |
|---|---|
| 交互（普通/空间） | `browser-config.json` `enabled: true` —— 即员工在「设置 → 可用工具」开启「浏览器操作（office）」，视为**知情授权** |
| 无人值守（定时任务） | `enabled: true` **且** `allowUnattended: true` **且** `allowedDomains` **非空** |

```ts
// src/main/pi/browser/auth.ts
export function assertBrowserAuthorized(unattended: boolean, cfg: BrowserConfig): void {
  if (!cfg.enabled) {
    throw new Error("浏览器控制未授权。请先在「设置 → 可用工具」开启「浏览器操作（office）」，或在 browser-config.json 设 enabled=true。");
  }
  if (!unattended) return;
  if (!cfg.allowUnattended) throw new Error("无人值守浏览器操作未开启。请设 allowUnattended=true 并填写 allowedDomains。");
  if (cfg.allowedDomains.length === 0) throw new Error("无人值守浏览器操作必须配置 allowedDomains，否则拒绝执行。");
}
```

> **权衡（如实说明）**：配置驱动 = 一旦开启，**该机器上所有会话**都可控浏览器，直到员工关掉。代价是没有 pi-chrome 那种"每会话限时授权"。
> 缓解：默认 `enabled: false`（关）；域名白名单约束范围；设置页可见开关状态。
>
> ⏳ **待接线增强**：按会话限时的 `/browser authorize`（`globalThis` 存 `until`）需要走 IPC 五落盘点（渲染端按钮 → 主进程），留作后续里程碑。

---

## 9. 业务域名围栏 `policy.ts`（双层执行）

pi-chrome 默认不限制域名（它面向开发者自用）。**公司场景必须加围栏**。规则：黑名单优先；白名单非空时只允许白名单（支持 `example.com` 与 `*.example.com`）。

**双层**——主进程做前置校验，扩展在**动作发生点**再校验一次（扩展才知道目标标签的真实 URL；它是纯 JS，无法共享 TS 文件，故各写一份）：

```ts
// src/main/pi/browser/policy.ts（主进程侧）
export function assertUrlAllowed(url: string | undefined, cfg: BrowserConfig): void {
  const host = hostOf(url);
  if (!host) return;                                   // about:blank 等放行
  if (cfg.blockedDomains.some((d) => hostMatches(host, d))) throw new Error(`域名 ${host} 在黑名单内，拒绝操作。`);
  if (cfg.allowedDomains.length > 0 && !cfg.allowedDomains.some((d) => hostMatches(host, d)))
    throw new Error(`域名 ${host} 不在业务系统白名单内，拒绝操作。`);
}
export function wirePolicy(cfg: BrowserConfig): WirePolicy {          // 随每次命令下发给扩展
  return { allowedDomains: cfg.allowedDomains, blockedDomains: cfg.blockedDomains };
}
```

```js
// resources/chrome-extension/service_worker.js（扩展侧，动作发生点）
async function resolveTargetTab(params) {
  const tab = await resolveTargetTabRaw(params);
  assertUrlAllowedByPolicy(tab?.url, params?.policy);   // 任何动作解析出真实标签后立即过围栏
  return tab;
}
// navigateInTab 还会额外对目标 URL 过围栏（防止把标签导航到白名单外）
```

快照/表单里的**密码框、卡号**默认 `valueRedacted`（判断 `type=password` 与 name/id/autocomplete 敏感词）。**这一条不许改松**。

> ⏳ 未做（无对应工具，非遗漏）：`redactHeaders`（网络 header 脱敏）——本项目**没有**网络/控制台观察工具，故不引入该字段（避免死配置）。将来加 `browser_network_requests` 时一并补上并默认开启脱敏。
>
> ⚠️ 已知边界：`allowedDomains` 限制**操作**（导航/点击/输入/截图），不限制 `browser_tabs` 的**列表**——`browser_tabs` 会返回员工全部标签的标题/URL。若贵司要求连列表都收窄，可在扩展侧对 `tab.list` 按策略过滤（需权衡"模型找不到业务标签页"的风险）。

---

## 10. 视觉通道（内联 `toImageContent`）

需求 R2 的落点。pi-chrome 的 `chrome_screenshot` 只把图存盘返回路径——**面向文本模型**。本项目要**直接把图片作为 `ImageContent` 返回**，让视觉模型看到。

```ts
// src/main/pi/browser/browser-extension.ts（内联，未单独建 vision.ts）
export type ImageContentLike = { type: "image"; data: string; mimeType: string };

/** "data:image/png;base64,AAAA…" → { type:"image", data:"AAAA…", mimeType:"image/png" } */
export function toImageContent(dataUrl: string): ImageContentLike {
  const comma = dataUrl.indexOf(",");
  const meta = comma >= 0 ? dataUrl.slice(0, comma) : "";
  const data = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const mimeType = /data:(image\/[a-z0-9.+-]+)/i.exec(meta)?.[1] ?? "image/png";
  return { type: "image", data, mimeType };
}
```

**依据**：SDK 的 `AgentToolResult.content` 类型为 `(TextContent | ImageContent)[]`
（`node_modules/.../pi-agent-core/dist/types.d.ts:317`），`ImageContent = { type:"image", data:<裸 base64>, mimeType }`。
项目内已有同款形态：`src/renderer/utils/image.ts`（去 `data:` 前缀）、IM 适配器 `dingtalk-adapter.ts:301` / `feishu-adapter.ts:233`。

**模型前提**：需要给该会话选一个**支持视觉的模型**（如 gemma-3-vision / Qwen-VL 类）。纯文本模型收到 image 块会报错或被忽略——**这是配置项，不是代码能兜的**。

**可选后处理**：截图前 `browser_viewport_resize`（pi-chrome 有），或压缩 base64（复用 `src/renderer/utils/image.ts:70` 的 lossy 压缩思路，但注意它在渲染端，主进程需另写一份）。

---

## 11. M8 — 配置与开关 `browser-config.ts`

```ts
// src/main/pi/browser/browser-config.ts（实际实现）
export interface BrowserConfig {
  enabled: boolean;                    // 总开关。默认 **false**（安全默认）
  driver: "managed" | "existing";      // 浏览器从哪来。默认 **managed**
  managed: {                           // driver=managed 的启动参数
    headless: boolean;                 //   true = --headless=new（不可见）；false = 可见窗口（首次登录）
    executablePath: string;            //   Chrome/Edge 绝对路径；空 = 自动探测
    extraArgs: string[];               //   追加启动参数
  };
  background: boolean;                 // 默认 true = 后台静默（不抢焦点）
  allowUnattended: boolean;            // 定时任务是否允许浏览器操作（需 + 非空白名单）
  allowedDomains: string[];            // 业务域名白名单（空 = 不限制）
  blockedDomains: string[];
  screenshot: { enabled: boolean; format: "png" | "jpeg"; quality: number };
}
```

**`driver` 两种模式（本质差异＝登录态从哪来）**

| | `managed`（默认，OpenClaw 同款） | `existing` |
|---|---|---|
| 浏览器 | pi-desktop **自建** Chrome（`--user-data-dir=<agentDir>/browser-profile` + `--load-extension`） | 员工**日常** Chrome + 手动加载扩展 |
| 过程可见性 | **完全不可见**（`--headless=new`，无窗口） | 员工能看到标签在动 |
| 截图/看图 | **稳定**（headless 渲染正常） | 后台标签不可靠，需 `background:false` 前台化 |
| 登录态 | 需在该 profile 里**单独登录一次** | 直接复用员工已登录 |
| 反爬 | headless 可能被识别 | 真实浏览器，风险最低 |

**两种交互模式（都支持，默认 A）**

| 模式 | 配置 | 效果 |
|---|---|---|
| **A 真·无窗口（默认）** | `managed.headless: true` + `browser_window({action:"show"/"hide"})` | show 出窗口登录 → hide 切无头干活；完全不可见、截图稳。代价：切换会重启浏览器、页面重置，需重新导航 |
| **B 常驻可见窗口** | `managed.headless: false` | 托管 Chrome 一直开着，员工登录后 agent 在同一窗口干活；无切换开销、页面连续，但用户可能看到操作 |

> **窗口标识**（移植 OpenClaw `chrome.profile-decoration.ts`）：每次启动前写 `<profile>/Local State` 与 `<profile>/Default/Preferences`，把托管 profile 命名为 **「Pi 自动化」** 并染成**橙色**——员工一眼区分"这是自动化浏览器"，不会误在自己日常 Chrome 里乱操作。同时写 `exit_type=Normal` 清掉上次 kill 的"异常退出"标记，避免 show/hide 重启后弹「恢复页面？」气泡。**全部 best-effort**（Chrome pref 键各版本不一，失败不影响启动）。

> OpenClaw 的对应做法（`docs/tools/browser-login.md` 原文）：托管 profile 命名 `openclaw`、**orange-tinted UI**；员工「①让 agent 打开浏览器后自己登录 ②用 CLI `openclaw browser start` / `browser open <url>`」；**绝不把凭据给模型**（自动化登录易触发反爬/锁号）。本项目采用其①。

**桥端口隔离（必须，勿改）**

| 驱动 | 桥端口 | 扩展来源 |
|---|---|---|
| `managed` | **17319** | 托管 Chrome 里的**扩展副本**（`extension-variant.ts` 从 `resources/chrome-extension` 复制生成，复制时把 `17318` 改写成 `17319`） |
| `existing` | **17318** | 员工日常 Chrome 里手动加载的扩展 |

```
托管实例  ──扩展副本(17319)──► getManagedBrowserBridge()
员工日常  ──扩展(17318)──────► getBrowserBridge()
```

> ⚠️ **为什么必须双端口**：若两者共用一个端口，员工日常 Chrome 里那个早期加载的扩展会与托管扩展**争抢同一批命令**（`/next` 谁先长轮询谁取走）→ 表现为"**命令在员工自己的浏览器里执行**"。物理隔离端口后，`managed` 只与托管实例通信。
>
> 之前的 `scripts/pi-automation-browser.bat`（员工自助启动托管浏览器）**已移除**：它启动的实例用的是未改端口的扩展、且与绑定端口的语义冲突。主流程不再需要它——`browser_navigate` 撞到登录页会自动弹窗。

**共享密钥（token）—— 阻止本机其它进程直接驱动浏览器**

回环端口（`127.0.0.1`）对本机**任何**进程开放，而原先的两道校验对**普通程序**全部放行：

| 校验 | 规则 | 对 curl/node/python/任意 exe |
|---|---|---|
| `isLoopbackProcess` | 「无 `Origin` 且无 `sec-fetch-site`」 | **放行**（它们本来就不带这两个头） |
| `isBrowserOriginAllowed` | 「无 `Origin` 即放行」 | **放行** |

后果（**已实证**）：`curl -X POST http://127.0.0.1:17319/command -d '{"action":"tab.version"}'` 就能让托管扩展执行命令 → 任何本机进程可 `page.evaluate` 读页面/cookie、`click`/`fill` 代替员工操作、`navigate` 导到钓鱼站。

**现在的做法**（只作用于**托管桥 17319**，existing 桥 17318 不变）：

```
<agentDir>/browser-bridge-token      ← 64 位 hex，随机生成后长期持久
        │
        │ ensureManagedExtensionDir() 生成扩展副本时读它，并**注入**进副本
        ↓
managed-extension/service_worker.js  ← const BRIDGE_TOKEN = "<token>";
        ↓  每次 /next 与 /result 带 x-pi-bridge-token
桥 17319 校验（timingSafeEqual；长度不等即拒）
```

| 端点 | 是否校验 | 说明 |
|---|---|---|
| `GET /next` · `POST /result` · `POST /command` | ✅ 校验 | 命令通道 |
| `GET /status` | ❌ 不校验 | 保留给 `curl` 诊断（只泄露连接状态） |

> ⚠️ **token 未生成时桥不校验**（向后兼容）。token 由 `ensureManagedExtensionDir()` 在启动托管 Chrome 前生成 —— 也就是**与副本注入同时发生**，两者天然同步。
> ⚠️ **这不是硬边界**：同一用户下的进程仍可能读到 token 文件（或扩展副本里的明文）。它是**纵深防御**，把门槛从"零成本一行 curl"抬到"需要读一个文件"。OpenClaw 的 loopback API 也是同一层级；它靠 native-host pairing 分发密钥，我们在 Windows 上不走 native host，改为生成副本时直接注入（**零传递环节**）。
> ⚠️ **轮换密钥**：删除 `<agentDir>/browser-bridge-token` → 重启应用（旧扩展副本会一并重新注入，Chrome 随启动重启）。
> ⚠️ **多会话**：非 owner 会话经 HTTP `POST /command` 转发命令，桥作为客户端会**自带** `x-pi-bridge-token`（`authHeaders()`），否则会被自己人 403。

**⚠️ MV3 的坑：扩展代码改了却不生效（SW 脚本缓存）**

MV3 的 service worker 脚本会被 Chrome 缓存到 `<profile>/Default/Service Worker/ScriptCache`。**manifest `version` 不变时，Chrome 会继续执行缓存里的旧脚本** —— 改了代码不生效。

> **本机实测**：副本 `service_worker.js` 已于 15:20 更新（含 token，48945 字节），但 `ScriptCache` 最新一批仍停在 **14:16**（48633 字节）→ 运行中的扩展一直是旧代码 → 它的 `/next` 不带 token → 被 403，`connected:false`，日志每 30s 一条 `共享密钥缺失或错误`。

**修法（两层，缺一不可）**：

| 层 | 做法 |
|---|---|
| ① 让 Chrome 认为扩展变了 | `extension-variant.ts` 由「**除 manifest 外的副本内容**」派生 build 号（sha256 前 4 字节 `% 65536`），写进 `manifest.version` 的**第 4 段**（Chrome 允许最多 4 段）→ 内容变则 version 变 → Chrome 重新加载扩展 |
| ② 让已运行的实例加载新代码 | `ensureManagedChrome()` 用 `ensureManagedExtensionDir()` 返回的 **`updated`** 标志判断"副本变了" → **重启托管 Chrome**（Chrome 不热重载 unpacked 扩展） |

> ✅ **幂等**已验证：内容不变时 `updated=false`，**不会**每次调用都重启浏览器；换 token/改代码/改端口才会触发重启。
> ⚠️ 探活也不能再依赖桥轮询：token 生效后旧实例的 `/next` 被 403，`lastSeenAt` 不更新 → 原先的 `extensionFreshlyPolling()` 判"无实例"会失效。现在 `!alive` 时**直接按进程命令行（`--user-data-dir` 特征）清理**同 profile 的遗留实例，再启动（该特征只属于托管实例，不会误杀日常 Chrome）。

**启动时序（为什么"第一次会比较慢"）**

```
会话创建（factory）
  ├─ 两条桥 start()                     # 幂等
  └─ enabled && driver=managed → **预热**：后台 spawn 托管 Chrome（不阻塞）
                                    ↓
第一次 browser_navigate            # 通常 Chrome 已就绪 → 秒回
  ├─ ensureBrowserReady：启动/沿用实例
  ├─ waitManagedExtension(30s)     # 等扩展首次轮询；**超时只警告不抛错**
  └─ bridge.send                    # 若扩展仍没连上：命令入队 + 60s 兜底，连上即执行
```

| 时间点 | 扩展是否已连上 | 首次调用耗时 |
|---|---|---|
| 会话已预热一段时间 | 是 | 秒级（正常） |
| 刚 rebuild 就立刻调用 | 否 | 可能 20–40s（Chrome 冷启动 + 扩展首次安装） |
| `browser_window show/hide`（重启浏览器）后 | 否 | 同上（切换必然重启） |

> ⚠️ 这就是"首轮报超时"的来源：**Chrome 冷启动 + 首次安装 unpacked 扩展**可能超过任何固定等待窗口。所以策略是**不判死**——预热 + 入队 + 兜底超时，扩展一起来命令就执行。

> ⚠️ **遗留实例自动接管**：上次 pi-desktop 退出时未收尾，托管 Chrome 会留在系统里（句柄丢失 → 无法切模式）。现在 `ensureManagedChrome` 检测到"托管桥有轮询但不是本进程启动"时，会**按 `--user-data-dir` 特征结束旧实例**（`Get-CimInstance`/`pkill -f`，只匹配我们的 `browser-profile`，绝不误杀日常 Chrome），然后重新启动并**拿回句柄**。清理失败才降级为报错提示手动关闭。

**首次登录流程（managed）—— 默认全自动**

```
1. browser_navigate({url:"https://业务系统"})
   # 若目标是登录页 → 系统**自动**把托管 Chrome 切为可见窗口并重开该 URL，
   # 返回里会写明「已自动弹出托管浏览器窗口」。用户无需预先打开浏览器。
2. 员工在弹出的橙色窗口里扫码 / 短信验证登录
3. 用户对 agent 说「已登录」
4. browser_window({action:"hide"})            # 切回 --headless=new（完全不可见）
5. browser_navigate({url:"https://业务系统"})   # 登录态在 profile 里，直接进
```

> 手动等价路径：`browser_window({action:"show"})`。
>
> ⚠️ **切换模式必然重启浏览器 → 页面会丢**，所以 **show 会记住并自动恢复「最近访问的页面」**（主进程记录最近一次 http(s) URL，见 `rememberFromResult`/`lastVisitedUrl`）。也可以显式传 `url`。若从未访问过任何页面，show 只能开空白页（返回值里会说明"无历史页面可恢复"）。
>
> ⚠️ **登录提示词分两种**：窗口**已可见**时提示"无需再 show，直接让用户登录"（`LOGIN_HINT_VISIBLE`）；仍为无头时才提示调 `show`。避免"已经看得见了还让模型再 show 一次"（重复切换会重启、页面丢失）。
>
> ⚠️ **运行时模式优先**：实例一旦处于可见模式，后续所有工具调用会**保持**可见，不会因为配置里 `managed.headless: true` 又被切回无头（否则登录窗口会中途消失）。要回无头必须显式 `hide`。
> ⚠️ **前台化规则**：`managed` 且当前为可见窗口时，所有操作**强制前台**（激活标签）——员工在场（扫码/短信登录），必须让他看见页面。无头 / `existing` 仍走常规静默策略。
> ⚠️ 登录态存在 `<agentDir>/browser-profile`，**跨会话保留**。

> ⚠️ 写配置必须**读-改-写整对象**（参照 `tool-catalog.ts` 的 web-search 处理），禁止用裸 `{enabled}` 覆盖。

---

## 12. 挂载 —— 三处同步（项目铁律）

新增第一方扩展工具**必须三处同步**，否则 `modeAllowsTool` 会因 `featureKeyForToolName()` 返回 undefined 而**静默丢弃**工具。

### 12.1 `src/main/pi/session-manager.ts` — `extensionFactories`（**两个数组都挂**）

```ts
// 普通/空间会话数组（:1159）—— 交互式授权
extensionFactories: [
  soulExtension, rulesExtension, webSearchExtension,
  browserExtension,                          // ← 新增
  createSubagentExtension(() => this.webContents, () => this.modelRuntime),
  todoExtension, createAskUserExtension(() => this.webContents), hermesMemoryExtension,
],

// 定时任务会话数组（:2958）—— 无人值守，常驻授权
extensionFactories: [
  createScheduledTaskExtension(task), rulesExtension, webSearchExtension,
  browserExtensionUnattended,                // ← 新增（注意与普通数组用的实例不同）
  createSubagentExtension(() => this.webContents, () => this.modelRuntime),
],
```

> **决策（2026-09-14 拍板）**：普通会话 + 定时任务**都挂**。`browser_*` 属"纯自主能力"，无人值守也能用。
>
> ⚠️ **无人值守授权（本项目新增，必须理解）**：定时任务**无人跑 `/browser authorize`**，所以
> `browserExtensionUnattended` 改走「**配置常驻授权**」，且**三条全部满足**才放行，否则 fail closed：
> 1. `browser-config.json` `enabled: true`
> 2. `allowUnattended: true`
> 3. `allowedDomains` **非空**（无人自动化必须显式限定业务域名范围）
>
> 理由：授权是这套方案的安全边界。交互会话靠"员工知情授权"，无人值守靠"**范围被显式锁定**"——二者都留痕、都可解释。见 `src/main/pi/browser/auth.ts:assertBrowserAuthorized()`。

### 12.2 `src/main/pi/tool-catalog.ts` — `FEATURES` 表（key 用已预留的 `office`）

```ts
// FEATURES 数组内新增
{
  key: "office",                       // ← TOOL_MODES.office.features 已预留 "office"
  toolNames: ["browser_snapshot", "browser_click", "browser_type", "browser_screenshot", "browser_evaluate"],
  switchable: true,
  configFile: "browser-config.json",
},
```

并在 `readFeatureEnabled` / `setExtensionToolFeatureEnabled` 两个 `switch` 里补 `case "office"`（读写 `browser-config.ts`）。
`TOOL_MODES.standard` 若也要包含，追加 `"office"` 到 `standard.features`。

### 12.3 打包配置 `electron-builder.yml` — 让 Chrome 能加载扩展目录

Chrome **无法**从 asar 内加载 unpacked 扩展，必须把扩展目录解包：

```yaml
asar: true
asarUnpack:
  - "node_modules/node-pty/**/*"
  - "node_modules/better-sqlite3/**/*"
  - "node_modules/@ffmpeg-installer/**/*"
  - "resources/chrome-extension/**/*"     # ← 新增：Chrome 需真实路径加载 unpacked 扩展
```

主进程解析扩展真实目录：

```ts
// src/main/pi/browser/browser-extension.ts（或单独 path 工具）
import { app } from "electron";
import { join } from "node:path";

export function chromeExtensionDir(): string {
  // 打包后 app.getAppPath() = .../resources/app.asar → 换成 app.asar.unpacked 才是真实目录
  const root = app.getAppPath().replace(/app\.asar$/, "app.asar.unpacked");
  return join(root, "resources", "chrome-extension");
}
```

引导员工安装：在 UI/命令里给出 `chrome://extensions` 指引 + 该目录路径（可复制到剪贴板），复用 pi-chrome `/chrome onboard` 的交互。

---

## 13. 结果回传（R4 — 只要结果）

- **聊天面板**：工具结果本就回流到会话，最终由模型输出总结；`browser_screenshot` 的图也会显示在消息里（渲染端已支持 image 块，见 `content-utils.ts:37`）。
- **IM 网关（钉钉）**：pi-desktop 已有钉钉主通道（`src/main/im/dingtalk/`）。员工可在钉钉里发起任务，pi-desktop 后台跑完把**文字结果**（可附截图）回推。这与"过程不可见、只要结果"最契合。
- **产物落盘**：截图默认存 `<cwd>/.pi/browser-screenshots/<时间戳>.png`（移植 pi-chrome 的默认路径），便于审计。

---

## 14. 安全模型

| 层 | 机制 | 来源 |
|---|---|---|
| 连接 | 桥只绑 `127.0.0.1:17318`，不对外网暴露 | pi-chrome |
| 来源校验 | `/command` 仅接受本机进程（无 origin）；`/next`·`/result` 仅接受 `chrome-extension://` origin | pi-chrome |
| 授权 | 设置页开启「浏览器操作」= 知情授权（`enabled`）；无人值守额外要求 `allowUnattended`+`allowedDomains` | 本项目 |
| 目标隔离 | 每次操作默认落在**本会话专属自动化窗口/标签**，**绝不劫持员工活动标签**；清理只关自己开的 | pi-chrome |
| 输入权限 | 用 `chrome.debugger` 走 CDP，`isTrusted=true`，能过 user-activation 门 | pi-chrome |
| 隐私 | 密码/卡号字段恒为 `[已掩码]`，不出页面 | pi-chrome + 本项目 |
| **域名围栏** | **白名单只允许业务系统域名** | **本项目新增（生产必填）** |
| **审计** | 截图落盘 + 工具调用日志（主进程 `logger.ts`） | 本项目新增 |

---

## 15. 开发里程碑（建议顺序）

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M0 打通链路** | 桥 + 扩展 `tab.version`/`tab.list` + 一个 `browser_snapshot` | 员工 Chrome 加载扩展后，pi-desktop 能列出标签、打出快照文本 |
| **M1 交互闭环** | `page.click`/`type`/`key` + uid 定位 | 能在业务系统走完一个只读→填单的简单流程 |
| **M2 静默** | `background` 策略 + `tab.new.active:false` + 不抢焦点 | 全程不打断员工当前标签 |
| **M3 视觉** | `page.screenshot` → `ImageContent` + 配视觉模型 | 模型能描述页面里的图片内容 |
| **M4 安全** | 授权 + 域名白名单 + 脱敏 + `FEATURES` 登记 | 未授权/越域调用被拒；设置页可开关 |
| **M5 交付** | 打包 `asarUnpack` + 员工安装指引 + 钉钉回结果 | 打包版可加载扩展、结果能回推 |

---

## 16. 验证清单

- [ ] 主进程 `npx tsc -p tsconfig.node.json --noEmit` EXIT=0（**不跑 build**）
- [ ] 渲染端 `npx tsc -p tsconfig.json --noEmit` EXIT=0
- [ ] 三处同步核对：`extensionFactories` / `FEATURES`（key=`office`）/ `switch` case
- [ ] 工具可见性：会话里让模型"列出可用工具"，应含 `browser_*`（被极简模式剔除属正常）
- [ ] 授权：`enabled=false` 时工具报"未授权"；设置页开启后可用；无人值守缺 `allowedDomains` 时报错
- [ ] 静默：全程不抢焦点/不激活标签；`background=false` 无法覆盖会话锁
- [ ] 视觉：`browser_screenshot` 返回后，视觉模型能读到图（换纯文本模型应报错/忽略）
- [ ] 围栏：越域（如 `baidu.com`）操作被拒
- [ ] 安全：密码框快照为 `[redacted]`；网络结果无 `cookie`/`authorization`
- [ ] 打包：`asarUnpack` 生效，打包版 `chromeExtensionDir()` 指向真实目录且可被 Chrome 加载

---

## 17. 风险与限制（照抄 pi-chrome + 本项目补充）

| 风险 | 说明 | 缓解 |
|---|---|---|
| **不是隐身** | 用员工真实 profile → 员工看屏幕能看到标签在动 | 明确"不抢焦点"语义；要真隐身则换独立浏览器（丢登录态） |
| 受保护页 | `chrome://`、扩展商店、部分 SSP 页无法读/操作 DOM | 只做浏览器级导航；提示员工 |
| CAPTCHA / 风控 | 站点 bot 检测可能拦合成事件 | 输入走 CDP（`isTrusted`）已能过多数；CAPTCHA 需人工 |
| 跨域 iframe | 部分跨域 iframe DOM 不可达 | 用坐标输入兜底 |
| 后台节流 | 后台标签的定时器/渲染被节流，剪贴板/全屏/文件选择器可能失败 | 关键步骤可前台（`browser-config.json` `background:false`） |
| **后台标签截图失败** | 导航/重载会销毁渲染目标 → `Page.captureScreenshot: Detached while handling command`；后台标签渲染也可能不可用 | 已内置**3 次重挂重试**（递增等待让页面稳定）；持续失败则设 `background:false` 让标签前台化后再截 |
| 扩展安装门槛 | Chrome Web Store 不允许扩展连本地桥 → 必须 unpacked / 企业策略 | 公司统一策略分发；写员工手册 |
| 调试黄条 | CDP attach 时标签顶部有提示 | 属安全预期，向员工说明 |
| 视觉模型 | 需支持视觉的模型 | 配置项；无视觉模型时降级为纯文本快照 |
| 版本漂移 | 扩展与主进程协议不匹配 | 移植 pi-chrome 的 `x-pi-chrome-version` 头 + 版本落后自动 `chrome.runtime.reload()` |

---

## 附：pi-chrome 关键源码索引（移植时对照）

| 主题 | pi-chrome 位置 |
|---|---|
| 桥协议四端点 | `extensions/chrome-profile-bridge/index.ts:517-617` |
| 桥 server/client 多会话 | 同上 `:337-400` |
| 超时三分法 | 同上 `:442-451` |
| 授权状态机 | 同上 `:784-817` |
| 后台策略注入 | 同上 `:885-930` |
| agent primer（本项目改走 promptGuidelines） | 同上 `:960-990` |
| `/chrome` 命令 | 同上 `:1224-1294` |
| 工具注册范式 | 同上 `:1300-1930` |
| 扩展轮询/派发 | `browser-extension/service_worker.js:1136-1260` |
| CDP 输入层 | 同上 `:261-1100` |
| 截图（CDP，无激活回退） | 同上 `:1799-1844` |
| 自动化目标归属（per-session） | 同上 `:13-246` |
| 页面快照注入（无 eval，CSP 安全） | `browser-extension/snapshot_injected.js` |
| 架构说明 | `docs/ARCHITECTURE.md` |
| 安全说明 | `SECURITY.md` |

**License**：pi-chrome 为 **MIT**，可商用移植；移植时在文件头保留原始版权与出处声明。
