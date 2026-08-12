/**
 * IM gateway config — read/write of `im-config.json` (per-channel credentials,
 * per-instance enable flag). Stored OUTSIDE settings.json so Pi config and IM
 * credentials stay separate; secrets are never logged.
 *
 * Model: the user may configure MULTIPLE channel instances (e.g. two DingTalk
 * robots). Each instance = one ImChannelInstance; the gateway builds one
 * adapter per enabled, fully-configured instance.
 *
 * NOTE: there is no whitelist anymore — access control is delegated to the
 * platform (e.g. DingTalk's bot permission settings), since the agent has a
 * bash tool and each platform already provides its own restrictions.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Channel protocol type. Add new channels here (qq / feishu / …). */
export type ImChannelType = "dingtalk" | "weixin" | "qq";

/** One configured channel instance (a robot / bot on a specific platform). */
export interface ImChannelInstance {
  /** Unique instance id (uuid). Also used to isolate conversations. */
  id: string;
  /** User-facing name, e.g. "公司钉钉机器人". */
  name: string;
  type: ImChannelType;
  enabled: boolean;
  /** Channel-specific credentials, keyed by channel:
   *  - dingtalk: clientId / clientSecret
   *  - weixin:   token / botId / baseUrl / userId — written by the QR login
   *    flow (no appId/appSecret; WeChat binds via scan).
   *  - qq:       appId / appSecret — written by the QR binding flow. */
  config: Record<string, string>;
  /**
   * Optional default workspace for this channel. IM conversations are
   * created/prompted with this directory as cwd. When unset, sessions fall
   * back to chat/im/<channel>. Changing it only affects NEW conversations —
   * already-mapped sessions keep their original cwd.
   */
  cwd?: string;
}

export interface ImConfig {
  /** Channel instances. Each one has its own `enabled` toggle — there is no
   *  global master switch anymore (it lived inside the channel cards). */
  channels: ImChannelInstance[];
}

const IM_CONFIG_FILE = "im-config.json";

export async function readImConfig(): Promise<ImConfig> {
  try {
    const raw = await readFile(join(getAgentDir(), IM_CONFIG_FILE), "utf-8");
    const parsed = JSON.parse(raw) as any;
    return migrateImConfig(parsed);
  } catch {
    return { channels: [] }; // default: no channels
  }
}

/**
 * Migrate the legacy single-channel shape ({ enabled, dingtalk? }) to the
 * channels[] model, preserving any existing credentials.
 */
function migrateImConfig(raw: any): ImConfig {
  if (Array.isArray(raw?.channels)) {
    return { channels: raw.channels };
  }
  const channels: ImChannelInstance[] = [];
  const dt = raw?.dingtalk;
  if (dt && (dt.clientId || dt.clientSecret)) {
    channels.push({
      id: "dingtalk-default",
      name: "钉钉机器人",
      type: "dingtalk",
      // The legacy global switch maps onto this single instance's own toggle.
      enabled: raw?.enabled !== false,
      config: {
        clientId: dt.clientId ?? "",
        clientSecret: dt.clientSecret ?? "",
      },
    });
  }
  return { channels };
}

export async function writeImConfig(cfg: ImConfig): Promise<void> {
  const dir = getAgentDir();
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, IM_CONFIG_FILE),
    JSON.stringify(cfg, null, 2),
    "utf-8",
  );
}
