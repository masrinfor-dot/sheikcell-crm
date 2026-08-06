import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { api, type Branding } from "./api";
import { useAuth } from "./auth";

type BrandingCtx = {
  branding: Branding;
  loading: boolean;
  refresh: () => Promise<void>;
};

const DEFAULT_BRANDING: Branding = { companyName: null, logoDataUrl: null, primaryColor: null };

const BrandingContext = createContext<BrandingCtx>({
  branding: DEFAULT_BRANDING,
  loading: true,
  refresh: async () => {},
});

// Converte #rrggbb em "h s% l%" para sobrescrever as variáveis CSS em HSL
// usadas por todo o tema (--primary, --ring).
function hexToHslString(hex: string): string | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const int = parseInt(m[1], 16);
  const r = ((int >> 16) & 255) / 255, g = ((int >> 8) & 255) / 255, b = (int & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

export function BrandingProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const s = await api.settings.get();
      setBranding(s.branding ?? DEFAULT_BRANDING);
    } catch {
      // silent: mantém a marca padrão se a busca falhar
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Superadmin não tem loja (tenant), então não há marca própria para buscar.
    if (user && user.role !== "superadmin") refresh();
    else { setBranding(DEFAULT_BRANDING); setLoading(false); }
  }, [user, refresh]);

  useEffect(() => {
    const root = document.documentElement;
    const hsl = branding.primaryColor ? hexToHslString(branding.primaryColor) : null;
    if (hsl) {
      root.style.setProperty("--primary", hsl);
      root.style.setProperty("--ring", hsl);
    } else {
      root.style.removeProperty("--primary");
      root.style.removeProperty("--ring");
    }
  }, [branding.primaryColor]);

  return (
    <BrandingContext.Provider value={{ branding, loading, refresh }}>
      {children}
    </BrandingContext.Provider>
  );
}

export const useBranding = () => useContext(BrandingContext);
