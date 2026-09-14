import { useState, useEffect, useCallback } from "react";
import { api, type Sector, type VendorConsolidatedRow, type StoreConsolidatedRow, type AtendimentoRow } from "@/lib/api";
import { FileBarChart2, RefreshCw, Store as StoreIcon, Users, ArrowUpDown, ListFilter, ChevronLeft, ChevronRight } from "lucide-react";

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

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const OUTCOME_LABELS: Record<string, string> = {
  completed: "Finalizado",
  transferred: "Transferido",
  abandoned: "Abandonado",
  excluido: "Excluído sem finalizar",
};

const ORIGIN_LABELS: Record<string, string> = { manual: "Manual", fila: "Fila" };

const DETAIL_LIMIT = 50;

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

  // Filtro por dia exato (além dos presets acima) — quando os dois estão
  // preenchidos, substitui o preset de período pra tudo nesta página
  // (comparativos + lista detalhada abaixo), igual pedido: "filtrar por dia".
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const effectiveRange = useCallback((): { from: string; to: string } => {
    if (customFrom && customTo) {
      const from = new Date(customFrom); from.setHours(0, 0, 0, 0);
      const to = new Date(customTo); to.setHours(23, 59, 59, 999);
      return { from: from.toISOString(), to: to.toISOString() };
    }
    return periodRange(period);
  }, [customFrom, customTo, period]);

  useEffect(() => { api.sectors.list().then(setSectors).catch(() => {}); }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to } = effectiveRange();
      const [v, l] = await Promise.all([
        api.relatorios.vendedores({ from, to, sectorId: sectorId || undefined }),
        api.relatorios.lojas({ from, to, sectorId: sectorId || undefined }),
      ]);
      setVendedores(v.rows);
      setLojas(l.rows);
    } catch { /* silent */ } finally { setLoading(false); }
  }, [effectiveRange, sectorId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Lista detalhada de atendimentos (individual quando filtra por 1
  // vendedor, coletivo quando não filtra) — filtros próprios além do período
  // e setor já compartilhados acima com os comparativos.
  const [detailAttendantId, setDetailAttendantId] = useState(0);
  const [detailMotivo, setDetailMotivo] = useState("");
  const [detailComprou, setDetailComprou] = useState<"todos" | "sim" | "nao">("todos");
  const [detailOrigem, setDetailOrigem] = useState<"todos" | "manual" | "fila">("todos");
  const [detailPage, setDetailPage] = useState(0);
  const [detailRows, setDetailRows] = useState<AtendimentoRow[] | null>(null);
  const [detailTotal, setDetailTotal] = useState(0);
  const [detailMotivos, setDetailMotivos] = useState<string[]>([]);
  const [detailLoading, setDetailLoading] = useState(true);

  // Qualquer filtro (exceto a própria página) muda ⇒ volta pra página 1.
  useEffect(() => { setDetailPage(0); }, [period, sectorId, customFrom, customTo, detailAttendantId, detailMotivo, detailComprou, detailOrigem]);

  const fetchDetail = useCallback(async () => {
    setDetailLoading(true);
    try {
      const { from, to } = effectiveRange();
      const r = await api.relatorios.atendimentos({
        from, to,
        sectorId: sectorId || undefined,
        attendantId: detailAttendantId || undefined,
        resolutionReason: detailMotivo || undefined,
        hadSale: detailComprou === "sim" ? true : detailComprou === "nao" ? false : undefined,
        origin: detailOrigem !== "todos" ? detailOrigem : undefined,
        limit: DETAIL_LIMIT,
        offset: detailPage * DETAIL_LIMIT,
      });
      setDetailRows(r.rows);
      setDetailTotal(r.total);
      setDetailMotivos(r.motivos);
    } catch { /* silent */ } finally { setDetailLoading(false); }
  }, [effectiveRange, sectorId, detailAttendantId, detailMotivo, detailComprou, detailOrigem, detailPage]);

  useEffect(() => { fetchDetail(); }, [fetchDetail]);

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
        <div className="flex flex-wrap items-center gap-1.5">
          <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
            data-testid="relatorios-custom-from"
            className="px-2 py-1.5 rounded-xl border border-border text-xs bg-white" />
          <span className="text-xs text-muted-foreground">até</span>
          <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
            data-testid="relatorios-custom-to"
            className="px-2 py-1.5 rounded-xl border border-border text-xs bg-white" />
          {(customFrom || customTo) && (
            <button onClick={() => { setCustomFrom(""); setCustomTo(""); }}
              className="text-[11px] text-muted-foreground hover:text-foreground underline">
              limpar
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-2 ml-auto">
          <select value={sectorId} onChange={(e) => setSectorId(Number(e.target.value))}
            data-testid="relatorios-filter-sector"
            className="px-3 py-1.5 rounded-xl border border-border text-xs bg-white">
            <option value={0}>Todos os setores</option>
            {sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button onClick={() => { fetchData(); fetchDetail(); }} className="p-1.5 rounded-xl text-muted-foreground hover:bg-secondary transition" data-testid="relatorios-refresh">
            <RefreshCw className={`w-4 h-4 ${loading || detailLoading ? "animate-spin" : ""}`} />
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

      {/* Lista detalhada de atendimentos — individual (filtra 1 vendedor) ou coletivo (todos) */}
      <div className="shk-card p-5">
        <div className="flex items-center gap-2 mb-3">
          <ListFilter className="w-4 h-4 text-primary" />
          <h3 className="font-bold text-sm text-foreground">Lista detalhada de atendimentos</h3>
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
          <select value={detailAttendantId} onChange={(e) => setDetailAttendantId(Number(e.target.value))}
            data-testid="relatorios-detail-filter-vendedor"
            className="px-3 py-1.5 rounded-xl border border-border text-xs bg-white">
            <option value={0}>Todos os vendedores</option>
            {(vendedores ?? []).map((v) => <option key={v.attendantId} value={v.attendantId}>{v.name}</option>)}
          </select>
          <select value={detailMotivo} onChange={(e) => setDetailMotivo(e.target.value)}
            data-testid="relatorios-detail-filter-motivo"
            className="px-3 py-1.5 rounded-xl border border-border text-xs bg-white">
            <option value="">Todos os motivos</option>
            {detailMotivos.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <select value={detailComprou} onChange={(e) => setDetailComprou(e.target.value as typeof detailComprou)}
            data-testid="relatorios-detail-filter-comprou"
            className="px-3 py-1.5 rounded-xl border border-border text-xs bg-white">
            <option value="todos">Comprou ou não</option>
            <option value="sim">Só quem comprou</option>
            <option value="nao">Só quem não comprou</option>
          </select>
          <select value={detailOrigem} onChange={(e) => setDetailOrigem(e.target.value as typeof detailOrigem)}
            data-testid="relatorios-detail-filter-origem"
            className="px-3 py-1.5 rounded-xl border border-border text-xs bg-white">
            <option value="todos">Manual ou fila</option>
            <option value="manual">Só iniciados manualmente</option>
            <option value="fila">Só vindos da fila</option>
          </select>
        </div>

        {detailLoading && !detailRows ? (
          <p className="text-xs text-muted-foreground py-4 text-center">Carregando…</p>
        ) : !detailRows || detailRows.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">Nenhum atendimento encontrado com esses filtros.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground border-b border-border">
                    <th className="text-left py-2 pr-2 font-semibold">Data</th>
                    <th className="text-left py-2 pr-2 font-semibold">Cliente</th>
                    <th className="text-left py-2 pr-2 font-semibold">Vendedor</th>
                    <th className="text-left py-2 pr-2 font-semibold">Setor</th>
                    <th className="text-left py-2 pr-2 font-semibold">Origem</th>
                    <th className="text-left py-2 pr-2 font-semibold">Situação</th>
                    <th className="text-left py-2 pr-2 font-semibold">Motivo</th>
                    <th className="text-right py-2 font-semibold">Venda</th>
                  </tr>
                </thead>
                <tbody>
                  {detailRows.map((r) => (
                    <tr key={r.id} className="border-b border-border/50 last:border-0" data-testid={`relatorios-detail-row-${r.id}`}>
                      <td className="py-2 pr-2 whitespace-nowrap text-muted-foreground">{fmtDateTime(r.createdAt)}</td>
                      <td className="py-2 pr-2 font-semibold text-foreground">{r.clientName}</td>
                      <td className="py-2 pr-2">{r.attendantName ?? "—"}</td>
                      <td className="py-2 pr-2">{r.sectorName}</td>
                      <td className="py-2 pr-2">{r.origin ? (ORIGIN_LABELS[r.origin] ?? r.origin) : "—"}</td>
                      <td className="py-2 pr-2">{r.outcome ? (OUTCOME_LABELS[r.outcome] ?? r.outcome) : "—"}</td>
                      <td className="py-2 pr-2">{r.resolutionReason ?? "—"}</td>
                      <td className="py-2 text-right font-semibold">
                        {r.hadSale ? <span className="text-green-700">{fmtMoney(r.saleAmount ?? 0)}</span> : r.hadSale === false ? <span className="text-muted-foreground">Não</span> : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between mt-3 text-[11px] text-muted-foreground">
              <span>
                Mostrando {detailPage * DETAIL_LIMIT + 1}–{Math.min(detailPage * DETAIL_LIMIT + detailRows.length, detailTotal)} de {detailTotal}
              </span>
              <div className="flex items-center gap-1">
                <button onClick={() => setDetailPage((p) => Math.max(0, p - 1))} disabled={detailPage === 0}
                  data-testid="relatorios-detail-prev"
                  className="p-1 rounded-lg border border-border disabled:opacity-30 hover:bg-secondary transition">
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => setDetailPage((p) => ((p + 1) * DETAIL_LIMIT < detailTotal ? p + 1 : p))}
                  disabled={(detailPage + 1) * DETAIL_LIMIT >= detailTotal}
                  data-testid="relatorios-detail-next"
                  className="p-1 rounded-lg border border-border disabled:opacity-30 hover:bg-secondary transition">
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
        <FileBarChart2 className="w-3 h-3" /> "Iniciados" e o filtro "Manual ou fila" só são confiáveis a partir de quando cada recurso foi lançado — atendimentos mais antigos aparecem com "—" nesses campos.
      </p>
    </div>
  );
}
