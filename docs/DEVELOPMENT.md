# Pi Desk - 开发手册

> Pi 的桌面端壳程序，基于 Electron + Pi SDK 构建，视觉风格参考 TRAE 设计系统。

---

## 1. 项目概述

### 1.1 目标

为 [Pi](https://github.com/earendil-works/pi-mono) AI 编码代理构建一个原生桌面应用，**不修改 Pi 源码**，通过 `@earendil-works/pi-coding-agent` npm 包的 SDK 接口实现进程内集成。

### 1.2 核心原则

- **零侵入**：不修改 Pi 项目任何源码，仅通过 npm 包消费
- **进程内集成**：Pi SDK 运行在 Electron 主进程，获得完整类型安全和最大控制力
- **TRAE 视觉风格**：暗色优先设计系统，BEM 命名，CSS 变量 token 体系
- **IDE 布局**：参考 TRAE dev-explorer 的 CSS Grid 骨架

### 1.3 技术栈

| 层面 | 选型 | 理由 |
|------|------|------|
| 桌面框架 | Electron 35+ | Node.js >= 22.19.0 要求，进程内 SDK 调用 |
| 前端框架 | React 19 | 组件化，生态成熟，TRAE UI Kit 参考实现也用 React |
| 构建工具 | Vite 6 | 快速 HMR，Electron 集成成熟 |
| 样式方案 | CSS Modules + CSS Variables | 匹配 TRAE token 体系，避免运行时开销 |
| 状态管理 | Zustand | 轻量，支持 IPC 同步 |
| 代码高亮 | highlight.js | Pi 已依赖，复用同一库 |
| Markdown | react-markdown + remark-gfm | 渲染助手消息 |
| 打包 | electron-builder | 跨平台分发 |

---

## 2. 架构设计

### 2.1 进程模型

```
┌─────────────────────────────────────────────────────────┐
│                    Electron Main Process                 │
│                                                          │
│  ┌──────────────┐  ┌──────────────────────────────────┐ │
│  │ WindowManager│  │         Pi SDK Layer              │ │
│  │              │  │                                    │ │
│  │ - createWin  │  │  ModelRuntime                     │ │
│  │ - manageWins │  │  AgentSessionRuntime              │ │
│  │              │  │  AgentSession (subscribe events)  │ │
│  │              │  │  SessionManager                   │ │
│  │              │  │  SettingsManager                  │ │
│  └──────────────┘  └──────────────────────────────────┘ │
│                          │                               │
│                     IPC Bridge                           │
│                    (ipcMain/on)                          │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────┐
│                   Electron Renderer Process              │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐│
│  │                    React App                         ││
│  │                                                      ││
│  │  Titlebar │ ActivityBar │ Sidebar │ Chat │ StatusBar ││
│  │                                                      ││
│  │  Zustand Store ←→ IPC ←→ Main Process SDK           ││
│  └─────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

### 2.2 数据流

```
用户输入 → Renderer (Zustand action)
         → ipcRenderer.invoke('pi:prompt', { text, images })
         → Main: session.prompt(text, { images })
         → Main: session.subscribe() 回调
         → Main: mainWindow.webContents.send('pi:event', event)
         → Renderer: Zustand store 更新
         → React 重渲染
```

### 2.3 关键设计决策

| 决策 | 选择 | 原因 |
|------|------|------|
| SDK 运行位置 | 主进程 | Node.js 原生模块访问、文件系统操作、子进程管理（bash 工具） |
| IPC 模式 | 双向 invoke + 事件推送 | invoke 用于请求/响应，webContents.send 用于流式事件推送 |
| 会话生命周期 | 主进程持有 | AgentSession 是有状态的，主进程管理其生命周期 |
| 渲染进程状态 | Zustand + IPC 同步 | 渲染进程持有 UI 状态镜像，通过 IPC 与主进程同步 |

---

## 3. 目录结构

```
pi-desk/
├── DEVELOPMENT.md              # 本开发手册
├── package.json                # 项目配置
├── tsconfig.json               # TypeScript 配置
├── tsconfig.node.json          # 主进程 TS 配置
├── vite.config.ts              # Vite 渲染进程配置
├── electron-builder.yml        # 打包配置
│
├── src/
│   ├── main/                   # Electron 主进程
│   │   ├── index.ts            # 入口：app 生命周期、窗口创建
│   │   ├── window.ts           # 窗口管理器
│   │   ├── ipc-handlers.ts     # IPC handler 注册
│   │   └── pi/                 # Pi SDK 集成层
│   │       ├── session-manager.ts   # AgentSessionRuntime 管理
│   │       ├── event-bridge.ts      # AgentSession 事件 → IPC 推送
│   │       └── types.ts             # IPC 事件/命令类型定义
│   │
│   ├── preload/                # Preload 脚本
│   │   └── index.ts            # contextBridge 暴露 API
│   │
│   ├── renderer/               # 渲染进程
│   │   ├── index.html          # HTML 入口
│   │   ├── main.tsx            # React 入口
│   │   ├── App.tsx             # 根组件
│   │   │
│   │   ├── layout/             # IDE 布局骨架
│   │   │   ├── Workbench.tsx   # 主布局 Grid 容器
│   │   │   ├── Titlebar.tsx    # 40px 顶栏
│   │   │   ├── ActivityBar.tsx # 40px 左侧图标栏
│   │   │   ├── Sidebar.tsx     # 240px 侧栏
│   │   │   ├── MainPanel.tsx   # 中间主面板
│   │   │   └── StatusBar.tsx   # 24px 底栏
│   │   │
│   │   ├── chat/               # 聊天面板
│   │   │   ├── ChatPanel.tsx   # 聊天容器
│   │   │   ├── ChatComposer.tsx # 输入框 + 工具栏
│   │   │   ├── MessageList.tsx # 消息列表
│   │   │   ├── AssistantMessage.tsx  # 助手消息（Markdown + 代码）
│   │   │   ├── UserMessage.tsx       # 用户消息
│   │   │   ├── ToolExecution.tsx     # 工具执行展示
│   │   │   └── ThinkingBlock.tsx     # 思考过程折叠块
│   │   │
│   │   ├── sidebar/            # 侧栏面板
│   │   │   ├── SessionList.tsx # 会话列表
│   │   │   ├── FileTree.tsx    # 工作区文件树
│   │   │   └── SettingsPanel.tsx # 设置面板
│   │   │
│   │   ├── components/         # 通用 UI 组件
│   │   │   ├── Button.tsx      # ds-btn 体系
│   │   │   ├── Dialog.tsx      # ds-dialog
│   │   │   ├── Menu.tsx        # ds-menu
│   │   │   ├── Tabs.tsx        # ds-tabs / ds-editortabs
│   │   │   ├── Select.tsx      # ds-forms select
│   │   │   ├── Tag.tsx         # ds-tag
│   │   │   ├── Alert.tsx       # ds-alert
│   │   │   ├── Avatar.tsx      # ds-avatar
│   │   │   ├── Kbd.tsx         # ds-kbd
│   │   │   └── Icon.tsx        # 图标组件（Lucide）
│   │   │
│   │   ├── hooks/              # React Hooks
│   │   │   ├── useAgentSession.ts  # 会话状态 hook
│   │   │   ├── useModels.ts        # 模型列表 hook
│   │   │   └── useSettings.ts      # 设置 hook
│   │   │
│   │   ├── store/              # Zustand Store
│   │   │   ├── agent-store.ts  # Agent 状态（消息、流式、队列）
│   │   │   ├── ui-store.ts     # UI 状态（侧栏、面板可见性）
│   │   │   └── session-store.ts # 会话列表状态
│   │   │
│   │   └── styles/             # 样式
│   │       ├── tokens.css      # TRAE CSS 变量 token（从 TRAE 迁移）
│   │       ├── global.css      # 全局样式、字体引入
│   │       └── components.css  # 共享组件样式
│   │
│   └── shared/                 # 主进程/渲染进程共享
│       └── ipc-types.ts        # IPC 通道名和消息类型
│
├── assets/                     # 静态资源
│   ├── icons/                  # TRAE SVG 图标集
│   └── fonts/                  # 字体文件（备用）
│
└── scripts/                    # 开发脚本
    └── dev.ts                  # 开发启动脚本
```

---

## 4. Electron 主进程设计

### 4.1 入口 (`src/main/index.ts`)

```typescript
import { app, BrowserWindow } from "electron";
import { registerIpcHandlers } from "./ipc-handlers";
import { PiSessionManager } from "./pi/session-manager";
import { createMainWindow } from "./window";

let piManager: PiSessionManager;

app.whenReady().then(async () => {
  piManager = new PiSessionManager();
  await piManager.initialize();

  const mainWindow = createMainWindow();
  registerIpcHandlers(mainWindow, piManager);

  piManager.setEventTarget(mainWindow.webContents);
});

app.on("window-all-closed", () => {
  piManager?.dispose();
  app.quit();
});
```

### 4.2 窗口管理 (`src/main/window.ts`)

```typescript
import { BrowserWindow } from "electron";
import path from "path";

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#1A1B1D",
      symbolColor: "#D1D3DB",
      height: 40,
    },
    backgroundColor: "#1A1B1D",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  return win;
}
```

**关键点**：
- `titleBarStyle: "hidden"` 实现自定义标题栏
- `contextIsolation: true` + `nodeIntegration: false` 是安全最佳实践
- `sandbox: false` 因为 Pi SDK 需要文件系统和子进程访问（在主进程，不在渲染进程）

### 4.3 Pi SDK 集成层

#### 4.3.1 SessionManager (`src/main/pi/session-manager.ts`)

```typescript
import {
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  SessionManager as PiSessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import type { WebContents } from "electron";

export class PiDeskSessionManager {
  private runtime: AgentSessionRuntime | null = null;
  private modelRuntime: ModelRuntime | null = null;
  private webContents: WebContents | null = null;
  private unsubscribe: (() => void) | null = null;

  async initialize(cwd?: string): Promise<void> {
    this.modelRuntime = await ModelRuntime.create();

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd,
      sessionManager,
      sessionStartEvent,
    }) => {
      const services = await createAgentSessionServices({ cwd });
      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };

    this.runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: cwd ?? process.cwd(),
      agentDir: getAgentDir(),
      sessionManager: PiSessionManager.create(cwd ?? process.cwd()),
    });

    this.subscribeToSession();
  }

  private subscribeToSession(): void {
    if (!this.runtime) return;
    this.unsubscribe = this.runtime.session.subscribe((event) => {
      this.webContents?.send("pi:event", this.serializeEvent(event));
    });
  }

  setEventTarget(wc: WebContents): void {
    this.webContents = wc;
  }

  get session(): AgentSession | null {
    return this.runtime?.session ?? null;
  }

  async prompt(text: string, images?: any[]): Promise<void> {
    await this.session?.prompt(text, { images });
  }

  async steer(text: string): Promise<void> {
    await this.session?.steer(text);
  }

  async followUp(text: string): Promise<void> {
    await this.session?.followUp(text);
  }

  async abort(): Promise<void> {
    await this.session?.abort();
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const model = this.modelRuntime?.getModel(provider, modelId);
    if (model) await this.session?.setModel(model);
  }

  async cycleModel(): Promise<void> {
    await this.session?.cycleModel();
  }

  async newSession(): Promise<void> {
    if (!this.runtime) return;
    this.unsubscribe?.();
    await this.runtime.newSession();
    this.subscribeToSession();
  }

  async switchSession(sessionPath: string): Promise<void> {
    if (!this.runtime) return;
    this.unsubscribe?.();
    await this.runtime.switchSession(sessionPath);
    this.subscribeToSession();
  }

  async compact(customInstructions?: string): Promise<void> {
    await this.session?.compact(customInstructions);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.session?.dispose();
  }

  private serializeEvent(event: AgentSessionEvent): any {
    return JSON.parse(JSON.stringify(event));
  }
}
```

#### 4.3.2 事件桥接 (`src/main/pi/event-bridge.ts`)

AgentSession 事件到渲染进程的映射：

| AgentSession 事件 | 渲染进程用途 |
|---|---|
| `message_start` | 开始新消息气泡 |
| `message_update` (text_delta) | 流式文本追加 |
| `message_update` (thinking_delta) | 思考块追加 |
| `message_end` | 完成消息渲染 |
| `tool_execution_start` | 显示工具执行中状态 |
| `tool_execution_update` | 更新工具输出 |
| `tool_execution_end` | 完成工具执行 |
| `agent_start` | 显示全局加载状态 |
| `agent_end` | 隐藏加载状态 |
| `turn_start` / `turn_end` | 回合边界标记 |
| `queue_update` | 更新 steering/followUp 队列状态 |
| `compaction_start` / `compaction_end` | 压缩状态通知 |
| `auto_retry_start` / `auto_retry_end` | 重试状态通知 |

### 4.4 IPC Handler 注册 (`src/main/ipc-handlers.ts`)

```typescript
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { PiDeskSessionManager } from "./pi/session-manager";

