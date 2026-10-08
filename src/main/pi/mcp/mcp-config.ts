/**
 * MCP 管理配置 — 桌面端的 MCP 总开关 + `~/.pi/agent/mcp.json` 的读写。
 *
 * 两件事分开存放，互不污染：
 *  - `mcp.json`：与 CLI / Claude Desktop / Cursor 互通的服务器定义（唯一真相源），
 *    桌面端只做编辑器，schema 完全沿用 SDK 的 `mcpServers` 形状。
 *  - `mcp-config.json`：桌面端自己的开关（可用工具页的「MCP」特性）与授权白名单。
 *
 * SDK 的 `loadMcpConfig` / `addMcpServerConfig` 等并未从包根导出（package.json 的
 * exports 只暴露 `.`），所以这里自己实现读写。好处是可以**强制 projectTrusted=false**：
 * 只读用户级 mcp.json，避免克隆来的仓库通过 `<项目>/.pi/mcp.json` 注入 stdio 服务器
 * （= 无提示执行任意本地命令）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  getAgentDir,
  type LoadedMcpConfig,
  type McpExposure,
  type McpServerConfig,
  type McpServerEntry,
} from "@earendil-works/pi-coding-agent";
import type { McpConfigView, McpServerDef } from "../../../shared/mcp-types";
import { parseJsonText, readJsonFile, readJsonFileSync } from "../../json-file";

export interface McpFeatureConfig {
  /** 总开关（默认 ON）。关掉则不注册 MCP 扩展，不会后台 spawn 任何子进程。 */
  enabled: boolean;
  /** 常驻授权的服务器名：这些服务器的工具调用不再弹窗（交互式会话）。 */
  autoApproveServers: string[];
  /** 无人值守会话（定时任务）允许调用的服务器名。白名单外一律硬拒绝。 */
  unattendedServers: string[];
}

const MCP_FEATURE_CONFIG_FILE = "mcp-config.json";
const MCP_JSON_FILE = "mcp.json";

const EXPOSURES: readonly McpExposure[] = ["codemode", "deferred", "direct", "hidden"];

// ── 桌面端自己的开关 ────────────────────────────────────────────────

function defaultFeatureConfig(): McpFeatureConfig {
  return { enabled: true, autoApproveServers: [], unattendedServers: [] };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

function normalizeFeature(raw: unknown): McpFeatureConfig {
  if (!raw || typeof raw !== "object") return defaultFeatureConfig();
  const r = raw as Record<string, unknown>;
  return {
    enabled: r.enabled !== false, // absent → default true
    autoApproveServers: toStringArray(r.autoApproveServers),
    unattendedServers: toStringArray(r.unattendedServers),
  };
}

export async function readMcpFeatureConfig(): Promise<McpFeatureConfig> {
  try {
    return normalizeFeature(await readJsonFile(featureConfigPath()));
  } catch {
    return defaultFeatureConfig();
  }
}

/** Synchronous read for the extension factory / tool-filter path. */
export function readMcpFeatureConfigSync(): McpFeatureConfig {
  try {
    return normalizeFeature(readJsonFileSync(featureConfigPath()));
  } catch {
    return defaultFeatureConfig();
  }
}

export async function writeMcpFeatureConfig(config: McpFeatureConfig): Promise<void> {
  const path = featureConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(normalizeFeature(config), null, 2), "utf-8");
}

function featureConfigPath(): string {
  return join(getAgentDir(), MCP_FEATURE_CONFIG_FILE);
}

// ── `mcp.json`（与 CLI 共享） ───────────────────────────────────────

