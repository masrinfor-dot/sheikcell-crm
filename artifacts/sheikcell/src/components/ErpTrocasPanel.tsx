import { useCallback, useEffect, useState } from "react";
import { api, type ErpDirection, type ErpExchangeFlows, type ErpExchangeList, type ErpFlowStatus } from "@/lib/api";
import { ArrowLeftRight, RefreshCw } from "lucide-react";
import ErpGamificationLog from "./ErpGamificationLog";

// Trocas com o ERP (19/10/2026 — Samuel: "cria uma aba com todas as
// informações que são trocadas entre o CRM e o Prumo"). Em cima, o mapa: o que
// vai, para que lado, com que acesso da chave, de quanto em quanto tempo e se
// está ligado. Embaixo, o histórico de cada troca (90 dias), só o resumo —
// nunca o texto das mensagens dos clientes nem os documentos.

const DIRECTION: Record<ErpDirection, string> = { CRM_TO_ERP: "CRM → ERP", ERP_TO_CRM: "ERP → CRM" };

const STATUS: Record<ErpFlowStatus, { label: string; cls: string }> = {
  ON: { label: "Ligado", cls: "bg-emerald-100 text-emerald-800" },
  OFF: { label: "Desligado", cls: "bg-muted text-muted-foreground" },
  NO_ACCESS: { label: "Sem acesso na chave", cls: "bg-amber-100 text-amber-900" },
  MANUAL: { label: "Manual", cls: "bg-sky-100 text-sky-800" },
};

// Nomes dos acessos como aparecem no ERP (Auxiliares › Integrações › Gerar chave).
const SCOPE_LABEL: Record<string, string> = {
  "stores.read": "Lojas",
  "customers.read": "Clientes",
  "catalog.read": "Produtos, preços e estoque",
  "birthdays.send": "Mensagens de aniversário",
  "service_orders.notify": "Mensagens das OS",
  "surveys.send": "Pesquisa de satisfação (NPS)",
  "hr.sync": "RH (colaboradores e ponto)",
  "supplier_prices.write": "Listas de preço dos fornecedores",
  "attendance.write": "Atendimentos do CRM",
  "sales.read": "Vendas do atendimento",
  "demand.write": "Pedidos de clientes (atacado)",
  "raffles.send": "Sorteios",
  "tasks.sync": "Quadro de tarefas",
  "gamification.events": "Eventos de atendimento (gamificação)",
  "crm_waiting.write": "Fila de espera do atendimento (TV da loja)",
};

const fmt = (iso: string) => new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
const selectCls = "mt-1 px-2 py-1.5 rounded-lg border border-border text-sm bg-background";