export function registerIpcHandlers(
  mainWindow: BrowserWindow,
  piManager: PiDeskSessionManager
): void {
  const { ipcMain } = require("electron");

  // 提示
  ipcMain.handle("pi:prompt", async (_, { text, images }) => {
    await piManager.prompt(text, images);
  });

  // 转向
  ipcMain.handle("pi:steer", async (_, { text }) => {
    await piManager.steer(text);
  });

  // 追加
  ipcMain.handle("pi:followUp", async (_, { text }) => {
    await piManager.followUp(text);
  });

  // 中止
  ipcMain.handle("pi:abort", async () => {
    await piManager.abort();
  });

  // 模型
  ipcMain.handle("pi:setModel", async (_, { provider, modelId }) => {
    await piManager.setModel(provider, modelId);
  });

  ipcMain.handle("pi:cycleModel", async () => {
    await piManager.cycleModel();
  });

  ipcMain.handle("pi:getAvailableModels", async () => {
    return piManager.modelRuntime
      ? await piManager.modelRuntime.getAvailable()
      : [];
  });

  // 会话
  ipcMain.handle("pi:newSession", async () => {
    await piManager.newSession();
  });

  ipcMain.handle("pi:switchSession", async (_, { sessionPath }) => {
    await piManager.switchSession(sessionPath);
  });

  ipcMain.handle("pi:compact", async (_, { customInstructions }) => {
    await piManager.compact(customInstructions);
  });

  // 状态
  ipcMain.handle("pi:getState", async () => {
    const session = piManager.session;
    if (!session) return null;
    return {
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      sessionId: session.sessionId,
      messages: session.messages,
    };
  });

  // 窗口控制
  ipcMain.handle("window:minimize", () => mainWindow.minimize());
  ipcMain.handle("window:maximize", () => {
    mainWindow.isMaximized()
      ? mainWindow.unmaximize()
      : mainWindow.maximize();
  });
  ipcMain.handle("window:close", () => mainWindow.close());
}
```

---

## 5. Preload 脚本

### 5.1 `src/preload/index.ts`

```typescript
import { contextBridge, ipcRenderer } from "electron";