export function mcpJsonPath(): string {
  return join(getAgentDir(), MCP_JSON_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 服务器命名空间：与 SDK 的 mcpNamespace 一致（`-` 归一为 `_`）。 */
function mcpNamespace(name: string): string {
  return `mcp__${name.replace(/-/g, "_")}`;
}

/**
 * 最小校验：只保证结构可用，具体语义（env/headers 展开等）交给 SDK。
 * 返回规范化后的 config，或一段错误说明。
 */
function validateServerConfig(name: string, raw: unknown): McpServerConfig | string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return `server "${name}"：名称只能包含字母、数字、_ 和 -`;
  }
  if (!isRecord(raw)) return `server "${name}"：配置必须是一个对象`;

  const hasCommand = typeof raw.command === "string" && raw.command.length > 0;
  const hasUrl = typeof raw.url === "string" && raw.url.length > 0;
  if (hasCommand && hasUrl) return `server "${name}"：command 与 url 只能有一个`;
  if (!hasCommand && !hasUrl) return `server "${name}"：需要 command（stdio）或 url（http）`;

  const config: Record<string, unknown> = {};
  if (hasCommand) {
    config.command = raw.command;
    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== "string")) {
        return `server "${name}"：args 必须是字符串数组`;
      }
      config.args = raw.args;
    }
    if (raw.env !== undefined) {
      if (!isRecord(raw.env)) return `server "${name}"：env 必须是对象`;
      config.env = raw.env;
    }
    if (raw.cwd !== undefined) {
      if (typeof raw.cwd !== "string") return `server "${name}"：cwd 必须是字符串`;
      config.cwd = raw.cwd;
    }
  } else {
    config.url = raw.url;
    if (raw.headers !== undefined) {
      if (!isRecord(raw.headers)) return `server "${name}"：headers 必须是对象`;
      config.headers = raw.headers;
    }
    if (raw.oauth !== undefined) {
      if (!isRecord(raw.oauth)) return `server "${name}"：oauth 必须是对象`;
      config.oauth = raw.oauth;
    }
    if (raw.auth !== undefined) {
      if (!isRecord(raw.auth) || typeof raw.auth.provider !== "string") {
        return `server "${name}"：auth 需要 { provider: string }`;
      }
      config.auth = raw.auth;
    }
  }

  if (raw.exposure !== undefined) {
    const exposure = raw.exposure === "codemode-deferred" ? "codemode" : raw.exposure;
    if (typeof exposure !== "string" || !EXPOSURES.includes(exposure as McpExposure)) {
      return `server "${name}"：exposure 必须是 ${EXPOSURES.join(" / ")}`;
    }
    config.exposure = exposure as McpExposure;
  }
  if (raw.toolExposure !== undefined) {
    if (!isRecord(raw.toolExposure)) return `server "${name}"：toolExposure 必须是对象`;
    config.toolExposure = raw.toolExposure;
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") return `server "${name}"：enabled 必须是布尔值`;
    config.enabled = raw.enabled;
  }
  if (raw.timeout !== undefined) {
    if (typeof raw.timeout !== "number" || !Number.isFinite(raw.timeout) || raw.timeout <= 0) {
      return `server "${name}"：timeout 必须是正数（秒）`;
    }
    config.timeout = raw.timeout;
  }
  if (raw.description !== undefined) {
    if (typeof raw.description !== "string") return `server "${name}"：description 必须是字符串`;
    config.description = raw.description;
  }
  if (raw.type !== undefined) {
    if (raw.type !== "stdio" && raw.type !== "http" && raw.type !== "streamable-http") {
      return `server "${name}"：type 必须是 stdio / http / streamable-http`;
    }
    config.type = raw.type;
  }
  return config as unknown as McpServerConfig;
}

/**
 * 只读用户级 `~/.pi/agent/mcp.json`（projectTrusted 恒为 false）。
 * 返回结构可直接作为 `createMcpExtension({ loadConfig })` 的返回值。
 */
export function loadMcpServers(): LoadedMcpConfig {
  const path = mcpJsonPath();
  const errors: string[] = [];
  const servers: McpServerEntry[] = [];
  let autoEnableCodemode: boolean | undefined;

  if (!existsSync(path)) return { servers, errors };

  let parsed: unknown;
  try {
    parsed = readJsonFileSync(path);
  } catch (error) {
    errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return { servers, errors };
  }
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    errors.push(`${path}: 需要一个带 "mcpServers" 对象的 JSON`);
    return { servers, errors };
  }
  if (typeof parsed.autoEnableCodemode === "boolean") {
    autoEnableCodemode = parsed.autoEnableCodemode;
  } else if (parsed.autoEnableCodemode !== undefined) {
    errors.push(`${path}: autoEnableCodemode 必须是布尔值`);
  }

  const seen = new Map<string, string>();
  for (const [name, value] of Object.entries((parsed.mcpServers as Record<string, unknown>) ?? {})) {
    const config = validateServerConfig(name, value);
    if (typeof config === "string") {
      errors.push(`${path}: ${config}`);
      continue;
    }
    // 仅忽略 `-`/`_` 差异的名字会共用同一个命名空间。
    const namespace = mcpNamespace(name);
    const clash = [...seen.entries()].find(([other, otherNs]) => other !== name && otherNs === namespace);
    if (clash) {
      errors.push(`${path}: server "${name}" 与 "${clash[0]}" 命名冲突`);
      continue;
    }
    seen.set(name, namespace);
    servers.push({ name, config, source: path, scope: "global" });
  }

  return { servers, ...(autoEnableCodemode === undefined ? {} : { autoEnableCodemode }), errors };
}

/** 服务器列表（含 disabled 的，便于 UI 重新启用）。 */
export function listMcpServers(): McpServerEntry[] {
  return loadMcpServers().servers;
}

/**
 * 从工具名 `mcp__<server>__<tool>` 反解出 mcp.json 里的服务器名。
 *
 * SDK 会把整个名字里非 `[A-Za-z0-9_]` 的字符替换成 `_`（`createMcpToolName`），
 * 且服务器名本身允许含 `_`，所以不能只按第一个 `__` 切分 —— 改为对已知服务器
 * 做**最长前缀匹配**。找不到时返回 undefined（例如别的扩展用
 * `pi.registerMcpServer()` 注册的服务器）。
 */
