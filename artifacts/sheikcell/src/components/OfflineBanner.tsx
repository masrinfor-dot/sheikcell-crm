import { useEffect, useState } from "react";
import { WifiOff, CloudOff } from "lucide-react";
import { getConnectivity, subscribeConnectivity, type ConnectivityState } from "@/lib/offlineCache";

// Faixa fina no topo quando a internet cai ou a tela está mostrando dados
// guardados (ver offlineCache.ts). Some sozinha quando a rede volta.
export default function OfflineBanner() {
  const [s, setS] = useState<ConnectivityState>(getConnectivity());
  useEffect(() => subscribeConnectivity(setS), []);

  if (s.online && s.servingCacheSince == null) return null;

  const offline = !s.online;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-0 inset-x-0 z-[100] flex items-center justify-center gap-2 px-4 py-1 text-xs font-medium text-white shadow"
      style={{ background: offline ? "#b45309" : "#1a2e6e" }}
    >
      {offline ? <WifiOff className="h-3.5 w-3.5" /> : <CloudOff className="h-3.5 w-3.5" />}
      <span>
        {offline
          ? "Sem internet — mostrando os últimos dados salvos. Alterações precisam de conexão."
          : "Conexão instável — alguns dados podem estar desatualizados."}
      </span>
    </div>
  );
}
