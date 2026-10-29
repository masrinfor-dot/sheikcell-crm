import { useCallback, useEffect, useMemo, useState } from "react";
import OrganizeSheet, { type OrganizeItem } from "./GerenteOrganize";

// Gerenciador de tarefas do Gerente IA — o mesmo no link do celular (/g/:token,
// sem login) e na aba "Tarefas" do painel. Inspirado em Todoist/Things/
// ClickUp: visões prontas (Hoje, Atrasadas, Próximas, Sem prazo, Equipe,
// Concluídas, Quadro), concluir com 1 toque, filtros por pessoa/categoria,
// busca, captura rápida e uma ficha da tarefa com prazo, prioridade,
// responsáveis, categoria, checklist, comentários (com aviso no WhatsApp) e
// fotos de prova. Só o link do dono edita; o do vendedor é só leitura.

type Person = { id: number; name: string; isOwner?: boolean };
type TaskRow = {
  id: number; title: string; description: string | null; status: "todo" | "doing" | "done"; priority: "baixa" | "media" | "alta";
  dueDate: string | null; createdAt: string; updatedAt: string; category: string | null;
  assignees: { id: number; name: string }[]; subtasks: { total: number; done: number }; comments: number; hasProof: boolean; whatsapp: string | null;
};
type TaskDetail = TaskRow & {
  subtaskList: { id: number; title: string; done: boolean }[];
  commentList: { id: number; content: string; author: string | null; createdAt: string; image: boolean }[];
};
type DiaData = {
  scope: "dia"; canEdit: boolean; today: string; now: string;
  events: { id: number; title: string; startsAt: string; location: string | null }[];
  reminders: { id: number; title: string; dueAt: string; urgent: boolean }[];
  bills: { id: number; kind: string; description: string; amountCents: number; dueDate: string }[];
  tasks: TaskRow[]; team: Person[]; categories: string[];
};
type View = "hoje" | "atrasadas" | "proximas" | "semprazo" | "equipe" | "concluidas" | "quadro";

const TZ = "America/Sao_Paulo";
const dayISO = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const fmtDT = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const WD = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const brl = (c: number) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const first = (n: string) => n.trim().split(" ")[0] ?? n;
const initials = (n: string) => n.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");
const addDaysISO = (iso: string, d: number) => new Date(new Date(`${iso}T12:00:00-03:00`).getTime() + d * 86_400_000).toLocaleDateString("en-CA", { timeZone: TZ });
const toLocalInput = (iso: string) => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(new Date(iso)).reduce<Record<string, string>>((a, x) => { a[x.type] = x.value; return a; }, {});
  return `${p["year"]}-${p["month"]}-${p["day"]}T${p["hour"] === "24" ? "00" : p["hour"]}:${p["minute"]}`;
};
const PRIO: Record<string, { label: string; bar: string; dot: string }> = {
  alta: { label: "Alta", bar: "border-l-red-500", dot: "bg-red-500" },
  media: { label: "Média", bar: "border-l-amber-400", dot: "bg-amber-400" },
  baixa: { label: "Baixa", bar: "border-l-slate-300", dot: "bg-slate-300" },
};
const STATUS_LABEL: Record<string, string> = { todo: "A fazer", doing: "Em andamento", done: "Concluída" };
const AVATAR = ["bg-blue-600", "bg-emerald-600", "bg-violet-600", "bg-rose-600", "bg-amber-600", "bg-cyan-600", "bg-fuchsia-600", "bg-lime-700"];

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `Erro ${r.status}`);
  return j as T;
}

