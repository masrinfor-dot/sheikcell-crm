import { useEffect, useState } from "react";
import { erpSalesApi, type ErpSalesSyncStatus } from "@/lib/erpSalesApi";
import { useToast } from "@/hooks/use-toast";
import { ShoppingCart, AlertTriangle } from "lucide-react";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR") : "—");

// Vendas do atendimento (19/10/2026): liga o envio dos atendimentos ao ERP.
// O ERP marca a venda com o atendente quando o cliente (pelo celular) foi
// atendido aqui nos últimos dias; o Financeiro mostra o que foi vendido lá.
export default function ErpSalesSyncBlock() {
  const { toast } = useToast();
  const [status, setStatus] = useState<ErpSalesSyncStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { erpSalesApi.status().then(setStatus).catch(() => {}); }, []);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      setStatus(await erpSalesApi.setEnabled(enabled));
      toast({ title: enabled ? "Vendas do atendimento ligadas" : "Vendas do atendimento desligadas" });
    } catch (err) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setBusy(false); }
  };

  const runNow = async () => {
    setBusy(true);
    try {
      const r = await erpSalesApi.runNow();
      setStatus(r.status);
      toast(r.result.error
        ? { title: "Não foi", description: r.result.error, variant: "destructive" }
        : { title: `${r.result.sent} atendimento(s) enviado(s) ao ERP` });
    } catch (err) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setBusy(false); }
  };

  if (!status) return null;
  return (
    <div className="rounded-xl border border-border p-3 space-y-2" data-testid="erp-sales-sync">
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={status.enabled} disabled={busy} data-testid="checkbox-erp-sales-sync"
          onChange={(e) => void toggle(e.target.checked)} className="mt-1" />
        <span>
          <span className="font-semibold flex items-center gap-1"><ShoppingCart className="w-3.5 h-3.5" /> Vendas do atendimento</span>
          <span className="block text-xs text-muted-foreground">
            A cada 10 min, manda ao ERP os atendimentos (celular do cliente, atendente, setor, loja e último contato).
            Quando o cliente compra na loja, o ERP marca a venda com o atendente; o vendedor pode corrigir no PDV.
            A chave do ERP precisa dos acessos "Atendimentos do CRM" e "Vendas do atendimento".
          </span>
        </span>
      </label>
      {status.enabled && (
        <div className="text-[11px] text-muted-foreground flex items-center justify-between gap-2 flex-wrap">
          <span>
            Último envio: {fmt(status.lastSyncAt)} · {status.sentCount} atendimento(s) enviado(s)
          </span>
          <button type="button" onClick={() => void runNow()} disabled={busy} data-testid="button-erp-sales-run"
            className="px-3 py-1 rounded-lg border border-border text-xs font-semibold hover:bg-muted disabled:opacity-50">
            Enviar agora
          </button>
        </div>
      )}
      {status.enabled && status.lastError && (
        <p className="text-[11px] text-destructive flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> {status.lastError}</p>
      )}
    </div>
  );
}