const piAPI = {
  // 提示
  prompt: (text: string, images?: any[]) =>
    ipcRenderer.invoke("pi:prompt", { text, images }),
  steer: (text: string) =>
    ipcRenderer.invoke("pi:steer", { text }),
  followUp: (text: string) =>
    ipcRenderer.invoke("pi:followUp", { text }),
  abort: () => ipcRenderer.invoke("pi:abort"),

  // 模型
  setModel: (provider: string, modelId: string) =>
    ipcRenderer.invoke("pi:setModel", { provider, modelId }),
  cycleModel: () => ipcRenderer.invoke("pi:cycleModel"),
  getAvailableModels: () => ipcRenderer.invoke("pi:getAvailableModels"),

  // 会话
  newSession: () => ipcRenderer.invoke("pi:newSession"),
  switchSession: (sessionPath: string) =>
    ipcRenderer.invoke("pi:switchSession", { sessionPath }),
  compact: (customInstructions?: string) =>
    ipcRenderer.invoke("pi:compact", { customInstructions }),

  // 状态
  getState: () => ipcRenderer.invoke("pi:getState"),

  // 事件监听
  onEvent: (callback: (event: any) => void) => {
    const listener = (_: any, event: any) => callback(event);
    ipcRenderer.on("pi:event", listener);
    return () => ipcRenderer.removeListener("pi:event", listener);
  },

  // 窗口控制
  minimize: () => ipcRenderer.invoke("window:minimize"),
  maximize: () => ipcRenderer.invoke("window:maximize"),
  close: () => ipcRenderer.invoke("window:close"),
};

