import { useState, useEffect, useCallback } from "react";
import { api, type Sector, type VendorConsolidatedRow, type StoreConsolidatedRow } from "@/lib/api";
import { FileBarChart2, RefreshCw, Store as StoreIcon, Users, ArrowUpDown } from "lucide-react";

// Comparativo entre vendedores e entre lojas — diferente de Resultados.tsx
// (auto-escopado, cada vendedor só vê os próprios números), aqui é sempre
// uma visão de conjunto pra quem tem acesso ao módulo "relatorios" (admin ou
// delegado por moduleAccess). Sem seletor de vendedor único: o propósito
// aqui é justamente comparar todo mundo de uma vez.

type PeriodKey = "hoje" | "7d" | "30d" | "mes" | "mes_passado";
const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "hoje", label: "Hoje" },
  { key: "7d", label: "7 dias" },
  { key: "30d", label: "30 dias" },
  { key: "mes", label: "Este mês" },
  { key: "mes_passado", label: "Mês passado" },
];

function periodRange(key: PeriodKey): { from: string; to: string } {
  const now = new Date();
  const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  switch (key) {
    case "hoje":
      return { from: startOfDay(now).toISOString(), to: now.toISOString() };
    case "7d":
      return { from: new Date(now.getTime() - 7 * 86_400_000).toISOString(), to: now.toISOString() };
    case "30d":
      return { from: new Date(now.getTime() - 30 * 86_400_000).toISOString(), to: now.toISOString() };
    case "mes":
      return { from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(), to: now.toISOString() };
    case "mes_passado": {
      const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const to = new Date(now.getFullYear(), now.getMonth(), 1);
      to.setMilliseconds(-1);
      return { from: from.toISOString(), to: to.toISOString() };
    }
  }
}

function fmtMoney(v: number): string {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}

type SortKey = "atendimentos" | "iniciados" | "finalizados" | "naoResolvidos" | "vendas" | "totalVendido" | "avgSatisfactionPercent";

function ThSort({ label, active, dir, onClick }: { label: string; active: boolean; dir: "asc" | "desc"; onClick: () => void }) {
  return (
    <th className="text-right py-2 pr-2 font-semibold cursor-pointer select-none hover:text-foreground" onClick={onClick}>
      <span className="inline-flex items-center gap-1">
        {label}
        <ArrowUpDown className={`w-3 h-3 ${active ? "text-primary" : "text-muted-foreground/40"}`} />
        {active && <span className="text-[9px]">{dir === "desc" ? "▼" : "▲"}</span>}
      </span>
    </th>
  );
}

