/**
 * MCP（Model Context Protocol）设置页的共享载荷类型。
 *
 * 服务器定义存放在 `~/.pi/agent/mcp.json`（与 CLI / Claude Desktop / Cursor
 * 共享，schema 沿用 SDK 的 `mcpServers`），桌面端只做编辑器；总开关与两个授权
 * 白名单存在 `~/.pi/agent/mcp-config.json`（桌面端自己的文件，不污染 mcp.json）。
 */

/** 工具对模型的暴露方式（与 SDK 的 `McpExposure` 一致；`codemode` 为默认值）。 */
export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";

/** 单个 MCP 服务器定义。stdio（command）与 http（url）二选一。 */
export interface McpServerDef {
  /** stdio：可执行文件（如 `npx`） */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** http / streamable-http：服务地址 */
  url?: string;
  headers?: Record<string, string>;
  type?: "stdio" | "http" | "streamable-http";
  exposure?: McpExposure;
  /** 单工具覆盖服务器级 exposure（工具名 → exposure） */
  toolExposure?: Record<string, McpExposure>;
  /** false 表示不连接（默认 true） */
  enabled?: boolean;
  /** 单次调用超时（秒） */
  timeout?: number;
  description?: string;
}

export interface McpServerView {
  name: string;
  config: McpServerDef;
  /** 定义来源文件（当前恒为 mcp.json 路径） */
  source: string;
}

/** 设置页读取的完整视图。 */
export interface McpConfigView {
  /** 总开关（关掉则不注册 MCP 扩展，不会 spawn 任何子进程） */
  enabled: boolean;
  /** 常驻授权：列出的服务器，交互式会话里调用不再弹窗 */
  autoApproveServers: string[];
  /** 无人值守（定时任务）会话允许调用的服务器白名单 */
  unattendedServers: string[];
  /** mcp.json 路径（只读展示） */
  jsonPath: string;
  /** mcp.json 顶层 autoEnableCodemode（未设置时 undefined —— SDK 按 true 处理） */
  autoEnableCodemode?: boolean;
  servers: McpServerView[];
  /** 解析 mcp.json 时发现的问题（原样展示给用户） */
  errors: string[];
}

/** 总开关 + 两个白名单的整体保存。 */
export interface McpFeaturePatch {
  enabled: boolean;
  autoApproveServers: string[];
  unattendedServers: string[];
}

/** 新增或整条替换一个服务器。 */
export interface McpServerUpsert {
  name: string;
  config: McpServerDef;
}

/** 只改开关 / 暴露方式（`true` 与 `"codemode"` 是默认值，写回时删除该键）。 */
export interface McpServerPatch {
  enabled?: boolean;
  exposure?: McpExposure;
}
