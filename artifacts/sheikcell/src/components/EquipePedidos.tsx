// Tela "Equipe" (pedido do Samuel, 29/10/2026): "o chat interno está muito
// ruim — faça o mesmo [do quadro do atendimento] com o chat interno e junta
// ele com as tarefas". Protótipo aprovado: chat interno + pedidos no mesmo
// lugar.
//
// Pedido = tarefa do quadro de sempre (/api/tasks — no CRM ou no ERP Prumo,
// a rota cuida). Colunas, sozinhas pelo estado da tarefa:
//   Novos (a fazer) · Fazendo · Esperando alguém (fazendo + "esperando quem",
//   guardado no CRM) · Feito hoje.
// A conversa do pedido são os comentários da tarefa. "Concluir" escreve
// "Concluído" na conversa, e o aviso de comentário novo chega para quem pediu.
// Regras puras (leitura do "@nome … até 16h", prazos, colunas) em
// lib/equipePedidos.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Task, type TaskComment } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import {
  columnOf, dueBadge, formatDue, inScope, linkOf, parsePedido, scopeCounts, sortPedidos, whoText,
  type DueTone, type Pessoa, type PedidoCol, type Scope,
} from "@/lib/equipePedidos";
import { AlertTriangle, ArrowRightLeft, CheckCircle2, Hourglass, Loader2, MessageSquare, Play, RotateCcw, Send, SquareKanban, X } from "lucide-react";

export const COLS: { id: PedidoCol; label: string; help: string; color: string }[] = [
  { id: "novo", label: "Novos", help: "Pedidos que chegaram e ninguém começou.", color: "#dc2626" },
  { id: "fazendo", label: "Fazendo", help: "Quem é o responsável já começou.", color: "#2563eb" },
  { id: "esperando", label: "Esperando alguém", help: "Parado por outra pessoa ou fornecedor (diz quem).", color: "#d97706" },
  { id: "feito", label: "Feito hoje", help: "Quem pediu é avisado na hora.", color: "#16a34a" },
];
const COL_LABEL: Record<PedidoCol, string> = { novo: "Novos", fazendo: "Fazendo", esperando: "Esperando alguém", feito: "Feito hoje" };

const toneCls: Record<DueTone, string> = {
  late: "bg-red-600 text-white",
  soon: "bg-amber-200 text-amber-950",
  normal: "bg-[#F4F4F5] text-[#3F3F46]",
  done: "bg-green-100 text-green-900",
  none: "bg-[#F4F4F5] text-[#52525B]",
};

/** Relógio que anda a cada 30 s (selos de prazo e "sem resposta"). */
export function useNow(stepMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), stepMs);
    return () => clearInterval(t);
  }, [stepMs]);
  return now;
}

/** Tela larga o bastante para o pedido aberto ficar ao lado (senão, tela cheia). */
export function useWide(query = "(min-width: 1280px)"): boolean {
  const get = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [wide, setWide] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return wide;
}

// ─── Dados ──────────────────────────────────────────────────────────────────

export function usePedidos(enabled = true, everyMs = 30_000) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [unread, setUnread] = useState<Set<number>>(new Set());

  const reload = useCallback(async () => {
    try {
      const list = await api.tasks.list();
      setTasks(list);
      setBlocked(null);
    } catch (err) {
      // Só mostra o erro se ainda não há nada na tela (falha passageira não apaga o quadro).
      setBlocked(err instanceof Error && err.message ? err.message : "Não deu para carregar os pedidos agora.");
    } finally {
      setLoading(false);
    }
    api.tasks.notifications.unread().then((r) => setUnread(new Set(r.taskIds))).catch(() => {});
  }, []);

  useEffect(() => {
    if (!enabled) { setLoading(false); return; }
    void reload();
    // Com as tarefas no ERP, cada consulta vai até lá: só consulta com a aba visível.
    const t = setInterval(() => { if (document.visibilityState === "visible") void reload(); }, everyMs);
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [reload, enabled, everyMs]);

  const patchLocal = useCallback((t: Task) => setTasks((prev) => prev.some((x) => x.id === t.id) ? prev.map((x) => (x.id === t.id ? { ...x, ...t } : x)) : [t, ...prev]), []);
  const markRead = useCallback((id: number) => {
    setUnread((prev) => { if (!prev.has(id)) return prev; const n = new Set(prev); n.delete(id); return n; });
    api.tasks.notifications.markRead(id).catch(() => {});
  }, []);

  return { tasks, loading, blocked, unread, reload, patchLocal, markRead };
}