export default function Relatorios() {
  const [period, setPeriod] = useState<PeriodKey>("30d");
  const [sectorId, setSectorId] = useState(0);
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [vendedores, setVendedores] = useState<VendorConsolidatedRow[] | null>(null);
  const [lojas, setLojas] = useState<StoreConsolidatedRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("atendimentos");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  useEffect(() => { api.sectors.list().then(setSectors).catch(() => {}); }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to } = periodRange(period);
      const [v, l] = await Promise.all([
        api.relatorios.vendedores({ from, to, sectorId: sectorId || undefined }),
        api.relatorios.lojas({ from, to, sectorId: sectorId || undefined }),
      ]);
      setVendedores(v.rows);
      setLojas(l.rows);
    } catch { /* silent */ } finally { setLoading(false); }
  }, [period, sectorId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) { setSortDir((d) => (d === "desc" ? "asc" : "desc")); return; }
    setSortKey(key);
    setSortDir("desc");
  };

  const sortRows = <T extends Record<SortKey, number>>(rows: T[]): T[] =>
    [...rows].sort((a, b) => (sortDir === "desc" ? b[sortKey] - a[sortKey] : a[sortKey] - b[sortKey]));

  return (
    <div className="space-y-6" data-testid="relatorios-panel">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {PERIODS.map(({ key, label }) => (
            <button key={key} onClick={() => setPeriod(key)} data-testid={`relatorios-period-${key}`}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition ${
                period === key ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:bg-secondary"
              }`}>
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 ml-auto">
          <select value={sectorId} onChange={(e) => setSectorId(Number(e.target.value))}
            data-testid="relatorios-filter-sector"
            className="px-3 py-1.5 rounded-xl border border-border text-xs bg-white">
            <option value={0}>Todos os setores</option>
            {sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button onClick={fetchData} className="p-1.5 rounded-xl text-muted-foreground hover:bg-secondary transition" data-testid="relatorios-refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Comparativo por vendedor */}
      <div className="shk-card p-5">
        <div className="flex items-center gap-2 mb-3">
          <Users className="w-4 h-4 text-primary" />
          <h3 className="font-bold text-sm text-foreground">Comparativo por vendedor</h3>
        </div>
        {!vendedores || vendedores.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">Nenhum atendimento no período.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b border-border">
                  <th className="text-left py-2 pr-2 font-semibold">Vendedor</th>
                  <ThSort label="Atend." active={sortKey === "atendimentos"} dir={sortDir} onClick={() => toggleSort("atendimentos")} />
                  <ThSort label="Iniciados" active={sortKey === "iniciados"} dir={sortDir} onClick={() => toggleSort("iniciados")} />
                  <ThSort label="Finalizados" active={sortKey === "finalizados"} dir={sortDir} onClick={() => toggleSort("finalizados")} />
                  <ThSort label="Não resolv." active={sortKey === "naoResolvidos"} dir={sortDir} onClick={() => toggleSort("naoResolvidos")} />
                  <ThSort label="Vendas" active={sortKey === "vendas"} dir={sortDir} onClick={() => toggleSort("vendas")} />
                  <ThSort label="Total" active={sortKey === "totalVendido"} dir={sortDir} onClick={() => toggleSort("totalVendido")} />
                  <ThSort label="Satisf." active={sortKey === "avgSatisfactionPercent"} dir={sortDir} onClick={() => toggleSort("avgSatisfactionPercent")} />
                </tr>
              </thead>
              <tbody>
                {sortRows(vendedores).map((r) => (
                  <tr key={r.attendantId} className="border-b border-border/50 last:border-0" data-testid={`relatorios-vendedor-${r.attendantId}`}>
                    <td className="py-2 pr-2 font-semibold text-foreground">{r.name}{!r.ativo && <span className="text-muted-foreground font-normal"> (inativo)</span>}</td>
                    <td className="py-2 pr-2 text-right font-bold">{r.atendimentos}</td>
                    <td className="py-2 pr-2 text-right">{r.iniciados}</td>
                    <td className="py-2 pr-2 text-right">{r.finalizados}</td>
                    <td className="py-2 pr-2 text-right">{r.naoResolvidos > 0 ? <span className="font-bold text-red-600">{r.naoResolvidos}</span> : "0"}</td>
                    <td className="py-2 pr-2 text-right">{r.vendas} <span className="text-muted-foreground">({r.conversao}%)</span></td>
                    <td className="py-2 pr-2 text-right font-semibold text-green-700">{fmtMoney(r.totalVendido)}</td>
                    <td className="py-2 text-right">{r.avgSatisfactionPercent}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Comparativo por loja */}
      <div className="shk-card p-5">
        <div className="flex items-center gap-2 mb-3">
          <StoreIcon className="w-4 h-4 text-primary" />
          <h3 className="font-bold text-sm text-foreground">Comparativo por loja</h3>
        </div>
        {!lojas || lojas.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">Nenhum atendimento no período.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b border-border">
                  <th className="text-left py-2 pr-2 font-semibold">Loja</th>
                  <ThSort label="Atend." active={sortKey === "atendimentos"} dir={sortDir} onClick={() => toggleSort("atendimentos")} />
                  <ThSort label="Iniciados" active={sortKey === "iniciados"} dir={sortDir} onClick={() => toggleSort("iniciados")} />
                  <ThSort label="Finalizados" active={sortKey === "finalizados"} dir={sortDir} onClick={() => toggleSort("finalizados")} />
                  <ThSort label="Não resolv." active={sortKey === "naoResolvidos"} dir={sortDir} onClick={() => toggleSort("naoResolvidos")} />
                  <ThSort label="Vendas" active={sortKey === "vendas"} dir={sortDir} onClick={() => toggleSort("vendas")} />
                  <ThSort label="Total" active={sortKey === "totalVendido"} dir={sortDir} onClick={() => toggleSort("totalVendido")} />
                  <ThSort label="Satisf." active={sortKey === "avgSatisfactionPercent"} dir={sortDir} onClick={() => toggleSort("avgSatisfactionPercent")} />
                </tr>
              </thead>
              <tbody>
                {sortRows(lojas).map((r) => (
                  <tr key={r.storeId ?? "sem-loja"} className="border-b border-border/50 last:border-0" data-testid={`relatorios-loja-${r.storeId ?? "sem-loja"}`}>
                    <td className="py-2 pr-2 font-semibold text-foreground">{r.name}</td>
                    <td className="py-2 pr-2 text-right font-bold">{r.atendimentos}</td>
                    <td className="py-2 pr-2 text-right">{r.iniciados}</td>
                    <td className="py-2 pr-2 text-right">{r.finalizados}</td>
                    <td className="py-2 pr-2 text-right">{r.naoResolvidos > 0 ? <span className="font-bold text-red-600">{r.naoResolvidos}</span> : "0"}</td>
                    <td className="py-2 pr-2 text-right">{r.vendas} <span className="text-muted-foreground">({r.conversao}%)</span></td>
                    <td className="py-2 pr-2 text-right font-semibold text-green-700">{fmtMoney(r.totalVendido)}</td>
                    <td className="py-2 text-right">{r.avgSatisfactionPercent}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
        <FileBarChart2 className="w-3 h-3" /> "Iniciados" só é confiável a partir de quando este relatório foi lançado — atendimentos anteriores a essa data não entram nessa contagem específica.
      </p>
    </div>
  );
}