contextBridge.exposeInMainWorld("piDesk", piAPI);
```

### 5.2 TypeScript 类型声明 (`src/preload/api.d.ts`)

```typescript
export interface PiDeskAPI {
  prompt(text: string, images?: any[]): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  cycleModel(): Promise<void>;
  getAvailableModels(): Promise<any[]>;
  newSession(): Promise<void>;
  switchSession(sessionPath: string): Promise<void>;
  compact(customInstructions?: string): Promise<void>;
  getState(): Promise<any>;
  onEvent(callback: (event: any) => void): () => void;
  minimize(): Promise<void>;
  maximize(): Promise<void>;
  close(): Promise<void>;
}

declare global {
  interface Window {
    piDesk: PiDeskAPI;
  }
}
```

---

## 6. 渲染进程设计

### 6.1 布局骨架

参考 TRAE dev-explorer 的 CSS Grid 布局，但去掉 1184px 限制，使用全屏画布：

```
┌─────────────────────────────────────────────────────────┐
│  Titlebar (40px)                                         │
│  [🟢🟡🔴] [Pi Desk] [model selector] ........ [⚙️]     │
├──────┬──────────┬───────────────────────────────────────┤
│      │          │                                       │
│ Act  │ Sidebar  │         Chat Panel                    │
│ Bar  │          │                                       │
│(48px)│ (240px)  │  ┌─────────────────────────────┐     │
│      │          │  │  Message List (scrollable)   │     │
│ 💬   │ Sessions │  │  - User Message              │     │
│ 📁   │          │  │  - Assistant Message         │     │
│ ⚙️   │          │  │  - Tool Execution            │     │
│      │          │  │  - Thinking Block            │     │
│      │          │  └─────────────────────────────┘     │
│      │          │  ┌─────────────────────────────┐     │
│      │          │  │  Chat Composer               │     │
│      │          │  │  [textarea]                  │     │
│      │          │  │  [+ 📎] [model] [🎤] [➤]   │     │
│      │          │  └─────────────────────────────┘     │
├──────┴──────────┴───────────────────────────────────────┤
│  Status Bar (24px)                                        │
│  [model] [thinking] [context: 30%] .... [session id]     │
└─────────────────────────────────────────────────────────┘
```

### 6.2 Workbench 布局组件 (`src/renderer/layout/Workbench.tsx`)

```css
.workbench {
  display: grid;
  grid-template-rows: 40px 1fr 24px;
  height: 100vh;
  background: var(--bg-base-default);
  color: var(--text-default);
}

