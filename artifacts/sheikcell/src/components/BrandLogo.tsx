import { Smartphone } from "lucide-react";
import { useBranding } from "@/lib/branding";

export default function BrandLogo({ subtitle }: { subtitle?: string }) {
  const { branding } = useBranding();
  const name = branding.companyName?.trim() || "Sheikcell";

  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="w-8 h-8 rounded-xl bg-primary flex items-center justify-center overflow-hidden shrink-0">
        {branding.logoDataUrl ? (
          <img src={branding.logoDataUrl} alt={name} className="w-full h-full object-cover" />
        ) : (
          <Smartphone className="w-4 h-4 text-white" />
        )}
      </div>
      <span className="font-extrabold text-foreground text-sm truncate">{name}</span>
      {subtitle && <span className="text-xs text-muted-foreground ml-1 hidden sm:block">{subtitle}</span>}
    </div>
  );
}
