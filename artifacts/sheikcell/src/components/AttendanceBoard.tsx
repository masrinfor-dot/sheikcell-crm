// Quadro de atendimento (pedido do Samuel, 29/10/2026): "um botão para
// transformar em Kanban — meus vendedores estão tendo muita dificuldade para
// manter a organização dos atendimentos, esquecendo de responder, demorando".
//
// Cada conversa cai SOZINHA na coluna certa pelas mesmas regras das abas
// (conversationReplyState.ts):
//   Fila (sem dono) · Responder agora · Aguardando cliente · Retomar depois ·
//   Finalizados hoje.
// "Responder agora" vem com quem espera há mais tempo no topo, com cor pelo
// tempo de espera (verde → amarelo na metade do prazo → vermelho quando
// estoura). O prazo pode ser por linha e a espera só conta com a loja aberta
// (fase 2). Arrastar um card também funciona: para "Aguardando cliente"
// (não precisa responder), "Retomar depois" (escolher a hora) ou "Finalizados"
// (motivo). Quem gerencia tem a visão "Equipe": uma linha por vendedor, com
// os números dele e "Passar atrasados para…".
import { useMemo, useState } from "react";
import type { Conversation } from "@/lib/api";
import { needsReply, snoozePending, snoozeLabel } from "@/lib/conversationReplyState";
import { AlarmClock, ArrowRight, CalendarClock, CheckCheck, Inbox, MessageCircleReply, Moon, Users } from "lucide-react";

export type BoardColumn = "fila" | "responder" | "aguardando" | "retomar" | "finalizados";

const TZ = "America/Sao_Paulo";
const dayKey = (t: number) => new Date(t).toLocaleDateString("en-CA", { timeZone: TZ });

/** Em que coluna do quadro a conversa aparece agora (null = fora do quadro). */
export function boardColumnOf(c: Conversation, now: number): BoardColumn | null {
  if (c.isArchived || c.status === "resolved" || c.status === "archived") {
    const t = Date.parse(c.updatedAt);
    return Number.isFinite(t) && dayKey(t) === dayKey(now) ? "finalizados" : null;
  }
  if (c.assigneeId == null) return "fila";
  if (needsReply(c, now)) return "responder";
  if (snoozePending(c, now)) return "retomar";
  return "aguardando";
}

export function waitText(min: number): string {
  if (min < 1) return "agora";
  if (min < 60) return `${min} min`;
  if (min < 1440) { const h = Math.floor(min / 60), m = min % 60; return m ? `${h} h ${m} min` : `${h} h`; }
  const d = Math.floor(min / 1440);
  return `${d} dia${d > 1 ? "s" : ""}`;
}

const isGroup = (c: Conversation) => c.phone.endsWith("@g.us");

function initials(name: string): string {
  const p = name.replace(/[^\p{L}\s]/gu, "").trim().split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "#";
}

const COLS: { id: BoardColumn; label: string; help: string; color: string }[] = [
  { id: "fila", label: "Fila (sem dono)", help: "Chegou e ninguém pegou ainda.", color: "#a1a1aa" },
  { id: "responder", label: "Responder agora", help: "O cliente falou por último. Quem espera mais está no topo.", color: "#dc2626" },
  { id: "aguardando", label: "Aguardando cliente", help: "Você respondeu. Volta sozinha quando o cliente escrever.", color: "#2563eb" },
  { id: "retomar", label: "Retomar depois", help: "Volta sozinha para Responder agora na hora marcada, com aviso.", color: "#d97706" },
  { id: "finalizados", label: "Finalizados hoje", help: "Atendimentos encerrados hoje.", color: "#16a34a" },
];
const DROPPABLE: BoardColumn[] = ["aguardando", "retomar", "finalizados"];

export type WaitInfo = { min: number | null; limit: number; paused: boolean };
export type TeamStat = { avgFirstResponseSec7d: number | null; avgFirstResponseSecToday: number | null; finalized7d: number; finalizedToday: number };

