import { useEffect, useState } from "react";

// "Arrumar tarefas": mostra o plano (categoria + prazo novo) que o Gerente
// IA propõe e aplica só o que ficar marcado. Usado no link do celular e no
// painel — cada um passa as suas funções de carregar/aplicar.

export type OrganizeItem = { taskId: number; title: string; priority: string; category?: string | null; oldCategory?: string | null; dueAt?: string | null; oldDue?: string | null; reason?: string };

const fmt = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export default function OrganizeSheet({ load, apply, onClose, onDone }: {
  load: () => Promise<{ merged: number; items: OrganizeItem[] }>;
  apply: (items: OrganizeItem[]) => Promise<{ applied: number }>;
  onClose: () => void; onDone: (msg: string) => void;
}) {
  const [data, setData] = useState<{ merged: number; items: OrganizeItem[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [off, setOff] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => { load().then(setData).catch((e: Error) => setErr(e.message)); }, [load]);

  const chosen = data?.items.filter((i) => !off.has(i.taskId)) ?? [];
  const go = async () => {
    setBusy(true);
    try { const r = await apply(chosen); onDone(`✅ ${r.applied} tarefa(s) arrumada(s).${data?.merged ? ` ${data.merged} duplicada(s) juntadas.` : ""}`); onClose(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="bg-slate-50 text-slate-900 w-full sm:max-w-lg max-h-[92vh] flex flex-col rounded-t-3xl sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 pb-2 flex justify-between items-start gap-2">
          <div>
            <h3 className="font-bold">✨ Arrumar tarefas</h3>
            <p className="text-xs text-slate-500">Categoria pra quem não tem e prazo novo pras atrasadas ou sem prazo — no máximo 4 por dia, sem domingo. Desmarque o que não quiser.</p>
          </div>
          <button onClick={onClose} className="text-slate-500 text-sm px-2">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 space-y-1.5">
          {err && <p className="text-sm text-red-700">{err}</p>}
          {!data && !err && <p className="text-sm text-slate-500 py-6 text-center">Analisando as tarefas…</p>}
          {data && data.merged > 0 && <p className="text-xs bg-green-50 text-green-800 rounded-xl p-2">🧹 Já juntei {data.merged} tarefa(s) duplicada(s).</p>}
          {data && data.items.length === 0 && <p className="text-sm text-slate-500 py-6 text-center">Tudo organizado: todas têm categoria e prazo em dia. 👌</p>}
          {data?.items.map((i) => {
            const on = !off.has(i.taskId);
            return (
              <label key={i.taskId} className={`flex gap-2 items-start bg-white border rounded-xl p-2.5 ${on ? "border-slate-300" : "border-slate-200 opacity-50"}`}>
                <input type="checkbox" checked={on} onChange={() => setOff((s) => { const n = new Set(s); if (n.has(i.taskId)) n.delete(i.taskId); else n.add(i.taskId); return n; })} className="w-5 h-5 mt-0.5" />
                <div className="min-w-0 text-sm">
                  <div className="font-medium leading-snug"><span className="text-slate-400 text-xs">#{i.taskId}</span> {i.title}{i.priority === "alta" ? " 🔴" : ""}</div>
                  <div className="flex flex-wrap gap-1.5 mt-1 text-[11px]">
                    {i.category && <span className="px-1.5 py-0.5 rounded-md bg-indigo-50 text-indigo-700">📁 {i.category}</span>}
                    {i.dueAt && <span className="px-1.5 py-0.5 rounded-md bg-amber-50 text-amber-800">⏰ {i.oldDue ? <s className="text-slate-400 mr-1">{fmt(i.oldDue)}</s> : null}{fmt(i.dueAt)}</span>}
                    {i.reason && <span className="text-slate-500">{i.reason}</span>}
                  </div>
                </div>
              </label>
            );
          })}
        </div>
        <div className="p-4 pt-3 flex gap-2">
          <button onClick={onClose} className="flex-1 rounded-xl py-2.5 text-sm border border-slate-300 bg-white">Cancelar</button>
          <button onClick={go} disabled={busy || !chosen.length} className="flex-[2] rounded-xl py-2.5 text-sm font-semibold bg-slate-900 text-white disabled:opacity-40">{busy ? "Aplicando…" : `Aplicar ${chosen.length}`}</button>
        </div>
      </div>
    </div>
  );
}
