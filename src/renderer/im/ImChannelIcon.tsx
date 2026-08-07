/**
 * IM channel type icon — small colored tile per platform.
 * Fallback to a neutral message glyph for unknown types.
 */
import { MessageCircle, MessageSquare, Bot } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ImChannelType } from "../../preload/api";

const ICONS: Record<string, LucideIcon> = {
  dingtalk: MessageCircle,
  weixin: MessageSquare,
  qq: Bot,
};

export default function ImChannelIcon({
  type,
  size = 20,
}: {
  type: string;
  size?: number;
}) {
  const Icon = ICONS[type] ?? MessageCircle;
  return <Icon size={size} />;
}
