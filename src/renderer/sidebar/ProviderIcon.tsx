/**
 * Provider icon component.
 *
 * Maps a provider id to a brand SVG from @lobehub/icons when available
 * (Color variants for self-colored logos, Mono variants that inherit theme
 * text color for monochrome marks). Falls back to a two-letter placeholder
 * for unknown providers.
 *
 * IDs we render here mirror the SDK's built-in provider ids (see
 * `@earendil-works/pi-ai` dist/providers/*.js) so the picker modal stays in
 * sync with whatever the SDK ships.
 */
import type { ComponentType, CSSProperties } from "react";

import AnthropicIcon from "@lobehub/icons/es/Anthropic/components/Mono";
import OpenAIIcon from "@lobehub/icons/es/OpenAI/components/Mono";
import GoogleColorIcon from "@lobehub/icons/es/Google/components/Color";
import DeepSeekColorIcon from "@lobehub/icons/es/DeepSeek/components/Color";
import GroqIcon from "@lobehub/icons/es/Groq/components/Mono";
import MistralColorIcon from "@lobehub/icons/es/Mistral/components/Color";
import MoonshotIcon from "@lobehub/icons/es/Moonshot/components/Mono";
import MinimaxColorIcon from "@lobehub/icons/es/Minimax/components/Color";
import FireworksColorIcon from "@lobehub/icons/es/Fireworks/components/Color";
import HuggingFaceColorIcon from "@lobehub/icons/es/HuggingFace/components/Color";
import CerebrasColorIcon from "@lobehub/icons/es/Cerebras/components/Color";
import OpenRouterIcon from "@lobehub/icons/es/OpenRouter/components/Mono";
import XAIIcon from "@lobehub/icons/es/XAI/components/Mono";
import CloudflareColorIcon from "@lobehub/icons/es/Cloudflare/components/Color";
import VercelIcon from "@lobehub/icons/es/Vercel/components/Mono";
import GithubCopilotIcon from "@lobehub/icons/es/GithubCopilot/components/Mono";
import AwsColorIcon from "@lobehub/icons/es/Aws/components/Color";
import AzureColorIcon from "@lobehub/icons/es/Azure/components/Color";
import KimiColorIcon from "@lobehub/icons/es/Kimi/components/Color";
import QwenColorIcon from "@lobehub/icons/es/Qwen/components/Color";
import ZhipuColorIcon from "@lobehub/icons/es/Zhipu/components/Color";
import CohereColorIcon from "@lobehub/icons/es/Cohere/components/Color";
import PerplexityColorIcon from "@lobehub/icons/es/Perplexity/components/Color";
import TogetherColorIcon from "@lobehub/icons/es/Together/components/Color";
import GrokIcon from "@lobehub/icons/es/Grok/components/Mono";
import AntGroupColorIcon from "@lobehub/icons/es/AntGroup/components/Color";
import NvidiaColorIcon from "@lobehub/icons/es/Nvidia/components/Color";
import OpenCodeIcon from "@lobehub/icons/es/OpenCode/components/Mono";
import XiaomiMiMoIcon from "@lobehub/icons/es/XiaomiMiMo/components/Mono";
import ZAIIcon from "@lobehub/icons/es/ZAI/components/Mono";
import LmStudioMonoIcon from "@lobehub/icons/es/LmStudio/components/Mono";
import OllamaMonoIcon from "@lobehub/icons/es/Ollama/components/Mono";
import AgnesAIMonoIcon from "@lobehub/icons/es/AgnesAI/components/Mono";

type IconComponent = ComponentType<{
  size?: number | string;
  style?: CSSProperties;
}>;

interface IconEntry {
  Icon: IconComponent;
  /** Self-colored SVG; render directly. False = mono, inherit currentColor. */
  hasColor: boolean;
}