.workbench__body {
  display: grid;
  grid-template-columns: 48px 240px 1fr;
  overflow: hidden;
}

/* 响应式 */
@media (max-width: 900px) {
  .workbench__body {
    grid-template-columns: 48px 1fr;
  }
  .workbench__sidebar {
    display: none;
  }
}

@media (max-width: 640px) {
  .workbench__body {
    grid-template-columns: 1fr;
  }
  .workbench__activity-bar {
    display: none;
  }
}
```

### 6.3 Zustand Store 设计

#### 6.3.1 Agent Store (`src/renderer/store/agent-store.ts`)

```typescript
import { create } from "zustand";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  toolExecutions?: ToolExecution[];
  isStreaming?: boolean;
  timestamp: number;
}

interface ToolExecution {
  id: string;
  toolName: string;
  input: any;
  output?: string;
  isError: boolean;
  isRunning: boolean;
}

interface AgentState {
  messages: Message[];
  isStreaming: boolean;
  isCompacting: boolean;
  isRetrying: boolean;
  model: any | null;
  thinkingLevel: string;
  steeringQueue: string[];
  followUpQueue: string[];
  contextUsage: { tokens: number; percent: number } | null;

  // Actions
  addMessage: (msg: Message) => void;
  updateLastAssistant: (delta: string) => void;
  updateLastAssistantThinking: (delta: string) => void;
  addToolExecution: (tool: ToolExecution) => void;
  updateToolExecution: (id: string, update: Partial<ToolExecution>) => void;
  setStreaming: (v: boolean) => void;
  setModel: (model: any) => void;
  setThinkingLevel: (level: string) => void;
  setContextUsage: (usage: { tokens: number; percent: number } | null) => void;
  clearMessages: () => void;
}
```

#### 6.3.2 UI Store (`src/renderer/store/ui-store.ts`)

```typescript
interface UIState {
  sidebarVisible: boolean;
  sidebarPanel: "sessions" | "files" | "settings";
  activityBarActiveItem: string;
  composerText: string;
  composerFocused: boolean;