type Props = {
  convs: Conversation[];
  now: number;
  alertEnabled: boolean;
  /** Espera do cliente já com prazo da linha e horário da loja. */
  waitOf: (c: Conversation) => WaitInfo;
  wipLimit: number;
  meId: number | null;
  canSeeTeam: boolean;
  activeId: number | null;
  onOpen: (c: Conversation) => void;
  onDropTo: (c: Conversation, col: BoardColumn) => void;
  channelOf: (c: Conversation) => { label: string; color: string } | null;
  teamStats: Map<number, TeamStat>;
  transferTargets: { id: number; name: string }[];
  onTransfer: (convs: Conversation[], target: { id: number; name: string }) => Promise<void>;
};

type Card = {
  conv: Conversation;
  col: BoardColumn;
  waitMin: number | null;
  limit: number;
  paused: boolean;
  tone: "red" | "amber" | "green" | null;
};

export default function AttendanceBoard(props: Props) {
  const { convs, now, alertEnabled, waitOf, wipLimit, meId, canSeeTeam, activeId, onOpen, onDropTo, channelOf } = props;
  const [scope, setScope] = useState<"meus" | "todos" | "equipe">(canSeeTeam ? "todos" : "meus");
  const [dragId, setDragId] = useState<number | null>(null);
  const [overCol, setOverCol] = useState<BoardColumn | null>(null);

  const cards = useMemo<Card[]>(() => {
    const out: Card[] = [];
    for (const c of convs) {
      const col = boardColumnOf(c, now);
      if (!col) continue;
      let waitMin: number | null = null, limit = 0, paused = false;
      if (col === "responder" || col === "fila") {
        const w = waitOf(c);
        waitMin = w.min; limit = w.limit; paused = w.paused;
      }
      let tone: Card["tone"] = null;
      if (waitMin != null && !isGroup(c) && !paused) {
        if (alertEnabled && waitMin >= limit) tone = "red";
        else if (waitMin >= Math.max(1, Math.floor(limit / 2))) tone = "amber";
        else tone = "green";
      }
      out.push({ conv: c, col, waitMin, limit, paused, tone });
    }
    return out;
  }, [convs, now, alertEnabled, waitOf]);

  // "Só os meus": o que é do vendedor + a fila (de onde ele pega).
  const inScope = (k: Card) => scope !== "meus" || k.col === "fila" || k.conv.assigneeId === meId
    || (k.conv.participants ?? []).some((p) => p.id === meId);
  const scoped = cards.filter(inScope);

  const byCol = (id: BoardColumn): Card[] => {
    const list = scoped.filter((k) => k.col === id);
    if (id === "responder" || id === "fila") return list.sort((a, b) => (b.waitMin ?? -1) - (a.waitMin ?? -1));
    if (id === "retomar") return list.sort((a, b) => Date.parse(a.conv.snoozeUntil ?? "") - Date.parse(b.conv.snoozeUntil ?? ""));
    return list.sort((a, b) => Date.parse(b.conv.lastMessageAt ?? b.conv.updatedAt) - Date.parse(a.conv.lastMessageAt ?? a.conv.updatedAt));
  };

  const lateMine = scoped.filter((k) => k.col === "responder" && k.tone === "red" && (scope !== "meus" || k.conv.assigneeId === meId));
  const myResponder = cards.filter((k) => k.col === "responder" && k.conv.assigneeId === meId).length;
  const overWip = wipLimit > 0 && myResponder > wipLimit;
  const nextCard = (() => {
    const responder = byCol("responder");
    const mine = responder.filter((k) => k.conv.assigneeId === meId);
    return mine[0] ?? (scope !== "meus" ? responder[0] : undefined) ?? (overWip ? undefined : byCol("fila")[0]) ?? null;
  })();
  const dragging = dragId != null ? cards.find((k) => k.conv.id === dragId) ?? null : null;
  const canDropOn = (col: BoardColumn) => !!dragging && DROPPABLE.includes(col) && dragging.col !== col
    && dragging.col !== "finalizados" && dragging.conv.assigneeId != null;

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-3 p-3 overflow-hidden" data-testid="attendance-board">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-full border border-border bg-white p-0.5" role="group" aria-label="Quais atendimentos mostrar">
          {([["meus", "Só os meus"], ["todos", "Todos"], ...(canSeeTeam ? [["equipe", "Equipe (por vendedor)"]] : [])] as [typeof scope, string][]).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={scope === id} onClick={() => setScope(id)} data-testid={`board-scope-${id}`}
              className={`h-9 px-3 rounded-full text-xs font-semibold inline-flex items-center gap-1.5 ${scope === id ? "bg-foreground text-white" : "text-[#3F3F46] hover:bg-[#F4F4F5]"}`}>
              {id === "equipe" && <Users className="w-3.5 h-3.5" />}{label}
            </button>
          ))}
        </div>
        {lateMine.length > 0 && (
          <span role="status" data-testid="board-late-banner"
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-full bg-red-50 border border-red-200 text-red-800 text-xs font-bold">
            <AlarmClock className="w-3.5 h-3.5" />
            {lateMine.length} {lateMine.length === 1 ? "cliente esperando além do prazo" : "clientes esperando além do prazo"}
          </span>
        )}
        {overWip && (
          <span role="status" data-testid="board-wip-banner"
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-full bg-orange-50 border border-orange-300 text-orange-900 text-xs font-bold">
            Você tem {myResponder} para responder (limite {wipLimit}): responda antes de pegar da fila
          </span>
        )}
        <button type="button" disabled={!nextCard} onClick={() => nextCard && onOpen(nextCard.conv)} data-testid="board-next"
          title="Abre quem espera resposta há mais tempo"
          className="ml-auto h-10 px-4 rounded-xl bg-[#16a34a] text-white text-sm font-bold inline-flex items-center gap-2 disabled:opacity-40 hover:bg-[#15803d]">
          Próximo atendimento <ArrowRight className="w-4 h-4" />
        </button>
      </div>

      {scope === "equipe" ? (
        <TeamView {...props} cards={cards} />
      ) : (
        <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
          <div className="grid h-full gap-2.5" style={{ gridTemplateColumns: "repeat(5, minmax(210px, 1fr))", minWidth: 1080 }}>
            {COLS.map((col) => {
              const list = byCol(col.id);
              const late = col.id === "responder" && list.some((k) => k.tone === "red");
              const wipShown = col.id === "responder" && scope === "meus" && wipLimit > 0;
              const droppable = canDropOn(col.id);
              return (
                <section key={col.id} aria-labelledby={`board-col-${col.id}`} data-testid={`board-col-${col.id}`}
                  onDragOver={(e) => { if (droppable) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (overCol !== col.id) setOverCol(col.id); } }}
                  onDragLeave={() => { if (overCol === col.id) setOverCol(null); }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const k = dragging;
                    setDragId(null); setOverCol(null);
                    if (k && droppable) onDropTo(k.conv, col.id);
                  }}
                  className={`flex flex-col min-h-0 rounded-xl border bg-[#FAFAFA] transition-colors ${droppable ? (overCol === col.id ? "border-foreground bg-[#F1F5F9]" : "border-dashed border-[#A1A1AA]") : "border-border"}`}
                  style={{ borderTop: `4px solid ${col.color}` }}>
                  <div className="px-3 pt-2.5 pb-1.5 flex items-center gap-2">
                    <h3 id={`board-col-${col.id}`} className="text-[13px] font-bold">{col.label}</h3>
                    <span className={`text-[11px] font-bold rounded-full px-2 py-0.5 ${late ? "bg-red-600 text-white" : wipShown && list.filter((k) => k.conv.assigneeId === meId).length > wipLimit ? "bg-orange-500 text-white" : "bg-[#E4E4E7] text-[#3F3F46]"}`}>
                      {wipShown ? `${list.filter((k) => k.conv.assigneeId === meId).length}/${wipLimit}` : list.length}
                    </span>
                  </div>
                  <p className="px-3 pb-2 text-[11px] text-[#52525B] leading-snug">
                    {droppable ? (col.id === "aguardando" ? "Solte aqui: não precisa responder." : col.id === "retomar" ? "Solte aqui e escolha a hora." : "Solte aqui e escolha o motivo.") : col.help}
                  </p>
                  <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 flex flex-col gap-2">
                    {list.length === 0 && <p className="px-1 py-2 text-xs text-[#71717A]">Nada aqui.</p>}
                    {list.map((k) => (
                      <BoardCard key={k.conv.id} card={k} active={k.conv.id === activeId} onOpen={onOpen} ch={channelOf(k.conv)} now={now} showOwner={scope !== "meus"}
                        onDragStart={() => setDragId(k.conv.id)} onDragEnd={() => { setDragId(null); setOverCol(null); }} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function BoardCard({ card, active, onOpen, ch, now, showOwner, onDragStart, onDragEnd }: {
  card: Card; active: boolean; onOpen: (c: Conversation) => void; ch: { label: string; color: string } | null; now: number; showOwner: boolean;
  onDragStart: () => void; onDragEnd: () => void;
}) {
  const { conv: c, col, waitMin, tone, paused } = card;
  const toneCls = tone === "red" ? "bg-red-600 text-white" : tone === "amber" ? "bg-amber-200 text-amber-950" : "bg-green-100 text-green-900";
  const border = active ? "border-2 border-foreground" : tone === "red" ? "border-2 border-red-500" : tone === "amber" ? "border-2 border-amber-400" : "border border-border";
  const awaitingMin = col === "aguardando" && c.lastMessageAt ? Math.floor((now - Date.parse(c.lastMessageAt)) / 60000) : null;
  const snoozeDue = col === "responder" && c.snoozeUntil && c.snoozeSetAt && Date.parse(c.snoozeSetAt) >= Date.parse(c.lastMessageAt ?? "") && Date.parse(c.snoozeUntil) <= now;
  const preview = c.lastMessage ? (c.lastMessageDirection === "outbound" ? `Você: ${c.lastMessage}` : c.lastMessage) : "";
  const labels = c.labels ? c.labels.split(",").map((l) => l.trim()).filter(Boolean) : [];
  const draggable = col !== "finalizados" && c.assigneeId != null;
  return (
    <button type="button" onClick={() => onOpen(c)} data-testid={`board-card-${c.id}`} aria-current={active ? "true" : undefined}
      draggable={draggable}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(c.id)); onDragStart(); }}
      onDragEnd={onDragEnd}
      className={`text-left bg-white rounded-lg p-2.5 flex flex-col gap-1.5 hover:shadow-sm transition-shadow ${draggable ? "cursor-grab active:cursor-grabbing" : ""} ${border}`}>
      <span className="flex items-center gap-2 w-full min-w-0">
        {c.avatarUrl
          ? <img src={c.avatarUrl} alt="" className="w-7 h-7 rounded-full object-cover shrink-0" loading="lazy" draggable={false} />
          : <span aria-hidden="true" className="w-7 h-7 rounded-full bg-[#E4E4E7] text-[#3F3F46] text-[10px] font-bold inline-flex items-center justify-center shrink-0">{initials(c.name)}</span>}
        <strong className="text-[13px] flex-1 min-w-0 truncate">{c.name}</strong>
        {c.unreadCount > 0 && <span className="text-[10px] font-bold text-white bg-[#16a34a] rounded-full px-1.5 min-w-[18px] text-center">{c.unreadCount}</span>}
      </span>
      {preview && <span className="block text-xs text-[#3F3F46] truncate w-full">{preview}</span>}
      <span className="flex flex-wrap items-center gap-1">
        {ch && (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold border border-[#E4E4E7] rounded-md px-1.5 py-px">
            <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: ch.color }} />{ch.label}
          </span>
        )}
        {isGroup(c) && <span className="text-[10px] font-semibold border border-[#E4E4E7] rounded-md px-1.5 py-px">Grupo</span>}
        {labels.slice(0, 2).map((l) => <span key={l} className="text-[10px] font-semibold rounded-md px-1.5 py-px bg-violet-50 text-violet-900 border border-violet-200">{l}</span>)}
        {waitMin != null && tone && <span className={`text-[10px] font-bold rounded-md px-1.5 py-px ${toneCls}`}>esperando {waitText(waitMin)}</span>}
        {waitMin != null && paused && !isGroup(c) && <span className="inline-flex items-center gap-1 text-[10px] font-semibold rounded-md px-1.5 py-px bg-slate-100 text-slate-700"><Moon className="w-3 h-3" />loja fechada</span>}
        {snoozeDue && <span className="inline-flex items-center gap-1 text-[10px] font-bold rounded-md px-1.5 py-px bg-blue-100 text-blue-900"><CalendarClock className="w-3 h-3" />hora de retomar</span>}
        {col === "aguardando" && awaitingMin != null && (
          awaitingMin >= 1440
            ? <span className="inline-flex items-center gap-1 text-[10px] font-bold rounded-md px-1.5 py-px bg-blue-100 text-blue-900"><MessageCircleReply className="w-3 h-3" />cobrar retorno · {waitText(awaitingMin)}</span>
            : <span className="text-[10px] font-semibold rounded-md px-1.5 py-px bg-[#F4F4F5] text-[#3F3F46]">sem resposta há {waitText(awaitingMin)}</span>
        )}
        {col === "retomar" && <span className="inline-flex items-center gap-1 text-[10px] font-bold rounded-md px-1.5 py-px bg-amber-100 text-amber-950"><CalendarClock className="w-3 h-3" />volta {snoozeLabel(c.snoozeUntil, now)}</span>}
        {col === "fila" && c.status !== "pending" && <span className="text-[10px] font-semibold rounded-md px-1.5 py-px bg-violet-100 text-violet-900">número novo</span>}
        {col === "finalizados" && <span className="inline-flex items-center gap-1 text-[10px] font-semibold rounded-md px-1.5 py-px bg-green-100 text-green-900"><CheckCheck className="w-3 h-3" />finalizado</span>}
      </span>
      {showOwner && c.assignee && <span className="text-[11px] text-[#52525B] truncate w-full">Resp.: {c.assignee.name}</span>}
    </button>
  );
}

// ─── Equipe: uma linha por vendedor ──────────────────────────────────────
function fmtSec(s: number | null | undefined): string {
  if (s == null) return "—";
  if (s < 60) return `${Math.round(s)} s`;
  return waitText(Math.round(s / 60));
}

function TeamView({ cards, activeId, onOpen, channelOf, now, wipLimit, teamStats, transferTargets, onTransfer }: Props & { cards: Card[] }) {
  const [target, setTarget] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const sellers = useMemo(() => {
    const m = new Map<number, { id: number; name: string; cards: Card[] }>();
    for (const k of cards) {
      const a = k.conv.assignee;
      if (k.col === "fila" || !a) continue;
      if (!m.has(a.id)) m.set(a.id, { id: a.id, name: a.name, cards: [] });
      m.get(a.id)!.cards.push(k);
    }
    const late = (s: { cards: Card[] }) => s.cards.filter((k) => k.col === "responder" && k.tone === "red").length;
    return [...m.values()].sort((a, b) => late(b) - late(a) || b.cards.filter((k) => k.col === "responder").length - a.cards.filter((k) => k.col === "responder").length || a.name.localeCompare(b.name, "pt-BR"));
  }, [cards]);
  const fila = cards.filter((k) => k.col === "fila").sort((a, b) => (b.waitMin ?? -1) - (a.waitMin ?? -1));
  const cols: BoardColumn[] = ["responder", "aguardando", "retomar", "finalizados"];

  const chip = (k: Card) => {
    const tone = k.tone === "red" ? "bg-red-600 text-white border-red-600" : k.tone === "amber" ? "bg-amber-100 text-amber-950 border-amber-300" : "bg-white text-[#27272A] border-[#E4E4E7]";
    const extra = k.waitMin != null && k.tone ? ` · ${waitText(k.waitMin)}` : k.col === "retomar" ? ` · ${snoozeLabel(k.conv.snoozeUntil, now)}` : "";
    const ch = channelOf(k.conv);
    return (
      <button key={k.conv.id} type="button" onClick={() => onOpen(k.conv)} data-testid={`team-chip-${k.conv.id}`}
        className={`max-w-full inline-flex items-center gap-1 h-7 px-2 rounded-md border text-[11px] font-semibold ${tone} ${k.conv.id === activeId ? "ring-2 ring-foreground" : ""}`}>
        {ch && <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: ch.color }} />}
        <span className="truncate">{k.conv.name}{extra}</span>
      </button>
    );
  };
  const cell = (list: Card[]) => {
    const shown = list.slice(0, 6);
    return (
      <div className="flex flex-wrap gap-1">
        {shown.map(chip)}
        {list.length > shown.length && <span className="text-[11px] text-[#52525B] self-center">+{list.length - shown.length}</span>}
        {list.length === 0 && <span className="text-[11px] text-[#A1A1AA]">—</span>}
      </div>
    );
  };
  const sort = (col: BoardColumn, list: Card[]) => col === "responder" ? list.sort((a, b) => (b.waitMin ?? -1) - (a.waitMin ?? -1)) : list;

  return (
    <div className="flex-1 min-h-0 overflow-auto rounded-xl border border-border bg-white" data-testid="board-team">
      <table className="w-full border-collapse text-sm min-w-[1100px]">
        <thead className="sticky top-0 bg-white z-10">
          <tr className="text-left text-[#52525B] text-xs">
            <th scope="col" className="px-3 py-2.5 font-semibold w-52">Vendedor</th>
            {cols.map((c) => <th key={c} scope="col" className="px-3 py-2.5 font-semibold">{COLS.find((x) => x.id === c)!.label}</th>)}
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-[#F4F4F5] bg-[#FAFAFA] align-top">
            <th scope="row" className="px-3 py-2.5 text-left">
              <span className="inline-flex items-center gap-1.5 font-bold"><Inbox className="w-4 h-4" />Fila (sem dono)</span>
              <span className="block text-[11px] font-normal text-[#52525B]">{fila.length} esperando alguém pegar</span>
            </th>
            <td colSpan={4} className="px-3 py-2.5">{cell(fila)}</td>
          </tr>
          {sellers.map((s) => {
            const lateCards = s.cards.filter((k) => k.col === "responder" && k.tone === "red");
            const responder = s.cards.filter((k) => k.col === "responder").length;
            const over = wipLimit > 0 && responder > wipLimit;
            const st = teamStats.get(s.id);
            const options = transferTargets.filter((u) => u.id !== s.id);
            const chosen = target[s.id] ?? String(options[0]?.id ?? "");
            return (
              <tr key={s.id} className={`border-t border-[#F4F4F5] align-top ${lateCards.length ? "bg-red-50/40" : ""}`} data-testid={`team-row-${s.id}`}>
                <th scope="row" className="px-3 py-2.5 text-left font-normal">
                  <span className="block font-bold">{s.name}</span>
                  <span className="flex flex-wrap gap-1 mt-0.5">
                    {lateCards.length > 0
                      ? <span className="text-[11px] font-bold text-white bg-red-600 rounded-full px-2">{lateCards.length} atrasado{lateCards.length > 1 ? "s" : ""}</span>
                      : <span className="text-[11px] font-semibold text-green-700">em dia</span>}
                    {over && <span className="text-[11px] font-bold text-white bg-orange-500 rounded-full px-2">{responder}/{wipLimit} acima do limite</span>}
                  </span>
                  <span className="block text-[11px] text-[#52525B] mt-1" title="Tempo médio até a 1ª resposta nos atendimentos finalizados">
                    1ª resposta: hoje {fmtSec(st?.avgFirstResponseSecToday)} · 7 dias {fmtSec(st?.avgFirstResponseSec7d)}
                  </span>
                  <span className="block text-[11px] text-[#52525B]">Finalizados: hoje {st?.finalizedToday ?? 0} · 7 dias {st?.finalized7d ?? 0}</span>
                  {lateCards.length > 0 && options.length > 0 && (
                    <span className="flex items-center gap-1 mt-1.5">
                      <label className="sr-only" htmlFor={`pass-${s.id}`}>Passar atrasados de {s.name} para</label>
                      <select id={`pass-${s.id}`} value={chosen} onChange={(e) => setTarget((t) => ({ ...t, [s.id]: e.target.value }))}
                        className="h-8 max-w-[120px] px-1.5 rounded-md border border-border bg-white text-[11px]">
                        {options.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                      </select>
                      <button type="button" disabled={busy === s.id || !chosen} data-testid={`team-pass-${s.id}`}
                        onClick={async () => {
                          const t = options.find((u) => String(u.id) === chosen);
                          if (!t) return;
                          setBusy(s.id);
                          try { await onTransfer(lateCards.map((k) => k.conv), t); } finally { setBusy(null); }
                        }}
                        className="h-8 px-2 rounded-md bg-foreground text-white text-[11px] font-semibold disabled:opacity-40">
                        {busy === s.id ? "Passando…" : "Passar atrasados"}
                      </button>
                    </span>
                  )}
                </th>
                {cols.map((c) => <td key={c} className="px-3 py-2.5">{cell(sort(c, s.cards.filter((k) => k.col === c)))}</td>)}
              </tr>
            );
          })}
          {sellers.length === 0 && (
            <tr><td colSpan={5} className="px-3 py-6 text-center text-sm text-[#52525B]">Nenhum atendimento com vendedor neste canal.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
