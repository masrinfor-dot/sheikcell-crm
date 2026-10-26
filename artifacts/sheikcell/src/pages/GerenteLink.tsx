import { useEffect, useState } from "react";
import { useParams } from "wouter";
import GerenteTasks, { TaskSheet } from "@/components/GerenteTasks";

// Página do link seguro do Gerente IA (/g/:token): abre no celular sem login.
// Link "dia" → gerenciador completo de tarefas (o mesmo do painel).
// Link de uma tarefa → a ficha dela. Só o link do dono edita.

type Head = { scope: "dia" | "task"; canEdit: boolean; task?: { id: number }; team?: { id: number; name: string; isOwner?: boolean }[]; categories?: string[]; today?: string };

export default function GerenteLink() {
  const { token } = useParams<{ token: string }>();
  const [head, setHead] = useState<Head | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/gerente-public/${token}`).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j as { error?: string }).error ?? "Link inválido.");
      setHead(j as Head);
    }).catch((e: Error) => setError(e.message));
  }, [token]);

  return (
    <div className="min-h-screen bg-slate-100 px-3 py-4">
      <div className="max-w-2xl mx-auto space-y-3">
        <header className="flex items-center justify-between">
          <h1 className="font-bold text-lg">📋 Gerente IA · Tarefas</h1>
          {head && !head.canEdit && <span className="text-[11px] text-slate-500">só leitura</span>}
        </header>
        {error && <div className="bg-white rounded-2xl p-4 text-sm text-red-700">{error}<p className="text-xs text-slate-500 mt-1">Peça um novo no WhatsApp: <b>link</b>.</p></div>}
        {!head && !error && <p className="text-sm text-slate-500">Carregando…</p>}
        {head?.scope === "dia" && <GerenteTasks token={token} />}
        {head?.scope === "task" && head.task && (
          <TaskSheet inline base={`/api/gerente-public/${token}`} id={head.task.id} canEdit={head.canEdit} team={head.team ?? []}
            categories={head.categories ?? []} today={head.today ?? new Date().toISOString().slice(0, 10)}
            onChanged={(m) => { if (m) { setToast(m.replace(/\*/g, "")); setTimeout(() => setToast(null), 5000); } }} />
        )}
        <p className="text-[10px] text-center text-slate-400">Peça um link novo no WhatsApp a qualquer momento: <b>link</b>.</p>
      </div>
      {toast && <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] max-w-[92vw] bg-slate-900 text-white text-sm rounded-xl px-4 py-2.5 shadow-lg whitespace-pre-wrap">{toast}</div>}
    </div>
  );
}
