import { useCallback, useEffect, useState } from "react";
import { api, type GerenteTaskStats } from "@/lib/api";
import OrganizeSheet from "./GerenteOrganize";

// Painel de tarefas e equipe do Gerente IA ("Meu dia"): números da semana,
// quem está com o quê (abertas, atrasadas, % no prazo, aguardando foto),
// carga por categoria, entrada x saída de tarefas em 14 dias e as mais
// atrasadas. Botão "Arrumar com IA" abre o plano de arrumação.

const WD = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const pctTone = (p: number | null) => p == null ? "text-muted-foreground" : p >= 80 ? "text-green-700" : p >= 50 ? "text-amber-600" : "text-red-600";

export default function GerenteTaskDashboard({ onOpenTasks }: { onOpenTasks?: () => void }) {
  const [st, setSt] = useState<GerenteTaskStats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [organizing, setOrganizing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setSt(await api.gerente.taskStats()); setErr(null); } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 120_000); return () => clearInterval(t); }, [load]);
  const loadPlan = useCallback(() => api.gerente.organizePlan(), []);
  const applyPlan = useCallback((items: Parameters<typeof api.gerente.organizeApply>[0]) => api.gerente.organizeApply(items), []);

  if (err) return <div className="shk-card p-4 text-xs text-red-600">Indicadores de tarefas: {err}</div>;
  if (!st) return <div className="shk-card p-4 text-xs text-muted-foreground">Carregando indicadores de tarefas…</div>;

  const k = st.kpis;
  const maxOpen = Math.max(1, ...st.team.map((p) => p.open));
  const maxCat = Math.max(1, ...st.categories.map((c) => c.open));
  const maxTrend = Math.max(1, ...st.trend.map((d) => Math.max(d.created, d.done)));
  const createdSum = st.trend.reduce((s, d) => s + d.created, 0), doneSum = st.trend.reduce((s, d) => s + d.done, 0);
  const messy = k.overdue + k.noCategory + k.noDue;

  const Kpi = ({ label, value, tone, hint }: { label: string; value: string | number; tone?: string; hint?: string }) => (
    <button onClick={onOpenTasks} title={hint} className="shk-card p-3 text-left hover:ring-1 hover:ring-primary/30 transition">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-xl font-bold tabular-nums ${tone ?? ""}`}>{value}</div>
    </button>
  );

  return (
    <div className="space-y-3" data-testid="gerente-task-dashboard">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="font-bold text-sm">📊 Tarefas e equipe</h3>
        <div className="flex gap-2">
          {messy > 0 && <button onClick={() => setOrganizing(true)} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 text-white">✨ Arrumar com IA</button>}
          {onOpenTasks && <button onClick={onOpenTasks} className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-border">Abrir tarefas →</button>}
        </div>
      </div>
      {msg && <p className="text-xs bg-green-50 text-green-800 border border-green-200 rounded-lg px-3 py-1.5">{msg}</p>}

      <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
        <Kpi label="Abertas" value={k.open} />
        <Kpi label="Atrasadas" value={k.overdue} tone={k.overdue ? "text-red-600" : "text-green-700"} />
        <Kpi label="Vencem hoje" value={k.dueToday} />
        <Kpi label="Feitas 7 dias" value={k.done7} tone="text-green-700" hint={`${k.withProof} com foto de prova`} />
        <Kpi label="No prazo (30d)" value={k.onTimePct == null ? "—" : `${k.onTimePct}%`} tone={pctTone(k.onTimePct)} hint="Concluídas até o prazo, últimos 30 dias" />
        <Kpi label="Sem categoria / prazo" value={`${k.noCategory} / ${k.noDue}`} tone={k.noCategory + k.noDue ? "text-amber-600" : ""} />
      </div>

      <div className="grid lg:grid-cols-3 gap-3 items-start">
        {/* Equipe */}
        <div className="shk-card p-4 space-y-2 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h4 className="font-bold text-xs uppercase tracking-wide text-muted-foreground">Quem está com o quê</h4>
            <span className="text-[10px] text-muted-foreground flex items-center gap-2"><i className="inline-block w-2.5 h-2.5 rounded-sm bg-red-500" /> atrasadas <i className="inline-block w-2.5 h-2.5 rounded-sm bg-primary/50" /> em dia</span>
          </div>
          {st.team.length === 0 && <p className="text-xs text-muted-foreground">Nenhuma tarefa com responsável.</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase text-muted-foreground">
                <tr><th className="text-left font-medium py-1">Pessoa</th><th className="text-left font-medium w-[40%]">Abertas</th><th className="font-medium">Feitas 7d</th><th className="font-medium">No prazo</th><th className="font-medium">Foto pendente</th><th className="font-medium">Adiou</th></tr>
              </thead>
              <tbody>
                {st.team.map((p) => (
                  <tr key={p.userId} className="border-t border-border">
                    <td className="py-1.5 font-semibold whitespace-nowrap pr-2">{p.isOwner ? `${p.name.split(" ")[0]} (você)` : p.name.split(" ").slice(0, 2).join(" ")}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-3 rounded bg-muted/50 overflow-hidden flex" title={`${p.overdue} atrasada(s), ${p.open - p.overdue} em dia`}>
                          <div className="bg-red-500 h-full" style={{ width: `${(p.overdue / maxOpen) * 100}%` }} />
                          <div className="bg-primary/50 h-full" style={{ width: `${((p.open - p.overdue) / maxOpen) * 100}%` }} />
                        </div>
                        <span className="tabular-nums w-10 text-right">{p.open}{p.overdue ? <span className="text-red-600"> ·{p.overdue}</span> : null}</span>
                      </div>
                    </td>
                    <td className="text-center tabular-nums">{p.done7}</td>
                    <td className={`text-center tabular-nums font-semibold ${pctTone(p.onTimePct)}`}>{p.onTimePct == null ? "—" : `${p.onTimePct}%`}</td>
                    <td className={`text-center tabular-nums ${p.awaitingProof ? "text-amber-600 font-semibold" : "text-muted-foreground"}`}>{p.awaitingProof || "—"}</td>
                    <td className={`text-center tabular-nums ${p.postponed >= 3 ? "text-red-600 font-semibold" : "text-muted-foreground"}`}>{p.postponed || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Mais atrasadas */}
        <div className="shk-card p-4 space-y-2">
          <h4 className="font-bold text-xs uppercase tracking-wide text-muted-foreground">Mais atrasadas</h4>
          {st.oldestLate.length === 0 && <p className="text-xs text-muted-foreground">Nenhuma atrasada. 👏</p>}
          {st.oldestLate.map((t) => (
            <div key={t.id} className="text-xs flex gap-2 items-start">
              <span className={`shrink-0 px-1.5 rounded font-bold tabular-nums ${t.daysLate >= 3 ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800"}`}>{t.daysLate}d</span>
              <span className="min-w-0"><b>#{t.id}</b> {t.title}<span className="text-muted-foreground"> · {t.assignees.join(", ") || "sem responsável"}</span></span>
            </div>
          ))}
        </div>

        {/* Categorias */}
        <div className="shk-card p-4 space-y-1.5">
          <h4 className="font-bold text-xs uppercase tracking-wide text-muted-foreground">Abertas por categoria</h4>
          {st.categories.map((c) => (
            <div key={c.name} className="text-xs">
              <div className="flex justify-between"><span className={c.name === "Sem categoria" ? "text-amber-700" : ""}>{c.name}</span><span className="tabular-nums">{c.open}{c.overdue ? <span className="text-red-600"> · {c.overdue} atras.</span> : null}</span></div>
              <div className="h-1.5 rounded bg-muted/50 overflow-hidden flex">
                <div className="bg-red-500 h-full" style={{ width: `${(c.overdue / maxCat) * 100}%` }} />
                <div className="bg-indigo-400 h-full" style={{ width: `${((c.open - c.overdue) / maxCat) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>

        {/* Entrada x saída */}
        <div className="shk-card p-4 space-y-2 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h4 className="font-bold text-xs uppercase tracking-wide text-muted-foreground">Criadas x concluídas — 14 dias</h4>
            <span className="text-[10px] text-muted-foreground flex items-center gap-2">
              <i className="inline-block w-2.5 h-2.5 rounded-sm bg-slate-400" /> criadas {createdSum}
              <i className="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-500" /> concluídas {doneSum}
            </span>
          </div>
          <div className="flex items-end gap-1 h-24">
            {st.trend.map((d) => {
              const dt = new Date(`${d.date}T12:00:00-03:00`);
              return (
                <div key={d.date} className="flex-1 flex flex-col items-center gap-0.5" title={`${d.date.slice(8, 10)}/${d.date.slice(5, 7)}: ${d.created} criada(s), ${d.done} concluída(s)`}>
                  <div className="flex items-end gap-px h-20 w-full justify-center">
                    <div className="w-1/2 max-w-[10px] bg-slate-400 rounded-t" style={{ height: `${(d.created / maxTrend) * 100}%` }} />
                    <div className="w-1/2 max-w-[10px] bg-emerald-500 rounded-t" style={{ height: `${(d.done / maxTrend) * 100}%` }} />
                  </div>
                  <span className={`text-[9px] ${d.date === st.today ? "font-bold" : "text-muted-foreground"}`}>{dt.getDay() === 1 || d.date === st.today ? `${d.date.slice(8, 10)}` : WD[dt.getDay()]![0]}</span>
                </div>
              );
            })}
          </div>
          <p className="text-[10px] text-muted-foreground">{createdSum > doneSum ? `⚠️ Entraram ${createdSum - doneSum} tarefa(s) a mais do que saíram — a lista está crescendo.` : "✅ Saíram tantas tarefas quanto entraram — a lista está sob controle."}</p>
        </div>
      </div>

      {organizing && <OrganizeSheet load={loadPlan} apply={applyPlan} onClose={() => setOrganizing(false)} onDone={(m) => { setMsg(m); void load(); }} />}
    </div>
  );
}
