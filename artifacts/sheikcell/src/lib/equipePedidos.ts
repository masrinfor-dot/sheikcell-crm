// Tela "Equipe" (chat interno + pedidos, 29/10/2026) — regras puras, sem
// React nem API, testadas em artifacts/api-server/src/lib/equipePedidos.test.ts
// (este arquivo não pode importar nada, para o teste do servidor conseguir
// carregá-lo).
//
// "Pedir algo para alguém": o texto "@Lucélia separar 2 telas A15 para o
// Jorge até 16h" vira um pedido — responsável lido do @nome, prazo do
// "até 16h" / "até amanhã 10h" / "até sexta", e o resto é o título.
// Horário sempre de Brasília (UTC−3, sem horário de verão desde 2019).

export type Pessoa = { id: number; name: string };

export type PedidoLido = {
  /** Texto do pedido, sem o @nome e sem o "até …". */
  title: string;
  /** O que veio depois do @, como digitado (null = não marcou ninguém). */
  mention: string | null;
  /** Quem vai fazer (null = ninguém achado ou mais de um com o mesmo nome). */
  assignee: Pessoa | null;
  /** Mais de uma pessoa com esse nome: a tela pede para escolher. */
  candidates: Pessoa[];
  /** Marcou um @nome que não existe na equipe: a tela avisa e deixa escolher. */
  unknownMention: boolean;
  due: Date | null;
};

const OFFSET_MS = -3 * 60 * 60 * 1000; // Brasília
const MIN = 60_000;
const DEFAULT_HOUR = 18; // "até amanhã" sem hora = fim do expediente

/** Sem acento e minúsculo (mesmo tamanho do texto original em NFC). */
export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ─── Relógio de Brasília ────────────────────────────────────────────────────

type Local = { y: number; mo: number; d: number; h: number; mi: number; dow: number };

function local(at: Date): Local {
  const t = new Date(at.getTime() + OFFSET_MS);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth(), d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), dow: t.getUTCDay() };
}

function at(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(Date.UTC(y, mo, d, h, mi) - OFFSET_MS);
}

export function sameLocalDay(a: Date, b: Date): boolean {
  const x = local(a), y = local(b);
  return x.y === y.y && x.mo === y.mo && x.d === y.d;
}

// ─── @nome ──────────────────────────────────────────────────────────────────

type MentionHit = { start: number; end: number; raw: string; assignee: Pessoa | null; candidates: Pessoa[] };

function findMention(text: string, people: Pessoa[]): MentionHit | null {
  const f = fold(text);
  const re = /(^|[^\p{L}\p{N}@])@([\p{L}\p{N}][\p{L}\p{N}._-]*)/gu;
  const m = re.exec(f);
  if (!m) return null;
  const start = m.index + m[1]!.length;
  const after = f.slice(start + 1);
  // 1) Nome completo (o mais comprido que bater): "@Ana Paula …"
  let best: { p: Pessoa; len: number }[] = [];
  for (const p of people) {
    const full = fold(p.name).trim().replace(/\s+/g, " ");
    if (!full || !full.includes(" ")) continue;
    if (new RegExp(`^${esc(full)}(?![\\p{L}\\p{N}])`, "u").test(after)) {
      if (!best.length || full.length > best[0]!.len) best = [{ p, len: full.length }];
      else if (full.length === best[0]!.len) best.push({ p, len: full.length });
    }
  }
  if (best.length) {
    const end = start + 1 + best[0]!.len;
    const raw = text.slice(start + 1, end);
    return best.length === 1
      ? { start, end, raw, assignee: best[0]!.p, candidates: [] }
      : { start, end, raw, assignee: null, candidates: best.map((b) => b.p) };
  }
  // 2) Uma palavra: primeiro nome (ou outro nome/sobrenome) igual.
  const token = m[2]!.replace(/[._-]+$/, "");
  const end = start + 1 + token.length;
  const raw = text.slice(start + 1, end);
  const byFirst = people.filter((p) => fold(p.name).trim().split(/\s+/)[0] === token);
  const byAny = byFirst.length ? byFirst : people.filter((p) => fold(p.name).trim().split(/\s+/).includes(token));
  if (byAny.length === 1) return { start, end, raw, assignee: byAny[0]!, candidates: [] };
  return { start, end, raw, assignee: null, candidates: byAny };
}

// ─── "até …" ────────────────────────────────────────────────────────────────

const WEEKDAYS = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"];
const DAY = `(hoje|amanha|depois de amanha|(?:${WEEKDAYS.join("|")})(?:-feira| feira)?|dia \\d{1,2}|\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?)`;
const TIME = `(?:(?:as|a)\\s+)?(?:(\\d{1,2})(?:h(\\d{2})?|:(\\d{2})|\\s*horas?)|(meio[- ]dia))`;
const DUE_RE = new RegExp(`(^|[\\s,])ate\\s+(?:(?:o|a)\\s+)?(?:${DAY}(?:\\s*,?\\s*${TIME})?|${TIME})(?=$|[\\s.,;!?)])`, "g");

type DueHit = { start: number; end: number; due: Date };