export default function GerenteTasks({ token, embedded = false }: { token: string; embedded?: boolean }) {
  const base = `/api/gerente-public/${token}`;
  const [data, setData] = useState<DiaData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => (embedded && typeof window !== "undefined" && window.innerWidth >= 1024 ? "quadro" : "hoje"));
  const [person, setPerson] = useState<number | "">("");
  const [category, setCategory] = useState("");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const [capture, setCapture] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [organizing, setOrganizing] = useState(false);
  const loadPlan = useCallback(() => api<{ merged: number; items: OrganizeItem[] }>(`${base}/organize-plan`, { method: "POST" }), [base]);
  const applyPlan = useCallback((items: OrganizeItem[]) => api<{ applied: number }>(`${base}/organize-apply`, { method: "POST", body: JSON.stringify({ items }) }), [base]);

  const load = useCallback(async () => {
    try { setData(await api<DiaData>(base)); setError(null); } catch (e) { setError((e as Error).message); }
  }, [base]);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 60_000); return () => clearInterval(t); }, [load]);
  const flash = (m: string) => { setToast(m.replace(/\*/g, "")); setTimeout(() => setToast(null), 5000); };

  const canEdit = !!data?.canEdit;
  const ownerId = data?.team.find((p) => p.isOwner)?.id ?? null;
  const colorOf = useCallback((id: number) => AVATAR[(data?.team.findIndex((p) => p.id === id) ?? 0) % AVATAR.length]!, [data]);

  const now = data ? new Date(data.now).getTime() : Date.now();
  const filtered = useMemo(() => {
    if (!data) return [];
    const qq = q.trim().toLowerCase();
    return data.tasks.filter((t) =>
      (person === "" || t.assignees.some((a) => a.id === person)) &&
      (!category || t.category === category) &&
      (!qq || t.title.toLowerCase().includes(qq) || String(t.id) === qq));
  }, [data, person, category, q]);
  const open = filtered.filter((t) => t.status !== "done");
  const overdue = open.filter((t) => t.dueDate && new Date(t.dueDate).getTime() < now);
  const today = open.filter((t) => t.dueDate && dayISO(t.dueDate) === data?.today && new Date(t.dueDate).getTime() >= now);
  const upcoming = open.filter((t) => t.dueDate && dayISO(t.dueDate) > (data?.today ?? ""));
  const noDue = open.filter((t) => !t.dueDate);
  const done = filtered.filter((t) => t.status === "done").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const byPrio = (a: TaskRow, b: TaskRow) => ["alta", "media", "baixa"].indexOf(a.priority) - ["alta", "media", "baixa"].indexOf(b.priority) || (a.dueDate ?? "9").localeCompare(b.dueDate ?? "9");

  const complete = async (t: TaskRow) => {
    if (!canEdit) return;
    const next = t.status === "done" ? "todo" : "done";
    setData((d) => d ? { ...d, tasks: d.tasks.map((x) => x.id === t.id ? { ...x, status: next, updatedAt: new Date().toISOString() } : x) } : d);
    try { const r = await api<{ message: string }>(`${base}/task/${t.id}/status`, { method: "POST", body: JSON.stringify({ status: next, notify: true }) }); flash(r.message); }
    catch (e) { flash((e as Error).message); }
    void load();
  };
  const sendCapture = async () => {
    const text = capture.trim(); if (!text || busy) return;
    setBusy(true);
    try { const r = await api<{ replies: string[] }>(`${base}/capture`, { method: "POST", body: JSON.stringify({ text }) }); setCapture(""); flash(r.replies.join("\n")); await load(); }
    catch (e) { flash((e as Error).message); } finally { setBusy(false); }
  };
  const mergeDup = async () => {
    try { const r = await api<{ archived: number }>(`${base}/merge-duplicates`, { method: "POST" }); flash(r.archived ? `🧹 ${r.archived} tarefa(s) duplicada(s) juntadas.` : "Nenhuma duplicada."); await load(); }
    catch (e) { flash((e as Error).message); }
  };

  if (error) return <div className="bg-white rounded-2xl p-4 text-sm text-red-700">{error}</div>;
  if (!data) return <p className="text-sm text-slate-500 p-4">Carregando…</p>;

  const Row = ({ t }: { t: TaskRow }) => {
    const late = t.status !== "done" && t.dueDate && new Date(t.dueDate).getTime() < now;
    const onlyOwner = t.assignees.length === 1 && t.assignees[0]!.id === ownerId;
    return (
      <div className={`flex items-start gap-3 bg-white border border-slate-200 border-l-4 ${PRIO[t.priority]?.bar ?? ""} rounded-xl px-3 py-2.5 ${t.status === "done" ? "opacity-60" : ""}`}>
        <button onClick={() => complete(t)} disabled={!canEdit} aria-label="Concluir"
          className={`mt-0.5 w-6 h-6 shrink-0 rounded-full border-2 flex items-center justify-center ${t.status === "done" ? "bg-green-600 border-green-600 text-white" : "border-slate-400 hover:border-green-600"} ${canEdit ? "" : "cursor-default"}`}>
          {t.status === "done" ? "✓" : ""}
        </button>
        <button onClick={() => setOpenId(t.id)} className="flex-1 min-w-0 text-left">
          <div className={`text-[15px] leading-snug ${t.status === "done" ? "line-through" : "text-slate-900"}`}>
            {t.status === "doing" && <span className="text-blue-600 text-xs font-semibold mr-1">▶</span>}{t.title}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 mt-1 text-[11px]">
            <span className="text-slate-400">#{t.id}</span>
            {t.dueDate && <span className={`px-1.5 py-0.5 rounded-md ${late ? "bg-red-100 text-red-700 font-semibold" : "bg-slate-100 text-slate-600"}`}>{dayISO(t.dueDate) === data.today ? `hoje ${fmtTime(t.dueDate)}` : fmtDT(t.dueDate)}</span>}
            {t.category && <span className="px-1.5 py-0.5 rounded-md bg-indigo-50 text-indigo-700">{t.category}</span>}
            {t.subtasks.total > 0 && <span className="text-slate-500">☑ {t.subtasks.done}/{t.subtasks.total}</span>}
            {t.comments > 0 && <span className="text-slate-500">💬 {t.comments}</span>}
            {t.hasProof && <span>📸</span>}
            {t.whatsapp === "aguardando_prova" && <span className="text-amber-700">aguardando foto</span>}
          </div>
        </button>
        <div className="flex -space-x-1.5 shrink-0 mt-0.5">
          {onlyOwner ? <span className="text-[10px] text-slate-400 mt-1">eu</span> : t.assignees.slice(0, 3).map((a) => (
            <span key={a.id} title={a.name} className={`w-6 h-6 rounded-full ${colorOf(a.id)} text-white text-[10px] font-bold flex items-center justify-center ring-2 ring-white`}>{initials(a.name)}</span>
          ))}
        </div>
      </div>
    );
  };
  const Section = ({ title, tasks, tone }: { title: string; tasks: TaskRow[]; tone?: string }) => tasks.length ? (
    <div className="space-y-1.5">
      <h3 className={`text-xs font-bold uppercase tracking-wide ${tone ?? "text-slate-500"}`}>{title} · {tasks.length}</h3>
      {tasks.map((t) => <Row key={t.id} t={t} />)}
    </div>
  ) : null;

  const tabs: { id: View; label: string; n?: number }[] = [
    { id: "hoje", label: "Hoje", n: today.length + overdue.length },
    { id: "atrasadas", label: "Atrasadas", n: overdue.length },
    { id: "proximas", label: "Próximas", n: upcoming.length },
    { id: "semprazo", label: "Sem prazo", n: noDue.length },
    { id: "equipe", label: "Equipe" },
    { id: "quadro", label: "📊 Kanban" },
    { id: "concluidas", label: "Concluídas", n: done.length },
  ];

  const upcomingByDay = [...new Set(upcoming.map((t) => dayISO(t.dueDate!)))].sort();
  const people = data.team.map((p) => ({ ...p, open: open.filter((t) => t.assignees.some((a) => a.id === p.id)) }))
    .filter((p) => p.open.length).sort((a, b) => (a.isOwner ? -1 : b.isOwner ? 1 : b.open.length - a.open.length));
  const unassigned = open.filter((t) => t.assignees.length === 0);

  return (
    <div className={`space-y-3 ${embedded || view === "quadro" ? "" : "max-w-2xl mx-auto"}`}>
      {canEdit && (
        <div className="flex gap-2">
          <input value={capture} onChange={(e) => setCapture(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void sendCapture(); }}
            placeholder="+ Nova: “tarefa pro Alan e Davi: conferir estoque até sexta”" disabled={busy}
            className="flex-1 min-w-0 rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm" />
          <button onClick={sendCapture} disabled={busy || !capture.trim()} className="rounded-xl bg-slate-900 text-white px-4 text-sm font-semibold disabled:opacity-40">{busy ? "…" : "Criar"}</button>
        </div>
      )}

      <div className="grid grid-cols-4 gap-2">
        {[
          { l: "Atrasadas", n: overdue.length, c: overdue.length ? "text-red-600" : "text-slate-800", v: "atrasadas" as View },
          { l: "Hoje", n: today.length, c: "text-slate-800", v: "hoje" as View },
          { l: "Abertas", n: open.length, c: "text-slate-800", v: "equipe" as View },
          { l: "Feitas 7d", n: done.length, c: "text-green-700", v: "concluidas" as View },
        ].map((k) => (
          <button key={k.l} onClick={() => setView(k.v)} className="bg-white rounded-xl border border-slate-200 py-2 text-center">
            <div className={`text-xl font-bold ${k.c}`}>{k.n}</div><div className="text-[10px] text-slate-500 uppercase">{k.l}</div>
          </button>
        ))}
      </div>

      {canEdit && (overdue.length + noDue.length + data.tasks.filter((t) => t.status !== "done" && !t.category).length) > 0 && (
        <button onClick={() => setOrganizing(true)} className="w-full rounded-xl border border-indigo-200 bg-indigo-50 text-indigo-800 text-sm font-semibold py-2.5">
          ✨ Arrumar tarefas — {overdue.length} atrasada(s), {data.tasks.filter((t) => t.status !== "done" && !t.category).length} sem setor
        </button>
      )}

      <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setView(t.id)} className={`shrink-0 px-3 py-1.5 rounded-full text-sm font-medium border ${view === t.id ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-300"}`}>
            {t.label}{t.n ? <span className={`ml-1 text-xs ${view === t.id ? "text-white/70" : "text-slate-400"}`}>{t.n}</span> : null}
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        <select value={person} onChange={(e) => setPerson(e.target.value ? Number(e.target.value) : "")} className="flex-1 min-w-0 rounded-xl border border-slate-300 bg-white px-2 py-2 text-sm">
          <option value="">Todas as pessoas</option>
          {data.team.map((p) => <option key={p.id} value={p.id}>{p.isOwner ? `${first(p.name)} (eu)` : p.name}</option>)}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="flex-1 min-w-0 rounded-xl border border-slate-300 bg-white px-2 py-2 text-sm">
          <option value="">Todos os setores</option>
          {data.categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar" className="w-24 sm:w-40 rounded-xl border border-slate-300 bg-white px-2 py-2 text-sm" />
      </div>

      {view === "hoje" && (
        <div className="space-y-4">
          {(data.events.some((e) => dayISO(e.startsAt) === data.today) || data.reminders.length > 0) && (
            <div className="bg-white rounded-xl border border-slate-200 p-3 space-y-1 text-sm">
              {data.events.filter((e) => dayISO(e.startsAt) === data.today).map((e) => <div key={`e${e.id}`}>📅 <b>{fmtTime(e.startsAt)}</b> {e.title}{e.location ? <span className="text-slate-500"> · {e.location}</span> : null}</div>)}
              {data.reminders.map((r) => <div key={`r${r.id}`}>⏰ <b>{fmtTime(r.dueAt)}</b> {r.title}{r.urgent ? " ‼️" : ""}</div>)}
            </div>
          )}
          <Section title="Atrasadas" tasks={[...overdue].sort(byPrio)} tone="text-red-600" />
          <Section title="Hoje" tasks={[...today].sort(byPrio)} />
          {!overdue.length && !today.length && <p className="text-sm text-slate-500 text-center py-6">Nada pra hoje. 🎉 Veja <button className="underline" onClick={() => setView("proximas")}>próximas</button> ou <button className="underline" onClick={() => setView("semprazo")}>sem prazo</button>.</p>}
        </div>
      )}
      {view === "atrasadas" && (overdue.length ? <Section title="Atrasadas" tasks={[...overdue].sort((a, b) => a.dueDate!.localeCompare(b.dueDate!))} tone="text-red-600" /> : <p className="text-sm text-slate-500 text-center py-6">Nenhuma atrasada. 👏</p>)}
      {view === "proximas" && (upcomingByDay.length ? <div className="space-y-4">{upcomingByDay.map((d) => {
        const dt = new Date(`${d}T12:00:00-03:00`);
        return <Section key={d} title={`${WD[dt.getDay()]} ${d.slice(8, 10)}/${d.slice(5, 7)}${d === addDaysISO(data.today, 1) ? " · amanhã" : ""}`} tasks={upcoming.filter((t) => dayISO(t.dueDate!) === d).sort(byPrio)} />;
      })}</div> : <p className="text-sm text-slate-500 text-center py-6">Nada agendado pra frente.</p>)}
      {view === "semprazo" && (noDue.length ? <Section title="Sem prazo" tasks={[...noDue].sort(byPrio)} /> : <p className="text-sm text-slate-500 text-center py-6">Toda tarefa tem prazo. 👌</p>)}
      {view === "equipe" && (
        <div className="space-y-4">
          {people.map((p) => {
            const late = p.open.filter((t) => t.dueDate && new Date(t.dueDate).getTime() < now).length;
            return (
              <div key={p.id} className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className={`w-7 h-7 rounded-full ${colorOf(p.id)} text-white text-[11px] font-bold flex items-center justify-center`}>{initials(p.name)}</span>
                  <b className="text-sm">{p.isOwner ? `${first(p.name)} (minhas)` : p.name}</b>
                  <span className="text-xs text-slate-500">{p.open.length} aberta(s){late ? <span className="text-red-600 font-semibold"> · {late} atrasada(s)</span> : null}</span>
                </div>
                {[...p.open].sort(byPrio).map((t) => <Row key={`${p.id}-${t.id}`} t={t} />)}
              </div>
            );
          })}
          <Section title="Sem responsável" tasks={unassigned} />
        </div>
      )}
      {view === "quadro" && (
        <Kanban tasks={filtered} team={data.team} categories={data.categories} canEdit={canEdit} now={now}
          renderCard={(t) => <Row t={t} />}
          onMove={async (t, patchBody, statusTo) => {
            try {
              if (statusTo) {
                setData((d) => d ? { ...d, tasks: d.tasks.map((x) => x.id === t.id ? { ...x, status: statusTo } : x) } : d);
                const r = await api<{ message: string }>(`${base}/task/${t.id}/status`, { method: "POST", body: JSON.stringify({ status: statusTo, notify: true }) }); flash(r.message);
              } else if (patchBody) {
                const r = await api<{ message?: string }>(`${base}/task/${t.id}`, { method: "PATCH", body: JSON.stringify(patchBody) }); if (r.message) flash(r.message);
              }
            } catch (e) { flash((e as Error).message); }
            void load();
          }} />
      )}
      {view === "concluidas" && (done.length ? <Section title="Concluídas (7 dias)" tasks={done} tone="text-green-700" /> : <p className="text-sm text-slate-500 text-center py-6">Nada concluído nos últimos 7 dias.</p>)}

      {data.bills.length > 0 && view === "hoje" && (
        <div className="bg-white rounded-xl border border-slate-200 p-3 space-y-1 text-sm">
          <h3 className="text-xs font-bold uppercase text-slate-500">Contas em aberto</h3>
          {data.bills.slice(0, 6).map((b) => <div key={b.id} className={`flex justify-between ${b.dueDate < data.today ? "text-red-700" : ""}`}><span>{b.kind === "pagar" ? "📤" : "📥"} {b.description}</span><span>{brl(b.amountCents)} · {b.dueDate.slice(8, 10)}/{b.dueDate.slice(5, 7)}</span></div>)}
        </div>
      )}

      {canEdit && <div className="text-center"><button onClick={mergeDup} className="text-xs text-slate-500 underline">🧹 Só juntar duplicadas</button></div>}
      {organizing && <OrganizeSheet load={loadPlan} apply={applyPlan} onClose={() => setOrganizing(false)} onDone={(m) => { flash(m); void load(); }} />}

      {openId != null && <TaskSheet base={base} id={openId} canEdit={canEdit} team={data.team} categories={data.categories} today={data.today} onClose={() => setOpenId(null)} onChanged={(m) => { if (m) flash(m); void load(); }} />}
      {toast && <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] max-w-[92vw] bg-slate-900 text-white text-sm rounded-xl px-4 py-2.5 shadow-lg whitespace-pre-wrap">{toast}</div>}
    </div>
  );
}

