import { MessageCircle, Instagram, Plus } from "lucide-react";

const channelConfig = {
  whatsapp: {
    label: "WhatsApp",
    icon: MessageCircle,
    classes: "bg-green-100 text-green-700",
  },
  instagram: {
    label: "Instagram",
    icon: Instagram,
    classes: "bg-pink-100 text-pink-700",
  },
  manual: {
    label: "Manual",
    icon: Plus,
    classes: "bg-gray-100 text-gray-600",
  },
};

export function ChannelBadge({ channel }: { channel: string }) {
  const cfg = channelConfig[channel as keyof typeof channelConfig] ?? channelConfig.manual;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${cfg.classes}`}>
      <Icon className="w-3 h-3" />
      {cfg.label}
    </span>
  );
}