/** id → (Icon, hasColor). Adapted from @agegr/pi-web's ModelsConfig. */
const PROVIDER_ICONS: Record<string, IconEntry> = {
  anthropic: { Icon: AnthropicIcon, hasColor: false },
  openai: { Icon: OpenAIIcon, hasColor: false },
  "openai-codex": { Icon: OpenAIIcon, hasColor: false },
  google: { Icon: GoogleColorIcon, hasColor: true },
  "google-vertex": { Icon: GoogleColorIcon, hasColor: true },
  "ant-ling": { Icon: AntGroupColorIcon, hasColor: true },
  deepseek: { Icon: DeepSeekColorIcon, hasColor: true },
  groq: { Icon: GroqIcon, hasColor: false },
  mistral: { Icon: MistralColorIcon, hasColor: true },
  moonshotai: { Icon: MoonshotIcon, hasColor: false },
  "moonshotai-cn": { Icon: MoonshotIcon, hasColor: false },
  moonshot: { Icon: MoonshotIcon, hasColor: false },
  minimax: { Icon: MinimaxColorIcon, hasColor: true },
  "minimax-cn": { Icon: MinimaxColorIcon, hasColor: true },
  fireworks: { Icon: FireworksColorIcon, hasColor: true },
  huggingface: { Icon: HuggingFaceColorIcon, hasColor: true },
  cerebras: { Icon: CerebrasColorIcon, hasColor: true },
  openrouter: { Icon: OpenRouterIcon, hasColor: false },
  xai: { Icon: XAIIcon, hasColor: false },
  "cloudflare-ai-gateway": { Icon: CloudflareColorIcon, hasColor: true },
  "cloudflare-workers-ai": { Icon: CloudflareColorIcon, hasColor: true },
  "vercel-ai-gateway": { Icon: VercelIcon, hasColor: false },
  "github-copilot": { Icon: GithubCopilotIcon, hasColor: false },
  "amazon-bedrock": { Icon: AwsColorIcon, hasColor: true },
  "azure-openai-responses": { Icon: AzureColorIcon, hasColor: true },
  "kimi-coding": { Icon: KimiColorIcon, hasColor: true },
  nvidia: { Icon: NvidiaColorIcon, hasColor: true },
  opencode: { Icon: OpenCodeIcon, hasColor: false },
  "opencode-go": { Icon: OpenCodeIcon, hasColor: false },
  qwen: { Icon: QwenColorIcon, hasColor: true },
  xiaomi: { Icon: XiaomiMiMoIcon, hasColor: false },
  "xiaomi-token-plan-ams": { Icon: XiaomiMiMoIcon, hasColor: false },
  "xiaomi-token-plan-cn": { Icon: XiaomiMiMoIcon, hasColor: false },
  "xiaomi-token-plan-sgp": { Icon: XiaomiMiMoIcon, hasColor: false },
  zai: { Icon: ZAIIcon, hasColor: false },
  "zai-coding-cn": { Icon: ZAIIcon, hasColor: false },
  zhipu: { Icon: ZhipuColorIcon, hasColor: true },
  cohere: { Icon: CohereColorIcon, hasColor: true },
  perplexity: { Icon: PerplexityColorIcon, hasColor: true },
  together: { Icon: TogetherColorIcon, hasColor: true },
  grok: { Icon: GrokIcon, hasColor: false },
  "lm-studio": { Icon: LmStudioMonoIcon, hasColor: false },
  ollama: { Icon: OllamaMonoIcon, hasColor: false },
  agnesai: { Icon: AgnesAIMonoIcon, hasColor: false },
};

export default function ProviderIcon({
  id,
  size = 28,
}: {
  id: string;
  size?: number;
}) {
  const entry = PROVIDER_ICONS[id];
  if (!entry) {
    const label =
      id
        .split(/[-_]/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? "")
        .join("") || "?";
    return (
      <span
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          border: "1px solid var(--border-neutral-l2)",
          borderRadius: 4,
          color: "var(--text-tertiary)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          fontSize: Math.max(8, Math.floor(size * 0.42)),
          fontWeight: 700,
          lineHeight: 1,
        }}
      >
        {label}
      </span>
    );
  }
  if (entry.hasColor) return <entry.Icon size={size} />;
  return (
    <entry.Icon
      size={size}
      style={{ color: "var(--text-secondary)", flexShrink: 0 }}
    />
  );
}