  toggleSidebar: () => void;
  setSidebarPanel: (panel: UIState["sidebarPanel"]) => void;
  setComposerText: (text: string) => void;
}
```

### 6.4 事件处理 Hook (`src/renderer/hooks/useAgentSession.ts`)

```typescript
import { useEffect } from "react";
import { useAgentStore } from "../store/agent-store";

export function useAgentSession() {
  const store = useAgentStore();

  useEffect(() => {
    const unsubscribe = window.piDesk.onEvent((event) => {
      switch (event.type) {
        case "message_start":
          store.addMessage({
            id: event.messageId,
            role: event.role,
            content: "",
            isStreaming: true,
            timestamp: Date.now(),
          });
          break;

        case "message_update":
          if (event.assistantMessageEvent.type === "text_delta") {
            store.updateLastAssistant(event.assistantMessageEvent.delta);
          } else if (event.assistantMessageEvent.type === "thinking_delta") {
            store.updateLastAssistantThinking(
              event.assistantMessageEvent.delta
            );
          }
          break;

        case "message_end":
          // 标记消息完成
          break;

        case "tool_execution_start":
          store.addToolExecution({
            id: event.toolCallId,
            toolName: event.toolName,
            input: event.input,
            isRunning: true,
            isError: false,
          });
          break;

        case "tool_execution_end":
          store.updateToolExecution(event.toolCallId, {
            output: event.output,
            isError: event.isError,
            isRunning: false,
          });
          break;

        case "agent_start":
          store.setStreaming(true);
          break;

        case "agent_end":
          store.setStreaming(false);
          break;
      }
    });

    return unsubscribe;
  }, []);
}
```

---

## 7. TRAE 设计系统迁移

### 7.1 Token 迁移

将 `TRAE/colors_and_type.css` 的 `:root` 变量直接迁移到 `src/renderer/styles/tokens.css`，**不修改任何 token 值**，只做以下调整：

1. 字体 fallback 链适配 Windows：`"SF Pro Text"` → `"SF Pro Text", "Segoe UI", system-ui, -apple-system, sans-serif`
2. `--font-family-mono` fallback：`"JetBrains Mono", "Cascadia Code", "Consolas", monospace`

### 7.2 组件迁移策略

| TRAE 组件 | 迁移方式 | pi-desk 用途 |
|-----------|----------|-------------|
| workbench-titlebar | React 组件 + CSS Modules | 自定义标题栏 |
| activity-rail | React 组件 + CSS Modules | 左侧图标导航 |
| file-tree | React 组件 + CSS Modules | 工作区文件浏览 |
| chat-composer | React 组件 + CSS Modules | 聊天输入框 |
| status-bar | React 组件 + CSS Modules | 底部状态栏 |
| buttons | React 组件 + CSS Modules | 全局按钮 |
| dialog | React 组件 + CSS Modules | 模态对话框 |
| forms | React 组件 + CSS Modules | 设置表单 |
| menu | React 组件 + CSS Modules | 右键/下拉菜单 |
| tabs | React 组件 + CSS Modules | 编辑器标签 |
| alert | React 组件 + CSS Modules | 提示通知 |
| tag | React 组件 + CSS Modules | 状态标签 |
| kbd | React 组件 + CSS Modules | 快捷键显示 |
| avatar | React 组件 + CSS Modules | 用户/模型头像 |

### 7.3 图标系统

使用 Lucide React（与 TRAE 的 Lucide 风格 SVG 一致），避免手动管理 SVG sprite：

```typescript
import { MessageSquare, Folder, Settings, Send, Plus, Mic } from "lucide-react";
```

品牌绿表面上的图标使用 `color: var(--icon-onbrand)` 而非 TRAE 的 `.0c0c0d.svg` 变体。

### 7.4 BEM 命名约定

在 CSS Modules 中，使用 camelCase 替代 BEM 的 `__` 和 `--`：

```css
/* TRAE 原始 */
.ds-composer__input { }
.ds-composer__input--focused { }