function buildDue(m: RegExpExecArray, now: Date): Date | null {
  const day = m[2] ?? null;
  const hRaw = m[3] ?? m[7] ?? null;
  const miRaw = m[4] ?? m[5] ?? m[8] ?? m[9] ?? null;
  const noon = m[6] ?? m[10] ?? null;
  let h: number | null = noon ? 12 : hRaw != null ? Number(hRaw) : null;
  const mi = noon ? 0 : miRaw != null ? Number(miRaw) : 0;
  if (h != null && (h > 23 || mi > 59)) return null;
  const n = local(now);
  if (!day) {
    // Só a hora: hoje; se já passou, amanhã.
    let d = at(n.y, n.mo, n.d, h!, mi);
    if (d.getTime() <= now.getTime()) d = at(n.y, n.mo, n.d + 1, h!, mi);
    return d;
  }
  const hh = h ?? DEFAULT_HOUR;
  if (day === "hoje") {
    const d = at(n.y, n.mo, n.d, hh, mi);
    return h == null && d.getTime() <= now.getTime() ? at(n.y, n.mo, n.d, 23, 59) : d;
  }
  if (day === "amanha") return at(n.y, n.mo, n.d + 1, hh, mi);
  if (day === "depois de amanha") return at(n.y, n.mo, n.d + 2, hh, mi);
  const wd = WEEKDAYS.indexOf(day.replace(/(-| )feira$/, ""));
  if (wd >= 0) {
    let ahead = (wd - n.dow + 7) % 7;
    let d = at(n.y, n.mo, n.d + ahead, hh, mi);
    if (d.getTime() <= now.getTime()) { ahead += 7; d = at(n.y, n.mo, n.d + ahead, hh, mi); }
    return d;
  }
  const dm = /^dia (\d{1,2})$/.exec(day);
  if (dm) {
    const dd = Number(dm[1]);
    if (dd < 1 || dd > 31) return null;
    let d = at(n.y, n.mo, dd, hh, mi);
    if (local(d).d !== dd) return null;
    if (d.getTime() <= now.getTime()) {
      d = at(n.y, n.mo + 1, dd, hh, mi);
      if (local(d).d !== dd) return null;
    }
    return d;
  }
  const sm = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(day);
  if (sm) {
    const dd = Number(sm[1]), mo = Number(sm[2]) - 1;
    let y = sm[3] ? Number(sm[3]) : n.y;
    if (y < 100) y += 2000;
    if (mo < 0 || mo > 11 || dd < 1 || dd > 31) return null;
    let d = at(y, mo, dd, hh, mi);
    if (local(d).d !== dd) return null;
    if (!sm[3] && d.getTime() < now.getTime() - 24 * 60 * MIN) d = at(y + 1, mo, dd, hh, mi);
    return d;
  }
  return null;
}

function findDue(text: string, now: Date): DueHit | null {
  const f = fold(text);
  DUE_RE.lastIndex = 0;
  let last: DueHit | null = null;
  let m: RegExpExecArray | null;
  while ((m = DUE_RE.exec(f))) {
    const due = buildDue(m, now);
    if (due) last = { start: m.index + m[1]!.length, end: m.index + m[0].length, due };
  }
  return last;
}

// ─── Leitura do pedido ──────────────────────────────────────────────────────

export function parsePedido(input: string, people: Pessoa[], now: Date = new Date()): PedidoLido {
  const text = input.normalize("NFC").replace(/\s+/g, " ").trim();
  const mention = findMention(text, people);
  const due = findDue(text, now);
  const cuts = [mention, due].filter((x): x is MentionHit | DueHit => x != null).sort((a, b) => b.start - a.start);
  let rest = text;
  for (const c of cuts) rest = rest.slice(0, c.start) + " " + rest.slice(c.end);
  let title = rest.replace(/\s+/g, " ").replace(/^[\s,:;–—-]+|[\s,;:–—-]+$/g, "").trim();
  if (title) title = title.charAt(0).toUpperCase() + title.slice(1);
  return {
    title: title.slice(0, 200),
    mention: mention ? mention.raw : null,
    assignee: mention?.assignee ?? null,
    candidates: mention && !mention.assignee ? mention.candidates : [],
    unknownMention: !!mention && !mention.assignee && mention.candidates.length === 0,
    due: due?.due ?? null,
  };
}

// ─── Textos de tempo ────────────────────────────────────────────────────────

/** "agora", "25 min", "2 h", "1 h 30 min", "3 dias". */
export function waitText(min: number): string {
  if (min < 1) return "agora";
  if (min < 60) return `${min} min`;
  if (min < 1440) { const h = Math.floor(min / 60), m = min % 60; return m ? `${h} h ${m} min` : `${h} h`; }
  const d = Math.floor(min / 1440);
  return `${d} dia${d > 1 ? "s" : ""}`;
}

