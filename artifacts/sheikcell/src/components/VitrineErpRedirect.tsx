import { useEffect, useState } from "react";
import { ArrowRightLeft, ExternalLink } from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

// Vitrine pública no ERP (17/10/2026): a página /loja/<slug> do ERP faz o
// mesmo que a vitrine daqui. Desligado (padrão), nada muda; ligado, os links
// /vitrine/<slug> e /avaliar/<slug> do CRM levam o cliente para o ERP.
// Só admin (a rota exige admin).
export default function VitrineErpRedirect({ slug }: { slug: string | null }) {
  const { toast } = useToast();
  const [state, setState] = useState<{ enabled: boolean; erpWebUrl: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.catalog.erpRedirect.get().then(setState).catch(() => setState(null));
  }, []);

  if (!state) return null;
  const erpLoja = state.erpWebUrl && slug ? `${state.erpWebUrl}/loja/${slug}` : null;

  const toggle = async () => {
    const next = !state.enabled;
    if (next && !window.confirm("Mandar os clientes da vitrine do CRM para a página da loja no ERP? Dá para desligar depois.")) return;
    setBusy(true);
    try {
      setState(await api.catalog.erpRedirect.set(next));
      toast({ title: next ? "Vitrine pública agora abre no ERP" : "Vitrine pública voltou para o CRM" });
    } catch (err) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setBusy(false); }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 pt-3 border-t" data-testid="vitrine-erp-redirect">
      <ArrowRightLeft className="w-4 h-4 text-primary shrink-0" />
      <div className="flex-1 min-w-[220px] space-y-1">
        <label className="flex items-center gap-2 text-xs font-semibold text-muted-foreground cursor-pointer">
          <input type="checkbox" checked={state.enabled} disabled={busy || (!state.enabled && !state.erpWebUrl)}
            onChange={toggle} data-testid="checkbox-vitrine-erp-redirect"
            className="w-4 h-4 rounded border-muted-foreground/40 text-primary" />
          Redirecionar a vitrine pública para o ERP
        </label>
        <p className="text-[10px] text-muted-foreground">
          {!state.erpWebUrl
            ? "Para ligar, conecte o ERP em Configurações › Integração com o ERP e clique em Testar."
            : state.enabled
              ? "Ligado: quem abrir o link da vitrine ou da avaliação do CRM vai para a loja no ERP."
              : "Desligado: a vitrine continua aqui no CRM. Teste a página do ERP antes de ligar."}
        </p>
        {erpLoja && (
          <a href={erpLoja} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline">
            Abrir a loja no ERP <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>
    </div>
  );
}
