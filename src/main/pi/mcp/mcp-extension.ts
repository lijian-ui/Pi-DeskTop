/**
 * Pi inline extension: 挂载 SDK 内置的 MCP 集成。
 *
 * SDK 自带 `createMcpExtension()`（会话启动时连接 mcp.json 里的服务器），
 * 但在 SDK 模式下不会自动加载 —— 必须显式列进
 * `resourceLoaderOptions.extensionFactories`。这一层包装负责三件事：
 *  - 遵守桌面端总开关（`mcp-config.json` 的 `enabled`，默认 ON）：关闭时
 *    factory 直接返回、不注册任何东西，因此不会有任何后台 spawn / HTTP 连接；
 *  - 强制只读用户级配置（`loadMcpServers()`），覆盖 SDK 默认行为 —— 后者在
 *    项目「受信任」时还会读 `<项目>/.pi/mcp.json`，而 SDK 的 projectTrusted
 *    默认为 true，等于克隆来的仓库可以注入任意 stdio 命令；
 *  - 为无人值守（定时任务）会话缩短首个 prompt 的等待时间。
 *
 * 单次工具调用的权限闸不在这里，而在 PiSessionManager 的 tool guard 里
 * （见 evaluateMcp）：MCP 调用和内置工具一样走 Pi 的 `tool_call` 钩子。
 */
import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { loadMcpServers, readMcpFeatureConfigSync } from "./mcp-config";

export interface McpMountOptions {
  /** 无人值守（定时任务）会话：缩短首个 prompt 等待 direct 工具的时间。 */
  unattended?: boolean;
}

/** 默认等待时间与 SDK 保持一致（10s）。 */
const STARTUP_WAIT_MS = 10_000;
/** 无人值守用例：不该为了 MCP 卡住整次定时任务。 */
const STARTUP_WAIT_UNATTENDED_MS = 3_000;

export function createMcpMount(options: McpMountOptions = {}): InlineExtension {
  const { unattended = false } = options;
  return {
    name: "mcp",
    factory: (pi) => {
      if (!readMcpFeatureConfigSync().enabled) return; // 总开关关闭 → 不注册
      // codemode / tool_search 是 MCP 工具的两条「间接调用通道」——exposure 为
      // codemode（默认）/ deferred 的工具只能从它们内部调到。SDK 模式下二者都
      // 不会自动加载，必须显式挂载，否则 SDK 会判定工具不可达并只弹一条 warning。
      // 二者注册时都是 inactive：仅当确有服务器使用对应 exposure（且未禁用
      // autoEnableCodemode）时 MCP 扩展才激活它们 —— 用不到时零上下文开销。
      createCodemodeExtension()(pi);
      createToolSearchExtension()(pi);
      createMcpExtension({
        loadConfig: () => loadMcpServers(),
        startupWaitMs: unattended ? STARTUP_WAIT_UNATTENDED_MS : STARTUP_WAIT_MS,
      })(pi);
    },
  };
}
