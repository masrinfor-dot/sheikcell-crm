import { useState, useEffect, useMemo, useCallback } from "react";
import { useAuth } from "@/lib/auth";
import { api, type ResultsSummary, type Sector, type Store } from "@/lib/api";
import type { SurveySettings } from "@/lib/api";
import {
  Trophy, Clock, Timer, Users, UserPlus, Repeat, ShoppingBag,
  TrendingUp, RefreshCw, BadgeDollarSign, Star, Settings, X,
} from "lucide-react";

// Períodos pré-definidos do filtro
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

function fmtDuration(sec: number): string {
  if (!sec) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}min ${sec % 60 ? `${sec % 60}s` : ""}`.trim();
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}min`;
}

function fmtMoney(v: number): string {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}

function fmtMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, 1).toLocaleDateString("pt-BR", { month: "short", year: "2-digit" });
}

const MEDALS = ["🥇", "🥈", "🥉"];

export default function Resultados() {
  const { user } = useAuth();
  const isGlobal = user?.role === "admin" || user?.role === "supervisor";

  const [period, setPeriod] = useState<PeriodKey>("30d");
  const [sectorId, setSectorId] = useState(0);
  const [attendantId, setAttendantId] = useState(0);
  const [store, setStore] = useState("");
  const [stores, setStores] = useState<Store[]>([]);
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [attendants, setAttendants] = useState<{ id: number; name: string }[]>([]);
  const [data, setData] = useState<ResultsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  // Configurações da pesquisa de satisfação (admin/supervisor)
  const [showSurveyCfg, setShowSurveyCfg] = useState(false);
  const [surveyCfg, setSurveyCfg] = useState<SurveySettings | null>(null);
  const [savingCfg, setSavingCfg] = useState(false);

  const openSurveyCfg = async () => {
    setShowSurveyCfg(true);
    if (!surveyCfg) {
      try { setSurveyCfg(await api.surveySettings.get()); } catch { /* silent */ }
    }
  };

  const saveSurveyCfg = async () => {
    if (!surveyCfg) return;
    setSavingCfg(true);
    try {
      setSurveyCfg(await api.surveySettings.save(surveyCfg));
      setShowSurveyCfg(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Erro ao salvar");
    } finally { setSavingCfg(false); }
  };

  useEffect(() => {
    // Vendedor só vê os próprios números (o servidor força isso de qualquer
    // forma) — os filtros de setor/vendedor são exclusivos de admin/supervisor.
    if (!isGlobal) return;
    api.sectors.list().then(setSectors).catch(() => {});
    api.stores.list().then(setStores).catch(() => {});
    api.chatUsers()
      .then((us) => setAttendants(us.filter((u) => u.role === "vendedor").map((u) => ({ id: u.id, name: u.name }))))
      .catch(() => {});
  }, [isGlobal]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to } = periodRange(period);
      const d = await api.results.summary({
        from, to,
        sectorId: isGlobal && sectorId ? sectorId : undefined,
        attendantId: attendantId || undefined,
        store: isGlobal && store ? store : undefined,
      });
      setData(d);
    } catch { /* silent */ } finally { setLoading(false); }
  }, [period, sectorId, attendantId, store, isGlobal]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const t = data?.totals;
  const maxMes = useMemo(() => Math.max(1, ...(data?.leadsPorMes.map((m) => m.novos) ?? [1])), [data]);

  const cards = [
    { label: "Atendimentos", value: t ? String(t.atendimentos) : "—", icon: Users, color: "text-blue-600", bg: "bg-blue-50" },
    { label: "Tempo médio de atendimento", value: t ? fmtDuration(t.avgServiceSeconds) : "—", icon: Timer, color: "text-indigo-600", bg: "bg-indigo-50" },
    { label: "Tempo médio de espera", value: t ? fmtDuration(t.avgWaitSeconds) : "—", icon: Clock, color: "text-amber-600", bg: "bg-amber-50" },
    { label: "Vendas", value: t ? `${t.vendas} · ${fmtMoney(t.totalVendido)}` : "—", icon: BadgeDollarSign, color: "text-green-600", bg: "bg-green-50" },
    { label: "Novos leads", value: t ? String(t.newLeads) : "—", icon: UserPlus, color: "text-cyan-600", bg: "bg-cyan-50" },
    { label: "Leads recorrentes (voltaram)", value: t ? String(t.recurringLeads) : "—", icon: Repeat, color: "text-purple-600", bg: "bg-purple-50" },
    { label: "Clientes com recompra", value: t ? String(t.repurchaseClients) : "—", icon: ShoppingBag, color: "text-rose-600", bg: "bg-rose-50" },
    { label: "Satisfação (nota média)", value: t ? (t.ratings > 0 ? `${t.avgRating.toFixed(1)} ⭐ · ${t.ratings} aval.` : "Sem avaliações") : "—", icon: Star, color: "text-yellow-600", bg: "bg-yellow-50" },
  ];

  return (
    <div className="space-y-6" data-testid="results-panel">
      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {PERIODS.map(({ key, label }) => (
            <button key={key} onClick={() => setPeriod(key)} data-testid={`results-period-${key}`}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition ${
                period === key ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:bg-secondary"
              }`}>
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 ml-auto">
          {isGlobal && (
            <select value={sectorId} onChange={(e) => setSectorId(Number(e.target.value))}
              data-testid="results-filter-sector"
              className="px-3 py-1.5 rounded-xl border border-border text-xs bg-white">
              <option value={0}>Todos os setores</option>
              {sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          {isGlobal && stores.length > 0 && (
            <select value={store} onChange={(e) => setStore(e.target.value)}
              data-testid="results-filter-store"
              className="px-3 py-1.5 rounded-xl border border-border text-xs bg-white">
              <option value="">Todas as lojas</option>
              {stores.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
            </select>
          )}
          {isGlobal && (
            <select value={attendantId} onChange={(e) => setAttendantId(Number(e.target.value))}
              data-testid="results-filter-attendant"
              className="px-3 py-1.5 rounded-xl border border-border text-xs bg-white">
              <option value={0}>Todos os vendedores</option>
              {attendants.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
          {isGlobal && (
            <button onClick={openSurveyCfg} data-testid="button-survey-settings" title="Configurar pesquisa de satisfação"
              className="px-3 py-1.5 rounded-xl border border-border text-xs bg-white flex items-center gap-1.5 hover:bg-secondary">
              <Settings className="w-3.5 h-3.5" /> Pesquisa
            </button>
          )}
          <button onClick={fetchData} className="p-1.5 rounded-xl text-muted-foreground hover:bg-secondary transition" data-testid="results-refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Configurações da pesquisa de satisfação */}
      {showSurveyCfg && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setShowSurveyCfg(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-base flex items-center gap-2"><Star className="w-4 h-4 text-yellow-500" /> Pesquisa de Satisfação</h3>
              <button onClick={() => setShowSurveyCfg(false)} className="p-1 rounded-lg hover:bg-muted"><X className="w-4 h-4" /></button>
            </div>
            {!surveyCfg ? (
              <div className="text-sm text-muted-foreground py-6 text-center">Carregando...</div>
            ) : (
              <div className="space-y-4 text-sm">
                <label className="flex items-center gap-2 font-medium">
                  <input type="checkbox" checked={surveyCfg.enabled} onChange={(e) => setSurveyCfg({ ...surveyCfg, enabled: e.target.checked })} />
                  Enviar pesquisa ao finalizar o atendimento
                </label>
                <div>
                  <label className="font-semibold">Escala da nota</label>
                  <div className="flex gap-2 mt-1">
                    {([5, 10] as const).map((s) => (
                      <button key={s} onClick={() => setSurveyCfg({ ...surveyCfg, scaleMax: s })}
                        className={`px-3 py-1.5 rounded-xl text-xs font-semibold border ${surveyCfg.scaleMax === s ? "bg-primary text-white border-primary" : "border-border text-muted-foreground"}`}>
                        {s === 5 ? "1 a 5" : "0 a 10"}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="font-semibold">Mensagem da pesquisa (vazio = padrão)</label>
                  <textarea value={surveyCfg.message} rows={3} maxLength={1000}
                    placeholder={`Seu atendimento foi finalizado. ✅ De ${surveyCfg.scaleMax === 10 ? 0 : 1} a ${surveyCfg.scaleMax}, que nota você dá para este atendimento?`}
                    onChange={(e) => setSurveyCfg({ ...surveyCfg, message: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm mt-1" />
                </div>
                <div>
                  <label className="font-semibold">Prazo para responder (horas)</label>
                  <input type="number" min={1} max={168} value={surveyCfg.responseWindowHours}
                    onChange={(e) => setSurveyCfg({ ...surveyCfg, responseWindowHours: Number(e.target.value) })}
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm mt-1" />
                  <p className="text-xs text-muted-foreground mt-1">Depois desse prazo, a resposta não vale mais como nota.</p>
                </div>
                <label className="flex items-center gap-2 font-medium">
                  <input type="checkbox" checked={surveyCfg.reminderEnabled} data-testid="checkbox-survey-reminder"
                    onChange={(e) => setSurveyCfg({ ...surveyCfg, reminderEnabled: e.target.checked })} />
                  Lembrar quem não respondeu (1 lembrete)
                </label>
                {surveyCfg.reminderEnabled && (
                  <div>
                    <label className="font-semibold">Enviar o lembrete após (horas)</label>
                    <input type="number" min={1} max={167} value={surveyCfg.reminderHours} data-testid="input-survey-reminder-hours"
                      onChange={(e) => setSurveyCfg({ ...surveyCfg, reminderHours: Number(e.target.value) })}
                      className="w-full px-3 py-2 rounded-xl border border-border text-sm mt-1" />
                    <p className="text-xs text-muted-foreground mt-1">Um único lembrete por atendimento, e só se o prazo de resposta ainda estiver aberto.</p>
                  </div>
                )}
                <label className="flex items-center gap-2 font-medium">
                  <input type="checkbox" checked={surveyCfg.rewardEnabled} onChange={(e) => setSurveyCfg({ ...surveyCfg, rewardEnabled: e.target.checked })} />
                  Enviar cupom/voucher para quem responder
                </label>
                {surveyCfg.rewardEnabled && (
                  <textarea value={surveyCfg.rewardText} rows={2} maxLength={1000}
                    placeholder="Ex.: Use o cupom OBRIGADO10 e ganhe 10% de desconto na próxima compra!"
                    onChange={(e) => setSurveyCfg({ ...surveyCfg, rewardText: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
                )}
                <label className="flex items-center gap-2 font-medium">
                  <input type="checkbox" checked={surveyCfg.raffleInvite} onChange={(e) => setSurveyCfg({ ...surveyCfg, raffleInvite: e.target.checked })} />
                  Avisar que quem responder participa do sorteio
                </label>
                <p className="text-xs text-muted-foreground">💡 Na aba Sorteios, marque "Só quem respondeu a pesquisa de satisfação" para o filtro valer no sorteio.</p>
                <button onClick={saveSurveyCfg} disabled={savingCfg} data-testid="button-save-survey-settings"
                  className="w-full py-2.5 rounded-xl bg-primary text-white font-semibold text-sm disabled:opacity-50">
                  {savingCfg ? "Salvando..." : "Salvar"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Cards de métricas */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {cards.map(({ label, value, icon: Icon, color, bg }) => (
          <div key={label} className={`shk-card p-4 ${bg}`} data-testid={`results-card-${label}`}>
            <Icon className={`w-5 h-5 mb-1 ${color}`} />
            <div className={`text-xl font-extrabold ${color}`}>{loading ? "—" : value}</div>
            <div className="text-[11px] text-muted-foreground font-medium mt-0.5 leading-tight">{label}</div>
          </div>
        ))}
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Ranking dos vendedores */}
        <div className="shk-card p-5">
          <div className="flex items-center gap-2 mb-3">
            <Trophy className="w-4 h-4 text-amber-500" />
            <h3 className="font-bold text-sm text-foreground">{isGlobal ? "Ranking dos vendedores" : "Meu desempenho"}</h3>
          </div>
          {!data || data.ranking.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">Nenhum atendimento no período.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground border-b border-border">
                    <th className="text-left py-2 pr-2 font-semibold">#</th>
                    <th className="text-left py-2 pr-2 font-semibold">Vendedor</th>
                    <th className="text-right py-2 pr-2 font-semibold">Atend.</th>
                    <th className="text-right py-2 pr-2 font-semibold">Tempo médio</th>
                    <th className="text-right py-2 pr-2 font-semibold">Vendas</th>
                    <th className="text-right py-2 pr-2 font-semibold">Nota</th>
                    <th className="text-right py-2 font-semibold">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {data.ranking.map((r, i) => (
                    <tr key={r.attendantId} className="border-b border-border/50 last:border-0" data-testid={`ranking-row-${r.attendantId}`}>
                      <td className="py-2 pr-2">{MEDALS[i] ?? `${i + 1}º`}</td>
                      <td className="py-2 pr-2 font-semibold text-foreground">
                        {r.name}{!r.ativo && <span className="text-muted-foreground font-normal"> (inativo)</span>}
                      </td>
                      <td className="py-2 pr-2 text-right font-bold">{r.atendimentos}</td>
                      <td className="py-2 pr-2 text-right">{fmtDuration(r.avgServiceSeconds)}</td>
                      <td className="py-2 pr-2 text-right">{r.vendas} <span className="text-muted-foreground">({r.conversao}%)</span></td>
                      <td className="py-2 pr-2 text-right">{r.ratings > 0 ? `${r.avgRating.toFixed(1)} ⭐` : "—"}</td>
                      <td className="py-2 text-right font-semibold text-green-700">{fmtMoney(r.totalVendido)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Satisfação por setor */}
        <div className="shk-card p-5">
          <div className="flex items-center gap-2 mb-3">
            <Star className="w-4 h-4 text-yellow-500" />
            <h3 className="font-bold text-sm text-foreground">Satisfação por setor</h3>
          </div>
          {!data || !data.satisfacaoPorSetor?.length ? (
            <p className="text-xs text-muted-foreground py-4 text-center">Nenhuma avaliação no período.</p>
          ) : (
            <div className="space-y-2">
              {data.satisfacaoPorSetor.map((s) => (
                <div key={s.sectorId} className="flex items-center gap-2" data-testid={`satisfaction-sector-${s.sectorId}`}>
                  <span className="text-[11px] text-muted-foreground w-28 shrink-0 truncate">{s.sectorName}</span>
                  <div className="flex-1 h-5 bg-secondary rounded-lg overflow-hidden">
                    <div className="h-full bg-yellow-400/80 rounded-lg transition-all"
                      style={{ width: `${Math.max(4, Math.round((s.avgRating / 5) * 100))}%` }} />
                  </div>
                  <span className="text-xs font-bold text-foreground w-20 text-right">{s.avgRating.toFixed(1)} ⭐ <span className="text-muted-foreground font-normal">({s.ratings})</span></span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Novos leads por mês */}
        <div className="shk-card p-5">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="w-4 h-4 text-cyan-600" />
            <h3 className="font-bold text-sm text-foreground">Novos leads por mês</h3>
          </div>
          {!data || data.leadsPorMes.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">Sem dados ainda.</p>
          ) : (
            <div className="space-y-2">
              {data.leadsPorMes.map((m) => (
                <div key={m.mes} className="flex items-center gap-2" data-testid={`leads-month-${m.mes}`}>
                  <span className="text-[11px] text-muted-foreground w-16 shrink-0 capitalize">{fmtMonth(m.mes)}</span>
                  <div className="flex-1 h-5 bg-secondary rounded-lg overflow-hidden">
                    <div className="h-full bg-cyan-500/80 rounded-lg transition-all"
                      style={{ width: `${Math.max(4, Math.round((m.novos / maxMes) * 100))}%` }} />
                  </div>
                  <span className="text-xs font-bold text-foreground w-8 text-right">{m.novos}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
