/**
 * IM ↔ Pi session mapping.
 *
 * Each IM conversation (channel:peer) owns one Pi session file persisted under
 * chat/im/<channel>/ — fully isolated from desktop-shell sessions. The map is
 * persisted so a restart keeps the same conversation continuous.
 */
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PiDeskSessionManager } from "../pi/session-manager";

/** Directory under which all IM sessions live (relative to chat/). */
export const IM_CHAT_SUBDIR = "im";

/**
 * Read the `cwd` from a session file header without loading the whole file
 * (history can be megabytes). The header is the first JSON line.
 */
export async function readSessionCwd(sessionPath: string): Promise<string> {
  const fd = await open(sessionPath, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    const head = buf.toString("utf8", 0, bytesRead);
    const firstLine = head.split("\n")[0] ?? "";
    const header = JSON.parse(firstLine.trim()) as any;
    if (typeof header?.cwd === "string" && header.cwd) return header.cwd;
    throw new Error(`Session header has no cwd: ${sessionPath}`);
  } finally {
    await fd.close();
  }
}

/**
 * Session-directory name for a cwd, mirroring the SDK's encoding
 * (getDefaultSessionDirPath): `--` + cwd with leading slash stripped and
 * `/` `\` `:` replaced by `-`, wrapped in `--`. Sessions live under
 * <agentDir>/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl.
 */
export function sessionDirFor(cwd: string, agentDir: string = getAgentDir()): string {
  const resolved = resolve(cwd);
  const safePath = `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "sessions", safePath);
}

export class ImSessionMap {
  private map: Record<string, string> = {};
  private readonly file: string;
  private readonly chatRoot: string;

  constructor(
    private readonly piManager: PiDeskSessionManager,
  ) {
    this.chatRoot = join(getAgentDir(), "chat");
    this.file = join(this.chatRoot, "im-session-map.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, "utf-8");
      this.map = JSON.parse(raw) as Record<string, string>;
    } catch {
      this.map = {};
    }
  }

  private async persist(): Promise<void> {
    await mkdir(this.chatRoot, { recursive: true });
    await writeFile(this.file, JSON.stringify(this.map, null, 2), "utf-8");
  }

  /**
   * Look up (or create) the Pi session for an IM conversation key
   * (e.g. "dingtalk:conv-xxx"). New sessions live in chat/im/<channel>/
   * unless the channel instance configured a default workspace (cwdOverride).
   * An already-mapped session always keeps its original cwd.
   */
  async ensureSession(sessionKey: string, cwdOverride?: string): Promise<string> {
    const existing = this.map[sessionKey];
    if (existing) return existing;
    const channel = sessionKey.split(":")[0] ?? "im";
    const cwd = cwdOverride ?? join(this.chatRoot, IM_CHAT_SUBDIR, channel);
    await mkdir(cwd, { recursive: true });
    const path = await this.piManager.newSession(cwd);
    if (!path) throw new Error("Failed to create IM session");
    this.map[sessionKey] = path;
    await this.persist();
    return path;
  }

  /** Reset a conversation: drop the mapping so the next message starts fresh. */
  async delete(sessionKey: string): Promise<void> {
    if (!this.map[sessionKey]) return;
    delete this.map[sessionKey];
    await this.persist();
  }

  /**
   * All session keys owned by one channel instance (prefix
   * `<channel>:<instanceId>:`).
   */
  keysForInstance(channel: string, instanceId: string): string[] {
    const prefix = `${channel}:${instanceId}:`;
    return Object.keys(this.map).filter((k) => k.startsWith(prefix));
  }

  /**
   * Migrate an existing conversation to a new cwd: move its .jsonl file into
   * the sessions/<encoded-cwd>/ directory of the new workspace, rewrite the
   * session header's `cwd` field, and update the map. The conversation stays
   * continuous (same sessionId) — only its "home" directory changes.
   * Returns the new session path.
   */
  async migrate(sessionKey: string, newCwd: string): Promise<string> {
    const oldPath = this.map[sessionKey];
    if (!oldPath) {
      throw new Error(`No session mapped for ${sessionKey}`);
    }
    const newDir = sessionDirFor(newCwd);
    const newPath = join(newDir, basename(oldPath));
    if (newPath === oldPath) {
      return oldPath; // already there — nothing to do
    }
    const raw = await readFile(oldPath, "utf-8");
    const newlineIdx = raw.indexOf("\n");
    const firstLine = (newlineIdx >= 0 ? raw.slice(0, newlineIdx) : raw).trim();
    if (!firstLine) {
      throw new Error(`Session file is empty: ${oldPath}`);
    }
    let header: any;
    try {
      header = JSON.parse(firstLine);
    } catch {
      throw new Error(`Session header is not JSON: ${oldPath}`);
    }
    if (header?.type !== "session") {
      throw new Error(`Not a session file: ${oldPath}`);
    }
    header.cwd = newCwd;
    const rest = newlineIdx >= 0 ? raw.slice(newlineIdx) : "\n";
    await mkdir(newDir, { recursive: true });
    await writeFile(newPath, `${JSON.stringify(header)}${rest}`, "utf-8");
    await rm(oldPath, { force: true });
    this.map[sessionKey] = newPath;
    await this.persist();
    return newPath;
  }

  /** Inverse lookup: Pi sessionPath → IM sessionKey (for event routing). */
  keyForSessionPath(sessionPath: string): string | null {
    for (const [key, path] of Object.entries(this.map)) {
      if (path === sessionPath) return key;
    }
    return null;
  }

  /** Mapped session path for a conversation key, or undefined. */
  pathOf(sessionKey: string): string | undefined {
    return this.map[sessionKey];
  }

  hasSessionPath(sessionPath: string): boolean {
    return this.keyForSessionPath(sessionPath) !== null;
  }
}
