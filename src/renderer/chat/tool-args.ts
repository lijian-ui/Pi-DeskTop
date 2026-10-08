/**
 * 工具参数 → 单行摘要。
 *
 * 被两处复用，所以独立成模块（放在组件文件里导出会破坏 Fast Refresh）：
 *  - ToolExecution：工具行的参数 chip（展开前就能看到参数）
 *  - ThinkingTools：折叠态标题行的实时尾巴（正在跑哪个工具、参数是什么）
 *
 * 规则：
 *  - arguments 可能是 JSON 字符串或对象，先归一化成对象
 *  - 按工具名优先取关键字段（bash→command、read/write→filePath、grep→pattern…）
 *  - 单字段对象直接显示值；多字段回退紧凑 JSON
 */
export function summarizeArgs(toolName: string, input: any): string {
  if (input == null) return "";
  let obj: any = input;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return obj; // 不是 JSON，原样显示
    }
  }
  if (typeof obj === "string") return obj;
  if (typeof obj === "number" || typeof obj === "boolean") return String(obj);
  if (Array.isArray(obj)) return JSON.stringify(obj);
  if (typeof obj !== "object") return "";

  // Pi SDK 内置工具（docs/sdk.md:492）：read / bash / edit / write / grep / find / ls
  const byTool: Record<string, string[]> = {
    bash: ["command"],
    read: ["filePath", "path", "file"],
    write: ["filePath", "path", "file"],
    edit: ["filePath", "path", "file"],
    grep: ["pattern", "query"],
    find: ["path", "dir", "name"],
    ls: ["path", "dir"],
  };
  const preferred = byTool[toolName] ?? [];
  for (const k of preferred) {
    const v = obj[k];
    if (v != null) {
      return typeof v === "string" ? v : JSON.stringify(v);
    }
  }

  const keys = Object.keys(obj);
  if (keys.length === 1) {
    const v = obj[keys[0]];
    return typeof v === "string" ? v : JSON.stringify(v);
  }
  try {
    return JSON.stringify(obj);
  } catch {
    return "";
  }
}