const WD_SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "hoje 16:00", "amanhã 10:00", "sex 31/10 18:00". */
export function formatDue(due: Date, now: Date = new Date()): string {
  const d = local(due), n = local(now);
  const hm = `${pad(d.h)}:${pad(d.mi)}`;
  if (sameLocalDay(due, now)) return `hoje ${hm}`;
  if (sameLocalDay(due, new Date(now.getTime() + 1440 * MIN)) && due > now) return `amanhã ${hm}`;
  if (sameLocalDay(due, new Date(now.getTime() - 1440 * MIN)) && due < now) return `ontem ${hm}`;
  return `${WD_SHORT[d.dow]} ${pad(d.d)}/${pad(d.mo + 1)}${d.y !== n.y ? `/${d.y}` : ""} ${hm}`;
}

export type DueTone = "late" | "soon" | "normal" | "done" | "none";

/** Selo de prazo do card: vermelho atrasado, amarelo vence em até 60 min. */
export function dueBadge(dueIso: string | null, now: Date, done: boolean): { text: string; tone: DueTone } {
  if (done) return { text: "Concluído", tone: "done" };
  if (!dueIso) return { text: "Sem prazo", tone: "none" };
  const due = new Date(dueIso);
  if (Number.isNaN(due.getTime())) return { text: "Sem prazo", tone: "none" };
  const diff = Math.floor((due.getTime() - now.getTime()) / MIN);
  if (diff < 0) return { text: `Atrasado ${waitText(-diff)}`, tone: "late" };
  if (diff <= 60) return { text: diff < 1 ? "Vence agora" : `Vence em ${diff} min`, tone: "soon" };
  if (diff < 12 * 60 || sameLocalDay(due, now)) return { text: `Vence em ${waitText(diff)}`, tone: "normal" };
  return { text: `Vence ${formatDue(due, now)}`, tone: "normal" };
}

/** Selo da conversa: "sem resposta há 25 min" (a partir de 5 min). */
export function replyLateText(sinceIso: string | null | undefined, now: Date): { text: string; strong: boolean } | null {
  if (!sinceIso) return null;
  const min = Math.floor((now.getTime() - new Date(sinceIso).getTime()) / MIN);
  if (!Number.isFinite(min) || min < 5) return null;
  return { text: `sem resposta há ${waitText(min)}`, strong: min >= 30 };
}

// ─── Quadro de pedidos ──────────────────────────────────────────────────────

export type PedidoCol = "novo" | "fazendo" | "esperando" | "feito";

/** O mínimo de uma tarefa do quadro (/api/tasks) que estas regras usam. */
export type PedidoTask = {
  id: number;
  title: string;
  description: string | null;
  status: "todo" | "doing" | "done";
  dueDate: string | null;
  updatedAt: string;
  createdAt: string;
  createdBy: { id: number; name: string } | null;
  assignees: { id: number; name: string }[];
  contact: { id: number; name: string } | null;
  waitingFor?: string | null;
};

/** Em que coluna o pedido aparece (null = concluído antes de hoje, sai do quadro). */
export function columnOf(t: PedidoTask, now: Date): PedidoCol | null {
  if (t.status === "done") return sameLocalDay(new Date(t.updatedAt), now) ? "feito" : null;
  if (t.waitingFor) return "esperando";
  if (t.status === "doing") return "fazendo";
  return "novo";
}

export type Scope = "mim" | "pedi" | "equipe";

export function inScope(t: PedidoTask, scope: Scope, meId: number): boolean {
  if (scope === "equipe") return true;
  const mine = t.assignees.some((a) => a.id === meId);
  if (scope === "mim") return mine;
  return t.createdBy?.id === meId && !mine;
}

/** Contagem dos filtros (sem os já feitos), como no protótipo aprovado. */
export function scopeCounts(tasks: PedidoTask[], meId: number, now: Date): Record<Scope, number> {
  const open = tasks.filter((t) => { const c = columnOf(t, now); return c != null && c !== "feito"; });
  return {
    mim: open.filter((t) => inScope(t, "mim", meId)).length,
    pedi: open.filter((t) => inScope(t, "pedi", meId)).length,
    equipe: open.length,
  };
}

/** Ordem dentro da coluna: prazo mais perto primeiro; sem prazo no fim (mais novos antes). */
export function sortPedidos(a: PedidoTask, b: PedidoTask): number {
  const da = a.dueDate ? Date.parse(a.dueDate) : Infinity;
  const db = b.dueDate ? Date.parse(b.dueDate) : Infinity;
  if (da !== db) return da - db;
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

/** "Você pediu → Lucélia", "Gabriel pediu → você". */
export function whoText(t: PedidoTask, meId: number): string {
  const from = !t.createdBy ? "Alguém pediu" : t.createdBy.id === meId ? "Você pediu" : `${t.createdBy.name} pediu`;
  const to = t.assignees.length === 0 ? "ninguém ainda"
    : t.assignees.map((a) => (a.id === meId ? "você" : a.name)).join(", ");
  return `${from} → ${to}`;
}

/** Vínculo mostrado no card: cliente do atendimento ou número da OS citado. */
export function linkOf(t: PedidoTask): string | null {
  if (t.contact?.name) return `Atendimento: ${t.contact.name}`;
  const m = /(?:^|[^\p{L}])OS\s*(?:n[º°o.]?\s*)?#?\s*(\d{2,})/iu.exec(`${t.title}\n${t.description ?? ""}`);
  return m ? `OS #${m[1]}` : null;
}