export default function ErpTrocasPanel() {
  const [map, setMap] = useState<ErpExchangeFlows | null>(null);
  const [list, setList] = useState<ErpExchangeList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flow, setFlow] = useState("");
  const [direction, setDirection] = useState("");
  const [result, setResult] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [showEmpty, setShowEmpty] = useState(false);
  const [page, setPage] = useState(1);

  const loadMap = useCallback(() => {
    api.settings.erp.exchangeFlows().then(setMap).catch((e) => setError(e instanceof Error ? e.message : "Erro ao carregar"));
  }, []);
  const loadList = useCallback(() => {
    const params: Record<string, string> = { page: String(page) };
    if (flow) params.flow = flow;
    if (direction) params.direction = direction;
    if (result) params.result = result;
    if (from) params.from = from;
    if (to) params.to = to;
    if (!showEmpty) params.hideEmpty = "true";
    api.settings.erp.exchanges(params).then(setList).catch((e) => setError(e instanceof Error ? e.message : "Erro ao carregar"));
  }, [flow, direction, result, from, to, showEmpty, page]);

  useEffect(loadMap, [loadMap]);
  useEffect(loadList, [loadList]);

  const pages = list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1;
  const labelOf = (key: string) => map?.flows.find((f) => f.key === key)?.label ?? "Outra chamada";
  const set = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setPage(1); };

  return (
    <div className="space-y-6" data-testid="erp-trocas">
      <div>
        <h2 className="font-bold text-foreground flex items-center gap-2"><ArrowLeftRight className="w-5 h-5" /> Trocas com o ERP</h2>
        <p className="text-xs text-muted-foreground mt-1">Tudo o que passa entre o CRM e o ERP Prumo, e o registro de cada troca.</p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <section className="space-y-2">
        <h3 className="font-bold text-sm text-foreground">O que é trocado</h3>
        {map && !map.configured && (
          <p className="text-xs rounded-xl bg-amber-50 border border-amber-200 text-amber-900 p-3">Nenhuma chave do ERP salva ainda — cole a chave na aba Conexões.</p>
        )}
        {map?.pingError && (
          <p className="text-xs rounded-xl bg-amber-50 border border-amber-200 text-amber-900 p-3">Não deu para conferir os acessos da chave agora: {map.pingError}</p>
        )}
        {!map ? <p className="text-sm text-muted-foreground">Carregando...</p> : (
          <div className="shk-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground bg-muted/40">
                <tr>
                  <th className="px-3 py-2">Informação</th>
                  <th className="px-3 py-2">Lado</th>
                  <th className="px-3 py-2">Acesso na chave</th>
                  <th className="px-3 py-2">Frequência</th>
                  <th className="px-3 py-2">Situação</th>
                  <th className="px-3 py-2">Hoje</th>
                </tr>
              </thead>
              <tbody>
                {map.flows.map((f) => (
                  <tr key={f.key} className="border-t border-border align-top" data-testid={`erp-flow-${f.key}`}>
                    <td className="px-3 py-2">
                      <p className="font-semibold text-foreground">{f.label}</p>
                      <p className="text-xs text-muted-foreground">{f.what}</p>
                    </td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">{f.manual ? "CRM → ERP (arquivo)" : f.directions.map((d) => DIRECTION[d]).join(" e ")}</td>
                    <td className="px-3 py-2 text-xs">{f.manual ? "—" : f.scope ? SCOPE_LABEL[f.scope] ?? f.scope : "Qualquer chave"}</td>
                    <td className="px-3 py-2 text-xs">{f.frequency}{f.manual && <span className="block text-muted-foreground">Tela: {f.manual}</span>}</td>
                    <td className="px-3 py-2 text-xs">
                      <span title={f.reason} className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 font-semibold ${STATUS[f.status].cls}`}>{STATUS[f.status].label}</span>
                      {f.status !== "ON" && f.status !== "MANUAL" && <span className="block mt-1 text-muted-foreground">{f.reason}</span>}
                      {f.lastExchangeAt && <span className="block mt-1 text-muted-foreground">Última: {fmt(f.lastExchangeAt)}</span>}
                    </td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">
                      <span className="text-emerald-700">{f.todayOk} ok</span>
                      {f.todayErrors > 0 && <span className="ml-2 text-red-600">{f.todayErrors} com erro</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Pontuação do atendimento (27/10/2026): o que o ERP respondeu a cada evento. */}
      <ErpGamificationLog />

      <section className="space-y-3">
        <div>
          <h3 className="font-bold text-sm text-foreground">Histórico das trocas</h3>
          <p className="text-xs text-muted-foreground">Cada chamada ao ERP fica registrada por {list?.retentionDays ?? 90} dias — só o resumo (quantidade e resultado), nunca o conteúdo das mensagens ou documentos.</p>
        </div>

        {list && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {([
              ["Trocas hoje", list.today.total, "text-foreground"],
              ["Deram certo", list.today.ok, "text-emerald-700"],
              ["Com erro", list.today.errors, "text-red-600"],
              ["CRM → ERP", list.today.crmToErp, "text-foreground"],
              ["ERP → CRM", list.today.erpToCrm, "text-foreground"],
            ] as const).map(([label, value, cls]) => (
              <div key={label} className="shk-card p-3">
                <p className="text-[11px] text-muted-foreground">{label}</p>
                <p className={`text-lg font-bold ${cls}`}>{value}</p>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-xs text-muted-foreground">Informação
            <select aria-label="Filtrar por informação" className={selectCls} value={flow} onChange={(e) => set(setFlow)(e.target.value)}>
              <option value="">Todas</option>
              {map?.flows.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              <option value="other">Outra chamada</option>
            </select>
          </label>
          <label className="flex flex-col text-xs text-muted-foreground">Lado
            <select aria-label="Filtrar por lado" className={selectCls} value={direction} onChange={(e) => set(setDirection)(e.target.value)}>
              <option value="">Os dois</option>
              <option value="CRM_TO_ERP">CRM → ERP</option>
              <option value="ERP_TO_CRM">ERP → CRM</option>
            </select>
          </label>
          <label className="flex flex-col text-xs text-muted-foreground">Resultado
            <select aria-label="Filtrar por resultado" className={selectCls} value={result} onChange={(e) => set(setResult)(e.target.value)}>
              <option value="">Todos</option>
              <option value="ok">Deu certo</option>
              <option value="error">Com erro</option>
            </select>
          </label>
          <label className="flex flex-col text-xs text-muted-foreground">De
            <input type="date" className={selectCls} value={from} onChange={(e) => set(setFrom)(e.target.value)} />
          </label>
          <label className="flex flex-col text-xs text-muted-foreground">Até
            <input type="date" className={selectCls} value={to} onChange={(e) => set(setTo)(e.target.value)} />
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground pb-2">
            <input type="checkbox" checked={showEmpty} onChange={(e) => set(setShowEmpty)(e.target.checked)} />
            Mostrar buscas que voltaram vazias
          </label>
          <button type="button" onClick={() => { loadMap(); loadList(); }}
            className="ml-auto px-3 py-1.5 rounded-xl border border-border text-xs font-semibold flex items-center gap-1 hover:bg-muted">
            <RefreshCw className="w-3 h-3" /> Atualizar
          </button>
        </div>

        {!list ? <p className="text-sm text-muted-foreground">Carregando...</p> : list.items.length === 0 ? (
          <p className="shk-card p-4 text-sm text-muted-foreground">Nenhuma troca encontrada com esses filtros.</p>
        ) : (
          <div className="shk-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground bg-muted/40">
                <tr>
                  <th className="px-3 py-2">Quando</th>
                  <th className="px-3 py-2">Lado</th>
                  <th className="px-3 py-2">Informação</th>
                  <th className="px-3 py-2">Resumo</th>
                  <th className="px-3 py-2">Resultado</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((r) => (
                  <tr key={r.id} className="border-t border-border align-top">
                    <td className="px-3 py-2 text-xs whitespace-nowrap text-muted-foreground">{fmt(r.createdAt)}</td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">{DIRECTION[r.direction] ?? r.direction}</td>
                    <td className="px-3 py-2 text-xs">
                      <span className="font-semibold text-foreground">{labelOf(r.flow)}</span>
                      <span className="block font-mono text-[10px] text-muted-foreground">{r.method === "FILE" ? "arquivo" : r.method} {r.path}</span>
                    </td>
                    <td className="px-3 py-2 text-xs">{r.summary ?? "—"}</td>
                    <td className="px-3 py-2 text-xs">
                      {r.ok ? <span className="text-emerald-700">Ok</span> : (
                        <span className="text-red-600">Erro{r.httpStatus ? ` ${r.httpStatus}` : ""}{r.error ? `: ${r.error}` : ""}</span>
                      )}
                      <span className="block text-muted-foreground">{r.durationMs} ms</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {list && pages > 1 && (
          <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="px-2 py-1 rounded border border-border disabled:opacity-50">Anterior</button>
            <span>Página {page} de {pages}</span>
            <button type="button" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} className="px-2 py-1 rounded border border-border disabled:opacity-50">Próxima</button>
          </div>
        )}
      </section>
    </div>
  );
}