/* pi-desk CSS Modules */
.input { }
.inputFocused { }
```

但保留 `.ds-` 前缀的语义层级概念，通过 CSS Modules 的局部作用域实现隔离。

---

## 8. 关键功能实现

### 8.1 流式消息渲染

助手消息的流式渲染是核心体验：

```typescript
// ChatPanel.tsx
function AssistantMessage({ message }: { message: Message }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (message.isStreaming) {
      ref.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [message.content, message.isStreaming]);

  return (
    <div className={styles.assistantMessage}>
      {message.thinking && (
        <ThinkingBlock content={message.thinking} />
      )}
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {message.content}
      </ReactMarkdown>
      {message.isStreaming && <span className={styles.cursor} />}
    </div>
  );
}
```

### 8.2 Chat Composer

参考 TRAE 的 `.ds-composer` 组件：

```typescript
function ChatComposer() {
  const [text, setText] = useState("");
  const { isStreaming } = useAgentStore();
  const textRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = () => {
    if (!text.trim()) return;
    if (isStreaming) {
      window.piDesk.steer(text);
    } else {
      window.piDesk.prompt(text);
    }
    setText("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className={styles.composer}>
      <textarea
        ref={textRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Ask Pi anything..."
        rows={1}
      />
      <div className={styles.composerToolbar}>
        <div className={styles.toolbarLeft}>
          <Button variant="tertiary" icon={Plus} />
          <ModelSelector />
        </div>
        <div className={styles.toolbarRight}>
          <Button
            variant="brand"
            icon={Send}
            onClick={handleSend}
            disabled={!text.trim()}
          />
        </div>
      </div>
    </div>
  );
}
```

### 8.3 工具执行展示

```typescript
function ToolExecution({ execution }: { execution: ToolExecution }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={styles.toolExecution}>
      <div
        className={styles.toolHeader}
        onClick={() => setExpanded(!expanded)}
      >
        <Icon name={getToolIcon(execution.toolName)} size={14} />
        <span className={styles.toolName}>{execution.toolName}</span>
        {execution.isRunning && <Loader size={12} />}
        {!execution.isRunning && (
          <Tag
            variant={execution.isError ? "error" : "success"}
            size="sm"
          />
        )}
        <Icon name={expanded ? "chevron-down" : "chevron-right"} size={12} />
      </div>
      {expanded && (
        <div className={styles.toolBody}>
          <pre className={styles.toolInput}>
            {JSON.stringify(execution.input, null, 2)}
          </pre>
          {execution.output && (
            <pre className={styles.toolOutput}>{execution.output}</pre>
          )}
        </div>
      )}
    </div>
  );
}
```

### 8.4 模型选择器

```typescript
function ModelSelector() {
  const [models, setModels] = useState<any[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    window.piDesk.getAvailableModels().then(setModels);
  }, []);

  return (
    <div className={styles.modelSelector}>
      <button
        className={styles.modelPill}
        onClick={() => setOpen(!open)}
      >
        <Avatar size={16} />
        <span>{currentModel?.name ?? "Select model"}</span>
      </button>
      {open && (
        <Menu>
          {models.map((m) => (
            <MenuItem
              key={`${m.provider.id}/${m.id}`}
              onClick={() => {
                window.piDesk.setModel(m.provider.id, m.id);
                setOpen(false);
              }}
            >
              {m.name}
            </MenuItem>
          ))}
        </Menu>
      )}
    </div>
  );
}
```

---

## 9. 构建与开发

### 9.1 package.json 关键配置

```json
{
  "name": "pi-desk",
  "version": "0.1.0",
  "private": true,
  "main": "dist/main/index.js",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "build:electron": "tsc -p tsconfig.node.json && electron-builder",
    "preview": "vite preview",
    "lint": "eslint src/",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@earendil-works/pi-coding-agent": "^0.80.10",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zustand": "^5.0.0",
    "react-markdown": "^9.0.0",
    "remark-gfm": "^4.0.0",
    "highlight.js": "^10.7.3",
    "lucide-react": "^0.400.0"
  },
  "devDependencies": {
    "electron": "^35.0.0",
    "electron-builder": "^25.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "typescript": "^5.9.0",
    "vite": "^6.0.0",
    "vite-plugin-electron": "^0.30.0",
    "vite-plugin-electron-renderer": "^0.14.0",
    "@vitejs/plugin-react": "^4.0.0"
  }
}
```

### 9.2 Vite 配置 (`vite.config.ts`)

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron";

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: "src/main/index.ts",
        vite: {
          build: {
            outDir: "dist/main",
            rollupOptions: {
              external: ["electron", "@earendil-works/pi-coding-agent"],
            },
          },
        },
      },
      {
        entry: "src/preload/index.ts",
        onstart({ reload }) {
          reload();
        },
        vite: {
          build: {
            outDir: "dist/preload",
          },
        },
      },
    ]),
  ],
});
```

