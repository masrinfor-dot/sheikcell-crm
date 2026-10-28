import { useState } from "react";

// Link da tarefa que o vendedor recebe no WhatsApp: botões grandes pra
// começar, tirar a foto e concluir, adiar pra amanhã ou mandar uma dúvida.
// Tudo volta pro dono pelo Gerente IA.

type Task = {
  id: number; title: string; description: string | null; status: string; priority: string; dueDate: string | null;
  commentList: { id: number; content: string; author: string | null; createdAt: string; image: boolean }[];
};

const fmt = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Reduz a foto pra no máx. 1280px (JPEG) antes de enviar — celular manda 4–8 MB. */
async function shrink(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
    const k = Math.min(1, 1280 / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.82);
  } finally { URL.revokeObjectURL(url); }
}

export default function GerenteSellerTask({ token, task: initial, sellerName }: { token: string; task: Task; sellerName: string }) {
  const base = `/api/gerente-public/${token}`;
  const [task, setTask] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"none" | "question">("none");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const done = task.status === "done";
  const late = !!task.dueDate && !done && new Date(task.dueDate).getTime() < Date.now();

  const post = async (path: string, body: unknown) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`${base}/task/${task.id}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
      setMsg((j.message ?? j.error ?? "Pronto.").replace(/\*/g, ""));
      const g = await fetch(base).then((x) => x.json()).catch(() => null) as { task?: Task } | null;
      if (g?.task) setTask(g.task);
      return r.ok;
    } finally { setBusy(false); }
  };
  const onPhoto = async (f: File | undefined) => {
    if (!f) return;
    const data = await shrink(f);
    setPreview(data);
    const ok = await post("proof", { imageBase64: data, mime: "image/jpeg", note: text.trim() || null });
    if (ok) setText("");
  };

  return (
    <div className="space-y-3">
      <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-2">
        <p className="text-xs text-slate-500">Olá, {sellerName.split(" ")[0]}! Sua tarefa:</p>
        <p className="text-lg font-bold leading-snug">#{task.id} · {task.title}{task.priority === "alta" ? " 🔴" : ""}</p>
        {task.description && <p className="text-sm text-slate-600 whitespace-pre-wrap">{task.description}</p>}
        <div className="flex flex-wrap gap-1.5 text-xs">
          {task.dueDate && <span className={`px-2 py-1 rounded-lg ${late ? "bg-red-100 text-red-700 font-semibold" : "bg-slate-100 text-slate-700"}`}>⏰ {late ? "Atrasada · " : ""}{fmt(task.dueDate)}</span>}
          <span className={`px-2 py-1 rounded-lg ${done ? "bg-green-100 text-green-800" : task.status === "doing" ? "bg-blue-100 text-blue-800" : "bg-slate-100 text-slate-700"}`}>{done ? "✅ Concluída" : task.status === "doing" ? "▶️ Em andamento" : "A fazer"}</span>
        </div>
      </div>

      {!done && (
        <div className="space-y-2">
          <label className={`block w-full text-center rounded-2xl py-4 text-base font-bold text-white bg-green-600 ${busy ? "opacity-50" : "cursor-pointer active:bg-green-700"}`}>
            📸 Tirar foto e concluir
            <input type="file" accept="image/*" capture="environment" className="hidden" disabled={busy} onChange={(e) => void onPhoto(e.target.files?.[0])} />
          </label>
          <div className="grid grid-cols-3 gap-2">
            <button disabled={busy || task.status === "doing"} onClick={() => void post("seller", { action: "doing" })} className="rounded-xl py-3 text-sm font-semibold bg-blue-600 text-white disabled:opacity-40">▶️ Comecei</button>
            <button disabled={busy} onClick={() => void post("seller", { action: "postpone" })} className="rounded-xl py-3 text-sm font-semibold bg-amber-500 text-white disabled:opacity-40">⏰ Adiar</button>
            <button disabled={busy} onClick={() => setMode(mode === "question" ? "none" : "question")} className="rounded-xl py-3 text-sm font-semibold bg-slate-800 text-white disabled:opacity-40">❓ Dúvida</button>
          </div>
          {mode === "question" && (
            <div className="bg-white rounded-2xl border border-slate-200 p-3 space-y-2">
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Escreva sua dúvida ou recado…" className="w-full rounded-xl border border-slate-300 p-2 text-sm" />
              <button disabled={busy || !text.trim()} onClick={async () => { if (await post("seller", { action: "question", text })) { setText(""); setMode("none"); } }} className="w-full rounded-xl py-2.5 text-sm font-semibold bg-slate-900 text-white disabled:opacity-40">Enviar</button>
            </div>
          )}
          <p className="text-[11px] text-slate-500 text-center">Também dá pra responder no WhatsApp: <b>1 {task.id}</b> terminei · <b>2 {task.id}</b> adiar · <b>3 {task.id}</b> dúvida</p>
        </div>
      )}

      {busy && <p className="text-sm text-slate-500 text-center">Enviando…</p>}
      {msg && <p className="text-sm bg-slate-900 text-white rounded-xl p-3 whitespace-pre-wrap">{msg}</p>}
      {preview && done && <img src={preview} alt="prova" className="rounded-xl max-h-64 mx-auto" />}

      {task.commentList.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-3 space-y-2">
          <h3 className="text-xs font-bold uppercase text-slate-500">Recados</h3>
          {task.commentList.map((c) => (
            <div key={c.id} className="text-sm border-t border-slate-100 pt-2 first:border-0 first:pt-0">
              <div className="text-[11px] text-slate-500">{c.author ?? "—"} · {fmt(c.createdAt)}</div>
              <div className="whitespace-pre-wrap">{c.content}</div>
              {c.image && <img src={`${base}/media/${c.id}`} alt="foto" className="mt-1 rounded-xl max-h-48" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
