import { useEffect, useState } from "react";
import { useParams } from "wouter";

// Página do link seguro do Gerente IA (/g/:token): abre no celular sem login,
// só leitura. Mostra o dia do dono (agenda, lembretes, contas, tarefas da
// equipe, provas recentes) ou uma tarefa com os comentários e a foto da prova.

type Task = {
  id: number; title: string; description: string | null; status: string; priority: string; dueDate: string | null; isArchived: boolean;
  assignees: string[]; whatsapp: { status: string; doneAt: string | null } | null;
  comments: { id: number; content: string; author: string | null; createdAt: string; image: boolean }[];
};
type Dia = {
  scope: "dia"; today: string;
  events: { id: number; title: string; startsAt: string; location: string | null }[];
  reminders: { id: number; title: string; dueAt: string; urgent: boolean }[];
  bills: { id: number; kind: string; description: string; amountCents: number; dueDate: string }[];
  tasks: { id: number; title: string; dueDate: string | null; status: string; assignees: string[] }[];
  recentDone: { taskId: number; title: string; who: string; doneAt: string }[];
};
type Data = Dia | { scope: "task"; task: Task };

const fmtDT = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const fmtT = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
const fmtD = (d: string) => { const [, m, day] = d.slice(0, 10).split("-"); return `${day}/${m}`; };
const brl = (c: number) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const STATUS: Record<string, string> = { todo: "A fazer", doing: "Em andamento", done: "Concluída" };