### 9.3 electron-builder.yml

```yaml
appId: com.pi-desk.app
productName: Pi Desk
directories:
  output: release
files:
  - dist/**/*
  - package.json
mac:
  category: public.app-category.developer-tools
  target:
    - dmg
    - zip
win:
  target:
    - nsis
    - portable
linux:
  target:
    - AppImage
    - deb
```

---

## 10. 开发路线图

### Phase 1：最小可用原型 (MVP)

**目标**：Electron 窗口 + Pi SDK 连接 + 基本聊天

- [ ] 项目初始化（package.json、tsconfig、vite 配置）
- [ ] Electron 主进程 + 窗口创建
- [ ] Pi SDK 集成层（SessionManager）
- [ ] IPC handler + preload 脚本
- [ ] 基本布局骨架（Titlebar + ChatPanel + StatusBar）
- [ ] Chat Composer + 消息列表
- [ ] 流式消息渲染
- [ ] TRAE token CSS 迁移

### Phase 2：完整 IDE 体验

**目标**：侧栏、会话管理、模型切换

- [ ] Activity Bar + Sidebar
- [ ] 会话列表 + 切换/新建
- [ ] 模型选择器 + 切换
- [ ] 思考级别控制
- [ ] 工具执行展示（折叠/展开）
- [ ] 思考块折叠
- [ ] 响应式布局

### Phase 3：增强功能

**目标**：设置、扩展 UI、原生体验

- [ ] 设置面板
- [ ] 扩展 UI 交互（select、confirm、input、editor）
- [ ] 文件树浏览
- [ ] 代码语法高亮
- [ ] Markdown 渲染优化
- [ ] 主题系统
- [ ] 系统托盘
- [ ] 自动更新

### Phase 4：打包与分发

**目标**：跨平台安装包

- [ ] electron-builder 配置
- [ ] macOS DMG / Windows NSIS / Linux AppImage
- [ ] 代码签名
- [ ] 自动更新 (electron-updater)

---

## 11. 注意事项

### 11.1 Node.js 版本

Pi SDK 要求 `Node.js >= 22.19.0`，Electron 内置的 Node.js 版本必须满足。Electron 35+ 基于 Node.js 22.x，满足要求。

### 11.2 安全

- 严格遵守 `contextIsolation: true` + `nodeIntegration: false`
- 所有 Node.js API 调用通过 preload 的 `contextBridge` 暴露
- Pi SDK 仅在主进程中使用，渲染进程通过 IPC 访问
- 不在渲染进程中直接使用 `require` 或 `import` Node.js 模块

### 11.3 性能

- 流式事件通过 `webContents.send` 推送，避免 invoke 的请求/响应开销
- 大消息内容（如 bash 输出）考虑截断显示，完整内容按需加载
- React 渲染优化：消息列表使用虚拟滚动（当消息数 > 100 时）
- 工具执行详情默认折叠，减少 DOM 节点

### 11.4 Pi SDK 生命周期

- `AgentSession` 是有状态的，主进程持有其引用
- 会话替换（newSession、switchSession、fork）后需要重新订阅事件
- 应用退出时调用 `session.dispose()` 清理资源
- `ModelRuntime.create()` 是异步的，需要在 app.ready 之后调用

### 11.5 TRAE 设计系统合规

- 所有颜色通过 `var(--token)` 引用，不硬编码 hex
- 品牌绿表面上的图标使用 `var(--icon-onbrand)` (#0C0C0D)
- 按钮变体遵循 TRAE 规范：每页最多 1 个 brand 按钮
- 状态色使用 `--status-*` token
- 圆角使用 `--radius-*` token
- 间距使用 `--spacer-*` token