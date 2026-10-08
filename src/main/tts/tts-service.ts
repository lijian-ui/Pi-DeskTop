/**
 * TTS service — MiMo-V2.5-TTS speech synthesis via OpenAI-compatible API.
 *
 * Config is persisted to ~/.pi/agent/tts-config.json (separate from
 * settings.json so API keys stay isolated). Non-streaming returns a complete
 * WAV (base64); streaming yields PCM16 chunks (24kHz mono) via callback.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import axios from "axios";
import { parseJsonText } from "../json-file";
import { MIMO_VOICES } from "../../shared/tts-voices";

export { MIMO_VOICES };

const MIMO_BASE_URL = "https://api.xiaomimimo.com/v1";
const TTS_CONFIG_FILE = "tts-config.json";

/** One TTS provider configuration. */
export interface TtsConfigItem {
  id: string;
  name: string;
  model: "mimo-v2.5-tts";
  apiKey: string;
  /** Preset voice ID (冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean). */
  voice: string;
  /** Natural-language style instruction (placed in user message). */
  style: string;
}

/** Top-level TTS config persisted to disk. */
export interface TtsConfig {
  configs: TtsConfigItem[];
  activeConfigId: string | null;
  /** Global switch: when on, LLM streams text → TTS plays audio in sync. */
  streamEnabled: boolean;
}

const DEFAULT_CONFIG: TtsConfig = {
  configs: [],
  activeConfigId: null,
  streamEnabled: false,
};


function configPath(): string {
  return join(getAgentDir(), TTS_CONFIG_FILE);
}

export async function readTtsConfig(): Promise<TtsConfig> {
  try {
    const raw = await readFile(configPath(), "utf-8");
    const parsed = parseJsonText<Partial<TtsConfig>>(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function writeTtsConfig(cfg: TtsConfig): Promise<void> {
  const dir = getAgentDir();
  await mkdir(dir, { recursive: true });
  await writeFile(configPath(), JSON.stringify(cfg, null, 2), "utf-8");
}

/** Resolve the active config item (or null if none selected / not found). */
export async function getActiveTtsConfig(): Promise<TtsConfigItem | null> {
  const cfg = await readTtsConfig();
  if (!cfg.activeConfigId) return null;
  return cfg.configs.find((c) => c.id === cfg.activeConfigId) ?? null;
}

/**
 * Non-streaming TTS synthesis. Returns base64-encoded WAV audio.
 * The style instruction goes in the user message; the text to synthesize
 * goes in the assistant message (MiMo's convention).
 */
export async function synthesizeSpeech(
  config: TtsConfigItem,
  text: string,
): Promise<{ audioBase64: string; format: string }> {
  const messages: any[] = [];
  if (config.style?.trim()) {
    messages.push({ role: "user", content: config.style.trim() });
  }
  messages.push({ role: "assistant", content: text });


  console.log("[tts] synthesize start; textLen=", text.length, "voice=", config.voice, "hasApiKey=", !!config.apiKey);
  const res = await axios.post(
    `${MIMO_BASE_URL}/chat/completions`,
    {
      model: config.model,
      messages,
      audio: { format: "wav", voice: config.voice },
    },
    {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 60_000,
    },
  );

  const audioData = res.data?.choices?.[0]?.message?.audio?.data;
  if (!audioData) {
    console.error("[tts] synthesize returned no audio data; body=", JSON.stringify(res.data).slice(0, 400));
    throw new Error("TTS API returned no audio data");
  }
  console.log("[tts] synthesize ok; audioBase64Len=", audioData.length);
  return { audioBase64: audioData, format: "wav" };
}

/**
 * Streaming TTS synthesis. Calls onChunk for each PCM16 audio chunk
 * (base64-encoded, 24kHz mono). Returns when all chunks are delivered.
 */
export async function synthesizeSpeechStream(
  config: TtsConfigItem,
  text: string,
  onChunk: (pcmBase64: string) => void,
  abortSignal?: AbortSignal,
): Promise<void> {
  const messages: any[] = [];
  if (config.style?.trim()) {
    messages.push({ role: "user", content: config.style.trim() });
  }
  messages.push({ role: "assistant", content: text });

  const res = await axios.post(
    `${MIMO_BASE_URL}/chat/completions`,
    {
      model: config.model,
      messages,
      audio: { format: "pcm16", voice: config.voice },
      stream: true,
    },
    {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      responseType: "stream",
      timeout: 60_000,
      signal: abortSignal,
    },
  );

  // Parse SSE stream: lines starting with "data: " contain JSON chunks.
  let buffer = "";
  for await (const chunk of res.data as any) {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const json = JSON.parse(payload);
        const audio = json?.choices?.[0]?.delta?.audio;
        if (audio?.data) onChunk(audio.data);
      } catch {
        /* skip malformed line */
      }
    }
  }
}