export function mcpServerNameForTool(toolName: string): string | undefined {
  if (!toolName.startsWith("mcp__")) return undefined;
  const rest = toolName.slice("mcp__".length);
  let best: string | undefined;
  for (const { name } of listMcpServers()) {
    const ns = name.replace(/[^A-Za-z0-9_]/g, "_");
    if (rest.startsWith(`${ns}__`) && (best === undefined || name.length > best.length)) {
      best = name;
    }
  }
  return best;
}

/** 是否存在 enabled 的服务器，以及各自 exposure 的能力。 */
export function mcpServerCapabilities(): {
  hasEnabled: boolean;
  hasCodemode: boolean;
  hasDeferred: boolean;
  /** mcp.json 顶层 autoEnableCodemode 的生效值（未设置按 true）。 */
  autoEnableCodemode: boolean;
} {
  const loaded = loadMcpServers();
  let hasEnabled = false;
  let hasCodemode = false;
  let hasDeferred = false;
  for (const { config } of loaded.servers) {
    if (config.enabled === false) continue;
    hasEnabled = true;
    const exposure = (config as { exposure?: McpExposure }).exposure ?? "codemode";
    if (exposure === "codemode") hasCodemode = true;
    if (exposure === "deferred") hasDeferred = true;
  }
  return {
    hasEnabled,
    hasCodemode,
    hasDeferred,
    autoEnableCodemode: loaded.autoEnableCodemode !== false,
  };
}

/** 读-改-写 `mcp.json`，保留其他内容与缩进（对齐 SDK 的 editMcpServers）。 */
function editMcpServers(path: string, edit: (servers: Record<string, unknown>) => boolean): void {
  const text = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const parsed: Record<string, unknown> = text === undefined ? {} : parseJsonText<Record<string, unknown>>(text);
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    throw new Error(`${path}: 需要一个带 "mcpServers" 对象的 JSON`);
  }
  const servers = isRecord(parsed.mcpServers) ? (parsed.mcpServers as Record<string, unknown>) : {};
  if (!edit(servers)) return;
  parsed.mcpServers = servers;
  const indent = (text && /^([ \t]+)\S/m.exec(text)?.[1]) || "  ";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(parsed, null, indent)}\n`);
}

/** 新增或整条替换一个服务器。返回 true 表示覆盖了已存在的同名条目。 */
export function upsertMcpServer(name: string, config: McpServerDef): boolean {
  const validated = validateServerConfig(name, config);
  if (typeof validated === "string") throw new Error(validated);
  let replaced = false;
  editMcpServers(mcpJsonPath(), (servers) => {
    replaced = servers[name] !== undefined;
    servers[name] = validated;
    return true;
  });
  return replaced;
}

/** 只改 enabled / exposure（`true` 与 `"codemode"` 是默认值，写回时删除该键）。 */
export function patchMcpServer(
  name: string,
  patch: { enabled?: boolean; exposure?: McpExposure },
): void {
  editMcpServers(mcpJsonPath(), (servers) => {
    const server = servers[name];
    if (!isRecord(server)) throw new Error(`mcp.json 未定义服务器 "${name}"`);
    if (patch.enabled !== undefined) {
      if (patch.enabled) delete server.enabled;
      else server.enabled = false;
    }
    if (patch.exposure !== undefined) {
      if (patch.exposure === "codemode") delete server.exposure;
      else server.exposure = patch.exposure;
    }
    return true;
  });
}

/** 删除一个服务器。返回 false 表示原本就不存在。 */
export function dropMcpServer(name: string): boolean {
  const path = mcpJsonPath();
  if (!existsSync(path)) return false;
  let removed = false;
  editMcpServers(path, (servers) => {
    if (servers[name] === undefined) return false;
    delete servers[name];
    removed = true;
    return true;
  });
  return removed;
}

/** 设置页读取的完整视图（总开关 + 白名单 + 服务器列表 + 解析错误）。 */
export function getMcpConfigView(): McpConfigView {
  const feature = readMcpFeatureConfigSync();
  const loaded = loadMcpServers();
  return {
    enabled: feature.enabled,
    autoApproveServers: feature.autoApproveServers,
    unattendedServers: feature.unattendedServers,
    jsonPath: mcpJsonPath(),
    ...(loaded.autoEnableCodemode === undefined
      ? {}
      : { autoEnableCodemode: loaded.autoEnableCodemode }),
    servers: loaded.servers.map((s) => ({
      name: s.name,
      // 渲染进程只读这里声明过的字段（其余如 oauth 由 SDK 处理，UI 不暴露）。
      config: s.config as unknown as McpServerDef,
      source: s.source,
    })),
    errors: loaded.errors,
  };
}