export default function GerenteLink() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openTask, setOpenTask] = useState<Task | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/gerente-public/${token}`).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j as { error?: string }).error ?? "Link inválido.");
      setData(j as Data);
    }).catch((e: Error) => setError(e.message));
  }, [token]);

  const loadTask = async (id: number) => {
    const r = await fetch(`/api/gerente-public/${token}/task/${id}`);
    if (r.ok) setOpenTask(((await r.json()) as { task: Task }).task);
  };

  const Card = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4 space-y-2">
      <h2 className="font-bold text-sm text-slate-800">{title}</h2>
      {children}
    </section>
  );

  const TaskDetail = ({ t }: { t: Task }) => (
    <div className="space-y-3">
      <Card title={`Tarefa ${t.id}`}>
        <p className="text-base font-semibold">{t.title}</p>
        {t.description && <p className="text-sm text-slate-600 whitespace-pre-wrap">{t.description}</p>}
        <div className="text-xs text-slate-500 space-y-0.5">
          <div>Situação: <b>{t.isArchived ? "Cancelada" : STATUS[t.status] ?? t.status}</b>{t.priority === "alta" ? " · prioridade alta" : ""}</div>
          {t.dueDate && <div>Prazo: <b>{fmtDT(t.dueDate)}</b></div>}
          <div>Responsável: <b>{t.assignees.join(", ") || "—"}</b></div>
          {t.whatsapp && <div>WhatsApp: <b>{t.whatsapp.status === "concluida" ? `concluída ${t.whatsapp.doneAt ? fmtDT(t.whatsapp.doneAt) : ""}` : t.whatsapp.status === "aguardando_prova" ? "aguardando foto" : t.whatsapp.status}</b></div>}
        </div>
      </Card>
      <Card title="Comentários e provas">
        {t.comments.length === 0 && <p className="text-xs text-slate-500">Nada ainda.</p>}
        {t.comments.map((c) => (
          <div key={c.id} className="text-sm border-t border-slate-100 pt-2 first:border-0 first:pt-0">
            <div className="text-[11px] text-slate-500">{c.author ?? "—"} · {fmtDT(c.createdAt)}</div>
            <div>{c.content}</div>
            {c.image && (
              <button onClick={() => setPhoto(`/api/gerente-public/${token}/media/${c.id}`)} className="mt-1">
                <img src={`/api/gerente-public/${token}/media/${c.id}`} alt="prova" className="rounded-xl max-h-64 object-cover" />
              </button>
            )}
          </div>
        ))}
      </Card>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-5">
      <div className="max-w-lg mx-auto space-y-3">
        <header className="flex items-center justify-between">
          <h1 className="font-bold text-lg">Gerente IA</h1>
          {openTask && data?.scope === "dia" && <button onClick={() => setOpenTask(null)} className="text-sm text-blue-700">← Voltar</button>}
        </header>
        {error && <div className="bg-white rounded-2xl p-4 text-sm text-red-700">{error}</div>}
        {!data && !error && <p className="text-sm text-slate-500">Carregando…</p>}
        {data?.scope === "task" && <TaskDetail t={data.task} />}
        {data?.scope === "dia" && openTask && <TaskDetail t={openTask} />}
        {data?.scope === "dia" && !openTask && (
          <>
            <Card title="📅 Agenda (7 dias)">
              {data.events.length === 0 ? <p className="text-xs text-slate-500">Sem compromissos.</p> : data.events.map((e) => (
                <div key={e.id} className="text-sm flex gap-2"><span className="font-mono text-slate-500 w-20 shrink-0">{fmtDT(e.startsAt)}</span><span>{e.title}{e.location ? <span className="text-slate-500"> · {e.location}</span> : null}</span></div>
              ))}
            </Card>
            <Card title="⏰ Lembretes de hoje">
              {data.reminders.length === 0 ? <p className="text-xs text-slate-500">Nada pendente.</p> : data.reminders.map((r) => (
                <div key={r.id} className="text-sm flex gap-2"><span className="font-mono text-slate-500 w-12 shrink-0">{fmtT(r.dueAt)}</span><span>{r.title}{r.urgent ? " ‼️" : ""}</span></div>
              ))}
            </Card>
            <Card title="📋 Tarefas da equipe">
              {data.tasks.length === 0 ? <p className="text-xs text-slate-500">Nenhuma aberta.</p> : data.tasks.map((t) => (
                <button key={t.id} onClick={() => loadTask(t.id)} className="w-full text-left text-sm flex justify-between gap-2 py-1 border-t border-slate-100 first:border-0">
                  <span><b>{t.id}</b> · {t.title} <span className="text-slate-500">({t.assignees.join(", ") || "sem responsável"})</span></span>
                  <span className={`text-xs whitespace-nowrap ${t.dueDate && new Date(t.dueDate).getTime() < Date.now() ? "text-red-600 font-bold" : "text-slate-500"}`}>{t.dueDate ? fmtDT(t.dueDate) : ""}</span>
                </button>
              ))}
            </Card>
            {data.recentDone.length > 0 && (
              <Card title="📸 Concluídas com prova (2 dias)">
                {data.recentDone.map((d) => (
                  <button key={d.taskId} onClick={() => loadTask(d.taskId)} className="w-full text-left text-sm py-1">✅ {d.who.split(" ")[0]} — {d.title} <span className="text-slate-500">· {fmtDT(d.doneAt)}</span></button>
                ))}
              </Card>
            )}
            {data.bills.length > 0 && (
              <Card title="💳 Contas em aberto">
                {data.bills.map((b) => (
                  <div key={b.id} className={`text-sm flex justify-between ${b.dueDate < data.today ? "text-red-700" : ""}`}><span>{b.kind === "pagar" ? "📤" : "📥"} {b.description}</span><span>{brl(b.amountCents)} · {fmtD(b.dueDate)}</span></div>
                ))}
              </Card>
            )}
          </>
        )}
        <p className="text-[10px] text-center text-slate-400">Link só de leitura. Peça um novo no WhatsApp: <b>link</b>.</p>
      </div>
      {photo && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4" onClick={() => setPhoto(null)}>
          <img src={photo} alt="prova" className="max-h-[90vh] max-w-full rounded-xl" />
        </div>
      )}
    </div>
  );
}
