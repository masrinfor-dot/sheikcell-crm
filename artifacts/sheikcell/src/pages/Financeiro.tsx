import { useState, useEffect, useCallback } from "react";
import { api, type FinanceSummary, type Sector } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { BadgeDollarSign, TrendingUp, Search, ShoppingCart, FileText } from "lucide-react";

const brl = (v: number) =>
  v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

// Aba "Financeiro" (admin): vendas e prospecção por vendedor.
export default function Financeiro() {
  const { toast } = useToast();
  const [data, setData] = useState<FinanceSummary | null>(null);
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [days, setDays] = useState(30);
  const [sectorId, setSectorId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api.finance.summary(days, sectorId)
      .then(setData)
      .catch(() => toast({ title: "Erro ao carregar o financeiro", variant: "destructive" }))
      .finally(() => setLoading(false));
  }, [days, sectorId, toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.sectors.list().then(setSectors).catch(() => {}); }, []);

  const t = data?.totals;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <BadgeDollarSign className="w-5 h-5 text-primary" /> Financeiro — Vendas e Prospecção
        </h2>
        <div className="flex items-center gap-2">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} data-testid="select-finance-days"
            className="px-3 py-2 rounded-xl border border-border text-xs">
            <option value={7}>Últimos 7 dias</option>
            <option value={15}>Últimos 15 dias</option>
            <option value={30}>Últimos 30 dias</option>
            <option value={90}>Últimos 90 dias</option>
            <option value={180}>Últimos 6 meses</option>
            <option value={365}>Último ano</option>
          </select>
          <select value={sectorId ?? ""} onChange={(e) => setSectorId(e.target.value ? Number(e.target.value) : null)}
            className="px-3 py-2 rounded-xl border border-border text-xs">
            <option value="">Todos os setores</option>
            {sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      </div>

      {/* ─── Cards de totais ─── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="shk-card p-4">
          <p className="text-[10px] font-bold text-muted-foreground uppercase flex items-center gap-1"><ShoppingCart className="w-3 h-3" /> Total vendido</p>
          <p className="text-xl font-extrabold text-primary mt-1" data-testid="text-total-vendido">{t ? brl(t.totalVendido) : "—"}</p>
          <p className="text-[10px] text-muted-foreground">{t?.vendas ?? 0} venda(s) · ticket médio {t ? brl(t.ticketMedio) : "—"}</p>
        </div>
        <div className="shk-card p-4">
          <p className="text-[10px] font-bold text-muted-foreground uppercase flex items-center gap-1"><TrendingUp className="w-3 h-3" /> Conversão</p>
          <p className="text-xl font-extrabold mt-1">{t?.conversao ?? 0}%</p>
          <p className="text-[10px] text-muted-foreground">{t?.vendas ?? 0} venda(s) em {t?.finalizados ?? 0} atendimento(s)</p>
        </div>
        <div className="shk-card p-4">
          <p className="text-[10px] font-bold text-muted-foreground uppercase flex items-center gap-1"><Search className="w-3 h-3" /> Em prospecção</p>
          <p className="text-xl font-extrabold mt-1">{t?.emProspeccao ?? 0}</p>
          <p className="text-[10px] text-muted-foreground">clientes em atendimento agora</p>
        </div>
        <div className="shk-card p-4">
          <p className="text-[10px] font-bold text-muted-foreground uppercase flex items-center gap-1"><FileText className="w-3 h-3" /> Orçamentos</p>
          <p className="text-xl font-extrabold mt-1">{t?.orcamentos ?? 0}</p>
          <p className="text-[10px] text-muted-foreground">enviados no período</p>
        </div>
      </div>

      {/* ─── Tabela por vendedor ─── */}
      <div className="shk-card p-4 overflow-x-auto">
        <p className="font-bold text-sm mb-3">Por vendedor {loading && <span className="text-[10px] text-muted-foreground font-normal">carregando...</span>}</p>
        {data && data.vendedores.length === 0 && !loading && (
          <p className="text-xs text-muted-foreground">Nenhum atendimento no período escolhido.</p>
        )}
        {data && data.vendedores.length > 0 && (
          <table className="w-full text-xs" data-testid="table-finance">
            <thead>
              <tr className="text-left text-[10px] uppercase text-muted-foreground border-b border-border">
                <th className="py-2 pr-2">#</th>
                <th className="py-2 pr-2">Vendedor</th>
                <th className="py-2 pr-2">Loja</th>
                <th className="py-2 pr-2 text-right">Vendas</th>
                <th className="py-2 pr-2 text-right">Total vendido</th>
                <th className="py-2 pr-2 text-right">Ticket médio</th>
                <th className="py-2 pr-2 text-right">Conversão</th>
                <th className="py-2 pr-2 text-right">Finalizados</th>
                <th className="py-2 pr-2 text-right">Orçamentos</th>
                <th className="py-2 pr-2 text-right">Vai pensar</th>
                <th className="py-2 pr-2 text-right">Em prospecção</th>
              </tr>
            </thead>
            <tbody>
              {data.vendedores.map((v, i) => (
                <tr key={v.vendedorId} className="border-b border-border/50 hover:bg-secondary/40">
                  <td className="py-2 pr-2 font-bold text-muted-foreground">{i === 0 && v.totalVendido > 0 ? "🏆" : i + 1}</td>
                  <td className="py-2 pr-2 font-semibold">{v.nome}{!v.ativo && <span className="text-[9px] text-muted-foreground"> (inativo)</span>}</td>
                  <td className="py-2 pr-2 text-muted-foreground">{v.loja ?? "—"}</td>
                  <td className="py-2 pr-2 text-right font-bold">{v.vendas}</td>
                  <td className="py-2 pr-2 text-right font-bold text-primary">{brl(v.totalVendido)}</td>
                  <td className="py-2 pr-2 text-right">{v.vendas > 0 ? brl(v.ticketMedio) : "—"}</td>
                  <td className="py-2 pr-2 text-right">{v.conversao}%</td>
                  <td className="py-2 pr-2 text-right">{v.finalizados}</td>
                  <td className="py-2 pr-2 text-right">{v.orcamentos}</td>
                  <td className="py-2 pr-2 text-right">{v.vaiPensar}</td>
                  <td className="py-2 pr-2 text-right font-semibold">{v.emProspeccao}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-[10px] text-muted-foreground mt-3">
          Vendas e valores vêm do que o vendedor informa ao <b>finalizar</b> o atendimento (teve venda? de quanto?).
          "Em prospecção" são os clientes que estão em atendimento com o vendedor neste momento.
        </p>
      </div>
    </div>
  );
}