// ─── Pedir algo para alguém ─────────────────────────────────────────────────

export function PedirBox({ people, meId, compact = false, onCreated }: {
  people: Pessoa[]; meId: number; compact?: boolean; onCreated: (t: Task, assigneeId: number) => void;
}) {
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [pick, setPick] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const now = useNow(60_000);
  const lido = useMemo(() => parsePedido(text, people, now), [text, people, now]);
  const needsPick = lido.unknownMention || lido.candidates.length > 1;
  useEffect(() => { setPick(""); }, [lido.mention]);

  const target: Pessoa | null = pick
    ? people.find((p) => String(p.id) === pick) ?? null
    : lido.assignee ?? (lido.mention ? null : people.find((p) => p.id === meId) ?? null);
  const options = lido.candidates.length > 1 ? lido.candidates : people;

  const create = async () => {
    if (saving) return;
    if (!lido.title) { toast({ title: "Escreva o que você precisa", variant: "destructive" }); return; }
    if (!target) { toast({ title: "Escolha para quem é o pedido", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const t = await api.tasks.create({
        title: lido.title,
        description: text.trim(),
        assigneeIds: [target.id],
        dueDate: lido.due ? lido.due.toISOString() : null,
      });
      setText("");
      setPick("");
      toast({ title: target.id === meId ? "Pedido criado para você" : `Pedido enviado para ${target.name}` });
      onCreated(t, target.id);
    } catch (err) {
      toast({ title: "Não deu para criar o pedido", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`bg-white border border-border rounded-xl ${compact ? "p-2.5" : "px-4 py-3"} flex flex-col gap-2`} data-testid="pedir-box">
      <label htmlFor="pedir-input" className="text-[13px] font-semibold">Pedir algo para alguém</label>
      <div className="flex flex-wrap gap-2">
        <input
          id="pedir-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void create(); } }}
          placeholder="Ex.: @Lucélia separar 2 telas A15 para o Jorge até 16h"
          data-testid="input-pedir"
          className="flex-[1_1_260px] min-w-0 h-11 rounded-lg border border-[#D4D4D8] px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        <button type="button" onClick={create} disabled={saving || !text.trim()} data-testid="button-criar-pedido"
          className="h-11 px-4 rounded-lg bg-foreground text-white text-sm font-bold disabled:opacity-40 inline-flex items-center gap-2">
          {saving && <Loader2 className="w-4 h-4 animate-spin" />} Criar pedido
        </button>
      </div>
      {text.trim() ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-[#3F3F46]" aria-live="polite" data-testid="pedir-preview">
          {needsPick ? (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1 font-semibold text-amber-900 bg-amber-100 rounded-md px-1.5 py-0.5">
                <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                {lido.unknownMention ? `Não achei "@${lido.mention}" na equipe.` : `Tem mais de um "${lido.mention}".`}
              </span>
              <label htmlFor="pedir-pick" className="font-semibold">Para quem?</label>
              <select id="pedir-pick" value={pick} onChange={(e) => setPick(e.target.value)} data-testid="select-pedir-para"
                className="h-10 rounded-lg border border-[#D4D4D8] px-2 text-sm bg-white">
                <option value="">Escolha…</option>
                {options.map((p) => <option key={p.id} value={String(p.id)}>{p.id === meId ? `${p.name} (você)` : p.name}</option>)}
              </select>
            </span>
          ) : (
            <span><strong>Para:</strong> {target ? (target.id === meId ? "você" : target.name) : "—"}
              {!lido.mention && <span className="text-[#71717A]"> (escreva @nome para pedir a outra pessoa)</span>}
            </span>
          )}
          <span><strong>Prazo:</strong> {lido.due ? formatDue(lido.due, now) : "sem prazo"}</span>
          {lido.title && <span className="min-w-0 truncate"><strong>Pedido:</strong> {lido.title}</span>}
        </div>
      ) : !compact && (
        <span className="text-xs text-[#52525B]">O sistema lê o @nome (quem vai fazer) e o "até 16h", "até amanhã", "até sexta" (prazo). Qualquer mensagem do chat também vira pedido com um clique.</span>
      )}
    </div>
  );
}

// ─── Filtros ────────────────────────────────────────────────────────────────

export function ScopeBar({ scope, setScope, tasks, meId, now }: {
  scope: Scope; setScope: (s: Scope) => void; tasks: Task[]; meId: number; now: Date;
}) {
  const counts = scopeCounts(tasks, meId, now);
  const items: [Scope, string][] = [["mim", "Para mim"], ["pedi", "Que eu pedi"], ["equipe", "Equipe toda"]];
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quais pedidos mostrar">
      {items.map(([id, label]) => (
        <button key={id} type="button" aria-pressed={scope === id} onClick={() => setScope(id)} data-testid={`pedidos-scope-${id}`}
          className={`h-10 px-3 rounded-full text-[13px] font-semibold ${scope === id ? "border-2 border-foreground bg-white text-foreground" : "border border-[#D4D4D8] bg-white text-[#3F3F46] hover:bg-[#F4F4F5]"}`}>
          {label} · {counts[id]}
        </button>
      ))}
    </div>
  );
}

// ─── Quadro ─────────────────────────────────────────────────────────────────

export function PedidosBoard({ tasks, scope, meId, now, selectedId, unread, onOpen, colHeight, fill = false }: {
  tasks: Task[]; scope: Scope; meId: number; now: Date; selectedId: number | null; unread: Set<number>;
  onOpen: (t: Task) => void;
  /** Altura fixa de cada coluna (celular / painel estreito). */
  colHeight?: string;
  /** Ocupa a altura que sobrar (tela larga). */
  fill?: boolean;
}) {
  const byCol = useMemo(() => {
    const m: Record<PedidoCol, Task[]> = { novo: [], fazendo: [], esperando: [], feito: [] };
    for (const t of tasks) {
      if (!inScope(t, scope, meId)) continue;
      const c = columnOf(t, now);
      if (c) m[c].push(t);
    }
    for (const k of Object.keys(m) as PedidoCol[]) {
      m[k].sort(k === "feito" ? (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) : sortPedidos);
    }
    return m;
  }, [tasks, scope, meId, now]);

  return (
    <div className={`min-w-0 overflow-x-auto pb-1 ${fill ? "flex-1 min-h-0 overflow-y-hidden" : ""}`} data-testid="pedidos-board">
      <div className={`grid gap-2.5 ${fill ? "h-full" : ""}`} style={{ gridTemplateColumns: "repeat(4, minmax(220px, 1fr))", minWidth: 900 }}>
        {COLS.map((col) => {
          const list = byCol[col.id];
          const late = col.id !== "feito" && list.some((t) => dueBadge(t.dueDate, now, false).tone === "late");
          return (
            <section key={col.id} aria-labelledby={`pedidos-col-${col.id}`} data-testid={`pedidos-col-${col.id}`}
              className="flex flex-col min-h-0 rounded-xl border border-border bg-[#FAFAFA]"
              style={{ borderTop: `4px solid ${col.color}`, height: colHeight }}>
              <div className="px-3 pt-2.5 pb-1 flex items-center gap-2">
                <h3 id={`pedidos-col-${col.id}`} className="text-sm font-bold">{col.label}</h3>
                <span className={`text-xs font-bold rounded-full px-2 py-0.5 ${late ? "bg-red-600 text-white" : "bg-[#E4E4E7] text-[#3F3F46]"}`}>{list.length}</span>
              </div>
              <p className="px-3 pb-2 text-xs text-[#52525B] leading-snug">{col.help}</p>
              <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 flex flex-col gap-2">
                {list.length === 0 && <p className="px-1 py-2 text-xs text-[#71717A]">Nada aqui.</p>}
                {list.map((t) => (
                  <PedidoCard key={t.id} t={t} meId={meId} now={now} active={t.id === selectedId} unread={unread.has(t.id)} onOpen={onOpen} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function PedidoCard({ t, meId, now, active, unread, onOpen }: { t: Task; meId: number; now: Date; active: boolean; unread: boolean; onOpen: (t: Task) => void }) {
  const badge = dueBadge(t.dueDate, now, t.status === "done");
  const link = linkOf(t);
  const msgs = t.commentCount ?? 0;
  const border = active ? "border-2 border-foreground" : badge.tone === "late" ? "border-2 border-red-500" : "border border-border";
  return (
    <button type="button" onClick={() => onOpen(t)} aria-current={active ? "true" : undefined} data-testid={`pedido-card-${t.id}`}
      className={`text-left bg-white rounded-lg p-2.5 flex flex-col gap-1.5 hover:shadow-sm transition-shadow ${border}`}>
      <span className="flex items-start gap-1.5 w-full">
        <strong className="text-sm leading-snug flex-1 min-w-0 break-words">{t.title}</strong>
        {unread && <span className="mt-1 w-2.5 h-2.5 rounded-full bg-[#16a34a] shrink-0" title="Mensagem nova" aria-label="Mensagem nova" />}
      </span>
      <span className="text-xs text-[#3F3F46]">
        {whoText(t, meId)}{t.waitingFor ? ` · esperando ${t.waitingFor}` : ""}
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        <span className={`text-[11px] font-bold rounded-md px-1.5 py-px ${toneCls[badge.tone]}`}>{badge.text}</span>
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#3F3F46] border border-[#E4E4E7] rounded-md px-1.5 py-px">
          <MessageSquare className="w-3 h-3" aria-hidden="true" />{msgs} {msgs === 1 ? "mensagem" : "mensagens"}
        </span>
        {link && <span className="text-[11px] font-semibold text-blue-900 bg-blue-100 rounded-md px-1.5 py-px">{link}</span>}
      </span>
    </button>
  );
}

// ─── Pedido aberto ──────────────────────────────────────────────────────────

type Mode = null | "esperando" | "passar";

export function PedidoPanel({ task, meId, people, onClose, onChanged, onOpenFull, onRead }: {
  task: Task; meId: number; people: Pessoa[];
  onClose: () => void; onChanged: (t: Task) => void; onOpenFull?: () => void; onRead: (id: number) => void;
}) {
  const { toast } = useToast();
  const now = useNow();
  const [comments, setComments] = useState<TaskComment[] | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>(null);
  const [waitWho, setWaitWho] = useState("");
  const [passTo, setPassTo] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const col = columnOf(task, now);
  const badge = dueBadge(task.dueDate, now, task.status === "done");
  const link = linkOf(task);

  const loadComments = useCallback(() => {
    api.tasks.comments(task.id).then(setComments).catch(() => setComments([]));
  }, [task.id]);

  useEffect(() => {
    setComments(null); setReply(""); setMode(null); setWaitWho(""); setPassTo("");
    loadComments();
    onRead(task.id);
    const t = setInterval(() => { if (document.visibilityState === "visible") loadComments(); }, 20_000);
    return () => clearInterval(t);
  }, [task.id, loadComments, onRead]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [comments]);

  const say = async (content: string) => {
    const c = await api.tasks.addComment(task.id, content);
    setComments((prev) => [...(prev ?? []), c]);
    onChanged({ ...task, commentCount: (task.commentCount ?? 0) + 1 });
  };

  const send = async () => {
    const text = reply.trim();
    if (!text || busy) return;
    setBusy(true);
    try { await say(text); setReply(""); }
    catch (err) { toast({ title: "Não deu para enviar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" }); }
    finally { setBusy(false); }
  };

  const act = async (data: Parameters<typeof api.tasks.update>[1], note?: string, ok?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await api.tasks.update(task.id, data);
      onChanged({ ...updated, commentCount: task.commentCount });
      setMode(null);
      if (note) {
        try {
          const c = await api.tasks.addComment(task.id, note);
          setComments((prev) => [...(prev ?? []), c]);
          onChanged({ ...updated, commentCount: (task.commentCount ?? 0) + 1 });
        } catch { /* o principal já foi */ }
      }
      if (ok) toast({ title: ok });
    } catch (err) {
      toast({ title: "Não deu para mudar o pedido", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const creator = task.createdBy;
  const firstText = task.description?.trim() || null;
  const passOptions = people.filter((p) => !task.assignees.some((a) => a.id === p.id));
  const waitSuggestions = ["Fornecedor", "Cliente", "Transportadora", ...people.filter((p) => p.id !== meId).map((p) => p.name)];

  const btn = "min-h-11 rounded-lg text-[13px] font-semibold px-3 inline-flex items-center justify-center gap-1.5 disabled:opacity-40";
  const plain = `${btn} border border-[#D4D4D8] bg-white text-foreground hover:bg-[#F4F4F5]`;
  const main = `${btn} bg-foreground text-white`;
  const green = `${btn} bg-[#16a34a] text-white hover:bg-[#15803d]`;

  return (
    <div className="flex flex-col h-full min-h-0 gap-3 p-4" data-testid="pedido-panel">
      <div className="flex items-start gap-2.5">
        <div className="flex-1 min-w-0 flex flex-col gap-1">
          <h2 className="text-base font-bold leading-snug break-words">{task.title}</h2>
          <span className="text-xs text-[#52525B]">{whoText(task, meId)} · {col ? COL_LABEL[col] : "Concluído"}{task.waitingFor ? ` (${task.waitingFor})` : ""}</span>
        </div>
        <button type="button" onClick={onClose} aria-label="Fechar pedido" data-testid="button-fechar-pedido"
          className="w-10 h-10 shrink-0 rounded-lg border border-border bg-white inline-flex items-center justify-center hover:bg-[#F4F4F5]">
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`text-xs font-bold rounded-md px-2 py-0.5 ${toneCls[badge.tone]}`}>{badge.text}</span>
        {task.dueDate && task.status !== "done" && <span className="text-xs text-[#52525B]">prazo {formatDue(new Date(task.dueDate), now)}</span>}
        {link && <span className="text-xs font-semibold text-blue-900 bg-blue-100 rounded-md px-2 py-0.5">{link}</span>}
      </div>

      <div className="flex-1 min-h-[160px] overflow-y-auto bg-[#F4F4F5] rounded-xl p-3 flex flex-col gap-2" aria-label="Conversa do pedido">
        {firstText && (
          <Bubble mine={creator?.id === meId} from={creator ? (creator.id === meId ? "Você" : creator.name) : "Pedido"} text={firstText} at={task.createdAt} />
        )}
        {comments == null && <span className="text-xs text-[#71717A] inline-flex items-center gap-1"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Carregando conversa…</span>}
        {comments?.map((c) => (
          <Bubble key={c.id} mine={c.authorId === meId} from={c.authorId === meId ? "Você" : (c.authorName ?? "Alguém")} text={c.content} at={c.createdAt}
            media={c.mediaUrl ? { url: c.mediaUrl, type: c.mediaType ?? "doc" } : null} />
        ))}
        {comments?.length === 0 && !firstText && <span className="text-xs text-[#71717A]">Ninguém escreveu ainda. Cada pedido tem a sua própria conversa.</span>}
        <div ref={endRef} />
      </div>

      <div className="flex gap-2">
        <label htmlFor="pedido-msg" className="sr-only">Mensagem neste pedido</label>
        <input id="pedido-msg" value={reply} onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder="Escrever neste pedido…" data-testid="input-pedido-msg"
          className="flex-1 min-w-0 h-11 rounded-lg border border-[#D4D4D8] px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
        <button type="button" onClick={send} disabled={busy || !reply.trim()} data-testid="button-enviar-pedido"
          className="h-11 px-3.5 rounded-lg bg-[#16a34a] text-white text-sm font-bold inline-flex items-center gap-1.5 disabled:opacity-40">
          <Send className="w-4 h-4" aria-hidden="true" /> Enviar
        </button>
      </div>

      {mode === "esperando" && (
        <form className="flex flex-col gap-2 border border-amber-300 bg-amber-50 rounded-xl p-3"
          onSubmit={(e) => { e.preventDefault(); const who = waitWho.trim() || "alguém"; void act({ status: "doing", waitingFor: who }, `⏸ Esperando ${who}`, `Pedido esperando ${who}`); }}>
          <label htmlFor="pedido-espera" className="text-[13px] font-semibold">Esperando quem?</label>
          <input id="pedido-espera" list="pedido-espera-sugestoes" value={waitWho} onChange={(e) => setWaitWho(e.target.value)} autoFocus
            placeholder="Ex.: Fornecedor, Cliente, Lucélia…" data-testid="input-esperando-quem"
            className="h-11 rounded-lg border border-[#D4D4D8] px-3 text-sm bg-white" />
          <datalist id="pedido-espera-sugestoes">{waitSuggestions.map((s) => <option key={s} value={s} />)}</datalist>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className={plain} onClick={() => setMode(null)}>Cancelar</button>
            <button type="submit" className={main} disabled={busy} data-testid="button-confirmar-esperando">Confirmar</button>
          </div>
        </form>
      )}
      {mode === "passar" && (
        <form className="flex flex-col gap-2 border border-border bg-white rounded-xl p-3"
          onSubmit={(e) => {
            e.preventDefault();
            const p = people.find((x) => String(x.id) === passTo);
            if (!p) return;
            void act({ assigneeIds: [p.id], status: "todo", waitingFor: null }, `↪ Passou para ${p.id === meId ? "você" : p.name}`, `Pedido passado para ${p.name}`);
          }}>
          <label htmlFor="pedido-passar" className="text-[13px] font-semibold">Passar para quem?</label>
          <select id="pedido-passar" value={passTo} onChange={(e) => setPassTo(e.target.value)} data-testid="select-passar-para"
            className="h-11 rounded-lg border border-[#D4D4D8] px-2 text-sm bg-white">
            <option value="">Escolha…</option>
            {passOptions.map((p) => <option key={p.id} value={String(p.id)}>{p.id === meId ? `${p.name} (você)` : p.name}</option>)}
          </select>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className={plain} onClick={() => setMode(null)}>Cancelar</button>
            <button type="submit" className={main} disabled={busy || !passTo} data-testid="button-confirmar-passar">Passar</button>
          </div>
        </form>
      )}

      {mode == null && (
        <div className="grid grid-cols-2 gap-2" data-testid="pedido-acoes">
          {col === "novo" && (
            <button type="button" className={main} disabled={busy} onClick={() => act({ status: "doing" }, undefined, "Pedido em andamento")} data-testid="button-comecar">
              <Play className="w-4 h-4" aria-hidden="true" /> Começar
            </button>
          )}
          {(col === "novo" || col === "fazendo") && (
            <button type="button" className={plain} disabled={busy} onClick={() => setMode("esperando")} data-testid="button-esperando">
              <Hourglass className="w-4 h-4" aria-hidden="true" /> Esperando alguém
            </button>
          )}
          {col === "esperando" && (
            <button type="button" className={main} disabled={busy} onClick={() => act({ status: "doing", waitingFor: null }, "▶ Voltou a fazer", "Pedido voltou para Fazendo")} data-testid="button-voltar-fazer">
              <Play className="w-4 h-4" aria-hidden="true" /> Voltar a fazer
            </button>
          )}
          {task.status !== "done" && (
            <button type="button" className={green} disabled={busy} onClick={() => act({ status: "done" }, "✔ Concluído", creator && creator.id !== meId ? `Concluído — ${creator.name} foi avisado(a)` : "Concluído")} data-testid="button-concluir">
              <CheckCircle2 className="w-4 h-4" aria-hidden="true" /> Concluir
            </button>
          )}
          {task.status !== "done" && (
            <button type="button" className={plain} disabled={busy} onClick={() => setMode("passar")} data-testid="button-passar">
              <ArrowRightLeft className="w-4 h-4" aria-hidden="true" /> Passar para outra pessoa
            </button>
          )}
          {task.status === "done" && (
            <button type="button" className={plain} disabled={busy} onClick={() => act({ status: "todo" }, "↺ Reaberto", "Pedido reaberto")} data-testid="button-reabrir">
              <RotateCcw className="w-4 h-4" aria-hidden="true" /> Reabrir
            </button>
          )}
          {onOpenFull && (
            <button type="button" className={`${plain} col-span-2 text-[#3F3F46]`} onClick={onOpenFull} data-testid="button-quadro-completo">
              <SquareKanban className="w-4 h-4" aria-hidden="true" /> Editar no quadro completo (subtarefas, agenda)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Bubble({ mine, from, text, at, media }: { mine: boolean; from: string; text: string; at: string; media?: { url: string; type: string } | null }) {
  const time = new Date(at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  return (
    <div className={`max-w-[88%] px-2.5 py-2 rounded-lg text-sm flex flex-col gap-0.5 ${mine ? "self-end bg-green-100" : "self-start bg-white"}`}>
      <span className="text-[11px] font-bold text-[#3F3F46]">{from} <span className="font-normal text-[#71717A]">· {time}</span></span>
      {media && (media.type === "image"
        ? <a href={media.url} target="_blank" rel="noreferrer"><img src={media.url} alt="Anexo do pedido" className="max-h-40 rounded-md" /></a>
        : <a href={media.url} target="_blank" rel="noreferrer" className="text-xs underline">Abrir anexo</a>)}
      {text && <span className="whitespace-pre-wrap break-words">{text}</span>}
    </div>
  );
}