// ─── Kanban ──────────────────────────────────────────────────────────────────
// Agrupa por situação, responsável ou loja/categoria. No computador arrasta o
// cartão; no celular usa o "Mover para…" do cartão. Mudar de coluna = mudar a
// situação (avisa o responsável), o responsável (o novo recebe no WhatsApp) ou
// a categoria.

type GroupBy = "status" | "pessoa" | "categoria";
type Col = { key: string; title: string; tone: string; tasks: TaskRow[]; accepts: boolean };

function Kanban({ tasks, team, categories, canEdit, now, renderCard, onMove }: {
  tasks: TaskRow[]; team: Person[]; categories: string[]; canEdit: boolean; now: number;
  renderCard: (t: TaskRow) => React.ReactNode;
  onMove: (t: TaskRow, patch: Record<string, unknown> | null, status: "todo" | "doing" | "done" | null) => Promise<void>;
}) {
  const [group, setGroup] = useState<GroupBy>(() => { try { return (localStorage.getItem("gerente.kanban.group") as GroupBy) || "status"; } catch { return "status"; } });
  const [dragId, setDragId] = useState<number | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const pick = (g: GroupBy) => { setGroup(g); try { localStorage.setItem("gerente.kanban.group", g); } catch { /* sem storage */ } };
  const open = tasks.filter((t) => t.status !== "done");
  const prio = (a: TaskRow, b: TaskRow) => ["alta", "media", "baixa"].indexOf(a.priority) - ["alta", "media", "baixa"].indexOf(b.priority) || (a.dueDate ?? "9").localeCompare(b.dueDate ?? "9");
  const waiting = (t: TaskRow) => t.status !== "done" && t.whatsapp === "aguardando_prova";

  let cols: Col[];
  if (group === "status") {
    cols = [
      { key: "todo", title: "A fazer", tone: "bg-slate-200/70", tasks: open.filter((t) => t.status === "todo" && !waiting(t)).sort(prio), accepts: true },
      { key: "doing", title: "Fazendo", tone: "bg-blue-100/70", tasks: open.filter((t) => t.status === "doing" && !waiting(t)).sort(prio), accepts: true },
      { key: "wait", title: "Aguardando foto", tone: "bg-amber-100/70", tasks: open.filter(waiting).sort(prio), accepts: false },
      { key: "done", title: "Feito (7 dias)", tone: "bg-green-100/70", tasks: tasks.filter((t) => t.status === "done").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), accepts: true },
    ];
  } else if (group === "pessoa") {
    const ordered = [...team].sort((a, b) => (a.isOwner ? -1 : b.isOwner ? 1 : a.name.localeCompare(b.name)));
    cols = ordered.map((p) => ({
      key: `p${p.id}`, title: p.isOwner ? `${first(p.name)} (você)` : p.name.split(" ").slice(0, 2).join(" "), tone: "bg-slate-200/70",
      tasks: open.filter((t) => t.assignees.some((a) => a.id === p.id)).sort(prio), accepts: true,
    }));
    const none = open.filter((t) => t.assignees.length === 0);
    if (none.length) cols.push({ key: "p0", title: "Sem responsável", tone: "bg-amber-100/70", tasks: none, accepts: false });
  } else {
    cols = categories.map((c) => ({ key: `c:${c}`, title: c, tone: "bg-indigo-100/60", tasks: open.filter((t) => t.category === c).sort(prio), accepts: true }));
    cols.push({ key: "c:", title: "Sem setor", tone: "bg-amber-100/70", tasks: open.filter((t) => !t.category).sort(prio), accepts: true });
  }

  const move = (t: TaskRow, key: string) => {
    if (group === "status") {
      if (key === "wait") return;
      const st = key as "todo" | "doing" | "done";
      if (st !== t.status) void onMove(t, null, st);
    } else if (group === "pessoa") {
      const id = Number(key.slice(1));
      if (!id || (t.assignees.length === 1 && t.assignees[0]!.id === id)) return;
      void onMove(t, { assigneeIds: [id] }, null);
    } else {
      const c = key.slice(2) || null;
      if (c !== t.category) void onMove(t, { category: c }, null);
    }
  };
  const late = cols.reduce((n, c) => n + c.tasks.filter((t) => t.status !== "done" && t.dueDate && new Date(t.dueDate).getTime() < now).length, 0);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-slate-500">Agrupar por</span>
        {([["status", "Situação"], ["pessoa", "Responsável"], ["categoria", "Setor"]] as const).map(([g, l]) => (
          <button key={g} onClick={() => pick(g)} className={`px-3 py-1 rounded-full text-xs font-semibold border ${group === g ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-slate-700 border-slate-300"}`}>{l}</button>
        ))}
        {late > 0 && <span className="text-xs text-red-600 font-semibold">⚠️ {late} atrasada(s)</span>}
        {canEdit && <span className="text-[11px] text-slate-400 hidden md:inline">Arraste o cartão pra outra coluna</span>}
      </div>
      <div className="flex gap-3 overflow-x-auto pb-3 -mx-1 px-1 snap-x">
        {cols.map((c) => (
          <div key={c.key}
            onDragOver={(e) => { if (canEdit && c.accepts && dragId != null) { e.preventDefault(); setOver(c.key); } }}
            onDragLeave={() => setOver((o) => (o === c.key ? null : o))}
            onDrop={(e) => { e.preventDefault(); setOver(null); const t = tasks.find((x) => x.id === dragId); setDragId(null); if (t) move(t, c.key); }}
            className={`snap-start shrink-0 w-[82%] sm:w-72 rounded-2xl p-2 space-y-1.5 ${c.tone} ${over === c.key ? "ring-2 ring-indigo-500" : ""}`}>
            <div className="flex items-center justify-between px-1">
              <h3 className="text-xs font-bold uppercase text-slate-700 truncate">{c.title}</h3>
              <span className="text-xs text-slate-500 tabular-nums">{c.tasks.length}</span>
            </div>
            {c.tasks.length === 0 && <p className="text-[11px] text-slate-400 px-1 py-3 text-center">{canEdit && c.accepts ? "Solte um cartão aqui" : "—"}</p>}
            {c.tasks.map((t) => (
              <div key={t.id} draggable={canEdit} onDragStart={() => setDragId(t.id)} onDragEnd={() => { setDragId(null); setOver(null); }}
                className={`${dragId === t.id ? "opacity-40" : ""} ${canEdit ? "cursor-grab active:cursor-grabbing" : ""}`}>
                {renderCard(t)}
                {canEdit && (
                  <select value="" onChange={(e) => { if (e.target.value) move(t, e.target.value); }} aria-label="Mover para"
                    className="md:hidden mt-1 w-full text-[11px] rounded-lg border border-slate-300 bg-white/80 px-2 py-1 text-slate-600">
                    <option value="">Mover para…</option>
                    {cols.filter((x) => x.accepts && x.key !== c.key).map((x) => <option key={x.key} value={x.key}>{x.title}</option>)}
                  </select>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      {group === "pessoa" && canEdit && <p className="text-[11px] text-slate-500">Arrastar pra outra pessoa troca o responsável — quem recebe é avisado no WhatsApp e no chat do CRM.</p>}
    </div>
  );
}

// ─── Ficha da tarefa ─────────────────────────────────────────────────────────

export function TaskSheet({ base, id, canEdit, team, categories, today, onClose, onChanged, inline = false }: {
  base: string; id: number; canEdit: boolean; team: Person[]; categories: string[]; today: string;
  onClose?: () => void; onChanged: (msg?: string) => void; inline?: boolean;
}) {
  const [t, setT] = useState<TaskDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [comment, setComment] = useState("");
  const [notify, setNotify] = useState(true);
  const [sub, setSub] = useState("");
  const [busy, setBusy] = useState(false);
  const [photo, setPhoto] = useState<string | null>(null);
  const [newCat, setNewCat] = useState("");

  const load = useCallback(async () => {
    try { const r = await api<{ task: TaskDetail }>(`${base}/task/${id}`); setT(r.task); setTitle(r.task.title); } catch (e) { setErr((e as Error).message); }
  }, [base, id]);
  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<{ message?: string } | unknown>) => {
    setBusy(true);
    try { const r = await fn() as { message?: string }; await load(); onChanged(r?.message); }
    catch (e) { onChanged((e as Error).message); } finally { setBusy(false); }
  };
  const patch = (body: Record<string, unknown>) => run(() => api(`${base}/task/${id}`, { method: "PATCH", body: JSON.stringify(body) }));
  const setStatus = (status: string) => run(() => api(`${base}/task/${id}/status`, { method: "POST", body: JSON.stringify({ status, notify: true }) }));

  const shell = (children: React.ReactNode) => inline ? <div className="space-y-3">{children}</div> : (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="bg-slate-50 w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center"><span className="text-xs text-slate-400">Tarefa #{id}</span><button onClick={onClose} className="text-slate-500 text-sm px-2">Fechar ✕</button></div>
        {children}
      </div>
    </div>
  );
  if (err) return shell(<p className="text-sm text-red-700">{err}</p>);
  if (!t) return shell(<p className="text-sm text-slate-500">Carregando…</p>);

  const assigned = new Set(t.assignees.map((a) => a.id));
  const quick = [
    { l: "Hoje 18h", v: `${today}T18:00` },
    { l: "Amanhã 9h", v: `${addDaysISO(today, 1)}T09:00` },
    { l: "+3 dias", v: `${addDaysISO(today, 3)}T18:00` },
    { l: "+1 semana", v: `${addDaysISO(today, 7)}T18:00` },
  ];
  const card = "bg-white rounded-2xl border border-slate-200 p-3 space-y-2";

  return shell(<>
    <div className={card}>
      {canEdit
        ? <textarea value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => { if (title.trim() && title !== t.title) void patch({ title }); }} rows={2} className="w-full text-lg font-semibold resize-none outline-none" />
        : <p className="text-lg font-semibold">{t.title}</p>}
      {t.description && <p className="text-sm text-slate-600 whitespace-pre-wrap">{t.description}</p>}
      <div className="grid grid-cols-3 gap-1.5">
        {(["todo", "doing", "done"] as const).map((s) => (
          <button key={s} disabled={!canEdit || busy || t.status === s} onClick={() => setStatus(s)}
            className={`rounded-xl py-2.5 text-sm font-semibold border ${t.status === s ? (s === "done" ? "bg-green-600 text-white border-green-600" : s === "doing" ? "bg-blue-600 text-white border-blue-600" : "bg-slate-800 text-white border-slate-800") : "bg-white text-slate-700 border-slate-300"} disabled:cursor-default`}>
            {s === "done" ? "✅ " : s === "doing" ? "▶️ " : ""}{STATUS_LABEL[s]}
          </button>
        ))}
      </div>
      {canEdit && <p className="text-[11px] text-slate-500">Mudar a situação avisa o responsável no WhatsApp.</p>}
    </div>

    <div className={card}>
      <h4 className="text-xs font-bold uppercase text-slate-500">Prazo</h4>
      <p className="text-sm">{t.dueDate ? fmtDT(t.dueDate) : "Sem prazo"}</p>
      {canEdit && <>
        <div className="flex flex-wrap gap-1.5">
          {quick.map((x) => <button key={x.l} disabled={busy} onClick={() => patch({ dueDate: x.v })} className="px-3 py-1.5 rounded-full border border-slate-300 text-sm bg-white">{x.l}</button>)}
          {t.dueDate && <button disabled={busy} onClick={() => patch({ dueDate: null })} className="px-3 py-1.5 rounded-full border border-slate-300 text-sm bg-white text-slate-500">Sem prazo</button>}
        </div>
        <input type="datetime-local" defaultValue={t.dueDate ? toLocalInput(t.dueDate) : ""} onChange={(e) => { if (e.target.value) void patch({ dueDate: e.target.value }); }} className="w-full rounded-xl border border-slate-300 px-2 py-2 text-sm" />
      </>}
    </div>

    <div className={card}>
      <h4 className="text-xs font-bold uppercase text-slate-500">Prioridade</h4>
      <div className="grid grid-cols-3 gap-1.5">
        {(["alta", "media", "baixa"] as const).map((p) => (
          <button key={p} disabled={!canEdit || busy} onClick={() => patch({ priority: p })}
            className={`rounded-xl py-2 text-sm border flex items-center justify-center gap-1.5 ${t.priority === p ? "bg-slate-900 text-white border-slate-900" : "bg-white border-slate-300"}`}>
            <span className={`w-2.5 h-2.5 rounded-full ${PRIO[p]!.dot}`} />{PRIO[p]!.label}
          </button>
        ))}
      </div>
    </div>

    <div className={card}>
      <h4 className="text-xs font-bold uppercase text-slate-500">Responsáveis</h4>
      {canEdit ? (
        <div className="flex flex-wrap gap-1.5">
          {team.map((p) => {
            const on = assigned.has(p.id);
            return <button key={p.id} disabled={busy} onClick={() => patch({ assigneeIds: on ? [...assigned].filter((x) => x !== p.id) : [...assigned, p.id] })}
              className={`px-3 py-1.5 rounded-full text-sm border ${on ? "bg-blue-600 text-white border-blue-600" : "bg-white border-slate-300"}`}>{on ? "✓ " : ""}{p.isOwner ? `${first(p.name)} (eu)` : first(p.name)}</button>;
          })}
        </div>
      ) : <p className="text-sm">{t.assignees.map((a) => a.name).join(", ") || "—"}</p>}
      {canEdit && <p className="text-[11px] text-slate-500">Quem você adicionar recebe a tarefa no WhatsApp.</p>}
    </div>

    <div className={card}>
      <h4 className="text-xs font-bold uppercase text-slate-500">Setor</h4>
      {canEdit ? (
        <>
          <div className="flex flex-wrap gap-1.5">
            {categories.map((c) => <button key={c} disabled={busy} onClick={() => patch({ category: t.category === c ? null : c })}
              className={`px-3 py-1.5 rounded-full text-sm border ${t.category === c ? "bg-indigo-600 text-white border-indigo-600" : "bg-white border-slate-300"}`}>{c}</button>)}
          </div>
          <div className="flex gap-2">
            <input value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder="Outro setor" className="flex-1 rounded-xl border border-slate-300 px-2 py-1.5 text-sm" />
            <button disabled={!newCat.trim() || busy} onClick={() => { void patch({ category: newCat.trim() }); setNewCat(""); }} className="px-3 rounded-xl bg-slate-900 text-white text-sm disabled:opacity-40">Usar</button>
          </div>
        </>
      ) : <p className="text-sm">{t.category ?? "—"}</p>}
    </div>

    <div className={card}>
      <h4 className="text-xs font-bold uppercase text-slate-500">Checklist {t.subtaskList.length ? `${t.subtaskList.filter((s) => s.done).length}/${t.subtaskList.length}` : ""}</h4>
      {t.subtaskList.map((s) => (
        <label key={s.id} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={s.done} disabled={!canEdit || busy} onChange={(e) => run(() => api(`${base}/task/${id}/subtasks/${s.id}`, { method: "PATCH", body: JSON.stringify({ done: e.target.checked }) }))} className="w-5 h-5" />
          <span className={s.done ? "line-through text-slate-400" : ""}>{s.title}</span>
        </label>
      ))}
      {canEdit && (
        <div className="flex gap-2">
          <input value={sub} onChange={(e) => setSub(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && sub.trim()) { void run(() => api(`${base}/task/${id}/subtasks`, { method: "POST", body: JSON.stringify({ title: sub }) })); setSub(""); } }} placeholder="+ item do checklist" className="flex-1 rounded-xl border border-slate-300 px-2 py-1.5 text-sm" />
          <button disabled={!sub.trim() || busy} onClick={() => { void run(() => api(`${base}/task/${id}/subtasks`, { method: "POST", body: JSON.stringify({ title: sub }) })); setSub(""); }} className="px-3 rounded-xl bg-slate-900 text-white text-sm disabled:opacity-40">+</button>
        </div>
      )}
    </div>

    <div className={card}>
      <h4 className="text-xs font-bold uppercase text-slate-500">Comentários e provas</h4>
      {t.commentList.length === 0 && <p className="text-xs text-slate-500">Nada ainda.</p>}
      {t.commentList.map((c) => (
        <div key={c.id} className="text-sm border-t border-slate-100 pt-2 first:border-0 first:pt-0">
          <div className="text-[11px] text-slate-500">{c.author ?? "—"} · {fmtDT(c.createdAt)}</div>
          <div className="whitespace-pre-wrap">{c.content}</div>
          {c.image && <button onClick={() => setPhoto(`${base}/media/${c.id}`)} className="mt-1"><img src={`${base}/media/${c.id}`} alt="prova" className="rounded-xl max-h-56 object-cover" /></button>}
        </div>
      ))}
      {canEdit && <>
        <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} placeholder="Comentário ou recado…" className="w-full rounded-xl border border-slate-300 p-2 text-sm" />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="w-4 h-4" /> Avisar o responsável no WhatsApp</label>
        <button disabled={busy || !comment.trim()} onClick={async () => { await run(() => api(`${base}/task/${id}/comment`, { method: "POST", body: JSON.stringify({ text: comment, notify }) })); setComment(""); }}
          className="w-full rounded-xl py-2.5 text-sm font-semibold bg-slate-900 text-white disabled:opacity-40">{notify ? "💬 Comentar e avisar" : "💬 Comentar"}</button>
      </>}
    </div>

    {canEdit && <button disabled={busy} onClick={() => run(async () => { const r = await api<{ message: string }>(`${base}/task/${id}/archive`, { method: "POST" }); onClose?.(); return r; })} className="w-full text-sm text-red-600 py-2">🗑️ Arquivar tarefa</button>}

    {photo && <div className="fixed inset-0 z-[70] bg-black/85 flex items-center justify-center p-4" onClick={() => setPhoto(null)}><img src={photo} alt="prova" className="max-h-[90vh] max-w-full rounded-xl" /></div>}
  </>);
}
