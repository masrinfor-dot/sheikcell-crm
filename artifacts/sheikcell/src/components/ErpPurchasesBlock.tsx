import { useEffect, useState } from "react";
import { erpSalesApi, type ErpPurchase } from "@/lib/erpSalesApi";

const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

// Compras do cliente no ERP Prumo (19/10/2026), na ficha da conversa: as
// últimas vendas concluídas pelo celular do cliente. Sem ligação com o ERP
// (ou sem o acesso "Vendas do atendimento") não mostra nada.
export default function ErpPurchasesBlock({ conversationId }: { conversationId: number }) {
  const [sales, setSales] = useState<ErpPurchase[] | null>(null);

  useEffect(() => {
    let active = true;
    setSales(null);
    erpSalesApi.purchases(conversationId)
      .then((r) => { if (active) setSales(r.available ? r.sales : null); })
      .catch(() => { if (active) setSales(null); });
    return () => { active = false; };
  }, [conversationId]);

  if (sales == null) return null;
  return (
    <div className="space-y-2" data-testid="erp-purchases">
      <p className="text-[11px] font-extrabold uppercase tracking-wider text-muted-foreground">Compras na loja (ERP)</p>
      {sales.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Nenhuma compra no ERP com este celular.</p>
      ) : (
        <div className="divide-y divide-border/70">
          {sales.map((s) => (
            <div key={s.number + (s.completedAt ?? "")} className="py-2">
              <div className="flex justify-between gap-2">
                <span className="text-[11px] font-extrabold uppercase tracking-wider text-[#3F3F46] truncate">Venda {s.number} · {s.storeName}</span>
                <span className="text-[11px] text-muted-foreground font-mono shrink-0">
                  {s.completedAt ? new Date(s.completedAt).toLocaleDateString("pt-BR") : ""}
                </span>
              </div>
              <p className="text-[13px] font-semibold">{brl(s.total)}</p>
              {s.items.length > 0 && <p className="text-[11px] text-muted-foreground truncate">{s.items.join(", ")}</p>}
              {s.attendantName && <p className="text-[11px] text-muted-foreground">Atendimento: {s.attendantName}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
