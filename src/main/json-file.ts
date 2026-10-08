/**
 * JSON 文件读取小工具：统一剥离 UTF-8 BOM。
 *
 * 背景：Windows 记事本「另存为 UTF-8」会在文件头写入 BOM(\uFEFF)，而 `JSON.parse`
 * 遇到 BOM 会直接抛 `Unexpected token`。各配置读取函数普遍是
 * `try { JSON.parse(readFileSync(p, "utf-8")) } catch { return 默认值 }`，
 * 于是 BOM 被静默吞掉、整份配置回退默认值。所有从磁盘读 JSON 的地方都应走这里。
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

/** 去掉可能存在的 UTF-8 BOM。 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 解析 JSON 文本，自动兼容 BOM。 */
// 默认泛型取 any：本函数是 `JSON.parse(readFileSync(...))` 的直接替代，
// 保持与原 `JSON.parse` 一致的 any 语义（调用方需要类型时自行传 <T>）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseJsonText<T = any>(text: string): T {
  return JSON.parse(stripBom(text)) as T;
}

/** 同步读取并解析 JSON 文件（兼容 BOM）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readJsonFileSync<T = any>(path: string): T {
  return parseJsonText<T>(readFileSync(path, "utf-8"));
}

/** 异步读取并解析 JSON 文件（兼容 BOM）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readJsonFile<T = any>(path: string): Promise<T> {
  return parseJsonText<T>(await readFile(path, "utf-8"));
}
