// Gerente IA — camada PURA (sem banco, sem rede): datas no fuso de São
// Paulo, dinheiro em BRL e o interpretador por regras em português.
//
// O interpretador por regras é o caminho sem custo: cobre as frases mais
// comuns do dia a dia (lembrete, gasto, receita, conta, tarefa, compromisso,
// consultas) e os comandos curtos ("feito", "adia 1h", "sim"). O que ele não
// entende vai pra IA (function-calling em gerente.ts). Se a IA não estiver
// disponível, o que as regras entendem continua funcionando.

export const SP_TZ = "America/Sao_Paulo";
// Brasil não tem horário de verão desde 2019 — o deslocamento é fixo.
const SP_OFFSET = "-03:00";

// ─── Datas ───────────────────────────────────────────────────────────────────

export type SpParts = { y: number; m: number; d: number; hh: number; mm: number; weekday: number };

/** Partes da data/hora no fuso de São Paulo. */
export function spParts(date: Date = new Date()): SpParts {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: SP_TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(parts["year"]), m: Number(parts["month"]), d: Number(parts["day"]),
    hh: Number(parts["hour"]) % 24, mm: Number(parts["minute"]),
    weekday: weekdays[parts["weekday"] ?? "Sun"] ?? 0,
  };
}

/** "YYYY-MM-DD" de hoje em São Paulo. */
export function spDateISO(date: Date = new Date()): string {
  const p = spParts(date);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** "HH:MM" agora em São Paulo. */
export function spTimeHM(date: Date = new Date()): string {
  const p = spParts(date);
  return `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
}

/** Monta um Date a partir de data/hora LOCAL de São Paulo. */
export function spDate(y: number, m: number, d: number, hh = 0, mm = 0): Date {
  const pad = (n: number) => String(n).padStart(2, "0");
  return new Date(`${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}:00${SP_OFFSET}`);
}

/**
 * Converte "YYYY-MM-DDTHH:mm" (ou "YYYY-MM-DD HH:mm", ou só "YYYY-MM-DD")
 * em horário de São Paulo para Date. Devolve null se não for uma data válida.
 */
export function parseSpLocal(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return null;
  const d = spDate(Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? Number(m[4]) : 0, m[5] ? Number(m[5]) : 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

const WEEKDAY_NAMES = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
const WEEKDAY_SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

/** "seg 19/10 às 21:49" — forma curta pra respostas no WhatsApp. */
export function fmtWhen(date: Date, opts: { withTime?: boolean } = {}): string {
  const p = spParts(date);
  const withTime = opts.withTime ?? true;
  const today = spParts();
  const dd = `${String(p.d).padStart(2, "0")}/${String(p.m).padStart(2, "0")}`;
  const sameDay = p.y === today.y && p.m === today.m && p.d === today.d;
  const tomorrow = spParts(new Date(Date.now() + 86_400_000));
  const isTomorrow = p.y === tomorrow.y && p.m === tomorrow.m && p.d === tomorrow.d;
  const dayLabel = sameDay ? "hoje" : isTomorrow ? "amanhã" : `${WEEKDAY_SHORT[p.weekday]} ${dd}${p.y !== today.y ? `/${p.y}` : ""}`;
  if (!withTime) return dayLabel;
  return `${dayLabel} às ${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
}

/** "dd/mm" a partir de "YYYY-MM-DD" (datas sem hora — vencimentos etc.). */
export function fmtDateISO(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  const today = spDateISO();
  if (iso.slice(0, 10) === today) return "hoje";
  return `${m[3]}/${m[2]}${m[1] !== today.slice(0, 4) ? `/${m[1]}` : ""}`;
}

/** Linha de contexto pro prompt da IA: "segunda-feira, 19/10/2026, 21:49". */
export function describeNow(date: Date = new Date()): string {
  const p = spParts(date);
  return `${WEEKDAY_NAMES[p.weekday]}, ${String(p.d).padStart(2, "0")}/${String(p.m).padStart(2, "0")}/${p.y}, ${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
}

/** true se "HH:MM" está dentro da faixa [start, end) — faixa pode cruzar a meia-noite. */
export function withinRange(hm: string, start: string, end: string): boolean {
  if (start === end) return false;
  if (start < end) return hm >= start && hm < end;
  return hm >= start || hm < end;
}

// ─── Dinheiro ────────────────────────────────────────────────────────────────

export function brl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/** "1.250,50" / "1250.50" / "50" / "R$ 50,00" / "50 reais" → centavos (null se inválido). */
export function parseBRL(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.round(raw * 100) : null;
  let s = raw.replace(/r\$/i, "").replace(/reais?/i, "").replace(/\s/g, "").trim();
  if (!s) return null;
  // "1.250,50" (BR) → "1250.50"; "1250.50" (US) fica; "1.250" ambíguo → milhar.
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/\.\d{3}$/.test(s) && !/,/.test(s)) s = s.replace(/\./g, "");
  else s = s.replace(",", ".");
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

// ─── Interpretação de datas em português ─────────────────────────────────────

export function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

const WEEKDAY_WORDS: Record<string, number> = {
  domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6,
};

/**
 * Extrai data/hora de um texto em português e devolve o Date + o texto sem
 * a parte temporal (pra virar título). Entende: hoje, amanhã, depois de
 * amanhã, segunda..domingo, dd/mm, dd/mm/aaaa, "às 15h", "15:30", "15h30",
 * "em 2 horas", "em 30 minutos", "daqui 1 hora", "de manhã/tarde/noite".
 * Sem hora explícita, usa `defaultHour`.
 */
export function extractWhen(text: string, now: Date = new Date(), defaultHour = 9): { when: Date | null; rest: string } {
  let t = ` ${text.replace(/\s+/g, " ").trim()} `;
  const n = spParts(now);
  // Estado num objeto (e não em variáveis soltas) de propósito: atribuição
  // dentro de callback não é vista pelo narrowing do TypeScript.
  const st: { y: number; m: number; d: number; hh: number | null; mm: number; dateFound: boolean; relative: Date | null; period: "manha" | "tarde" | "noite" | null } =
    { y: n.y, m: n.m, d: n.d, hh: null, mm: 0, dateFound: false, relative: null, period: null };

  const take = (re: RegExp, fn: (mt: RegExpMatchArray) => void): boolean => {
    const mt = t.match(re);
    if (!mt) return false;
    fn(mt);
    t = t.replace(re, " ");
    return true;
  };
  const addDays = (days: number): void => {
    const base = spDate(st.y, st.m, st.d, 12, 0);
    const p = spParts(new Date(base.getTime() + days * 86_400_000));
    st.y = p.y; st.m = p.m; st.d = p.d;
  };

  // Relativo: "em 2 horas", "daqui a 30 min", "em 1h"
  take(/\s(?:em|daqui a|daqui)\s+(\d+)\s*(h|hora|horas|min|minuto|minutos|dia|dias)\b/i, (mt) => {
    const qty = Number(mt[1]);
    const unit = norm(mt[2]!);
    const ms = unit.startsWith("h") ? qty * 3_600_000 : unit.startsWith("min") ? qty * 60_000 : qty * 86_400_000;
    st.relative = new Date(now.getTime() + ms);
  });
  if (st.relative) return { when: st.relative, rest: t.replace(/\s+/g, " ").trim() };

  // Data absoluta dd/mm[/aaaa]
  take(/\s(?:dia\s+|no dia\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/, (mt) => {
    st.d = Number(mt[1]); st.m = Number(mt[2]);
    if (mt[3]) st.y = mt[3].length === 2 ? 2000 + Number(mt[3]) : Number(mt[3]);
    st.dateFound = true;
  });
  // Palavras
  if (!st.dateFound) take(/\s(depois de amanha|depois de amanhã)\s/i, () => { addDays(2); st.dateFound = true; });
  if (!st.dateFound) take(/\s(amanha|amanhã)\s/i, () => { addDays(1); st.dateFound = true; });
  if (!st.dateFound) take(/\s(hoje)\s/i, () => { st.dateFound = true; });
  if (!st.dateFound) {
    take(/\s(?:na |no |nesta |neste |proxima |próxima |proximo |próximo )?(segunda|terca|terça|quarta|quinta|sexta|sabado|sábado|domingo)(?:-feira)?\s/i, (mt) => {
      const target = WEEKDAY_WORDS[norm(mt[1]!)]!;
      let diff = (target - n.weekday + 7) % 7;
      if (diff === 0) diff = 7; // "segunda" dita numa segunda = a próxima
      addDays(diff);
      st.dateFound = true;
    });
  }

  // Hora: "às 15h", "as 15:30", "15h30", "9 horas", "meio-dia"
  take(/\s(?:as|às|ao|pras|pro|para as|para)?\s*(\d{1,2})(?::|h)(\d{2})\s?(?:h|hs|horas)?\b/i, (mt) => {
    st.hh = Number(mt[1]); st.mm = Number(mt[2]);
  });
  if (st.hh == null) take(/\s(?:as|às|pras|para as)\s+(\d{1,2})\s?(?:h|hs|horas?)?\b/i, (mt) => { st.hh = Number(mt[1]); });
  if (st.hh == null) take(/\s(\d{1,2})\s?(?:h|hs|horas)\b/i, (mt) => { st.hh = Number(mt[1]); });
  if (st.hh == null) take(/\s(meio[- ]dia)\s/i, () => { st.hh = 12; });
  // Período do dia (só ajusta a hora padrão)
  take(/\s(?:de|da|do|a|à|pela|na|no)\s+(manha|manhã|tarde|noite)\s/i, (mt) => { st.period = norm(mt[1]!) as typeof st.period; });
  if (st.hh != null && (st.period === "tarde" || st.period === "noite") && st.hh < 12) st.hh += 12;
  if (st.hh == null && st.period) st.hh = st.period === "manha" ? 9 : st.period === "tarde" ? 15 : 20;

  const rest = t.replace(/\s+/g, " ").trim();
  if (!st.dateFound && st.hh == null) return { when: null, rest };

  const hh = st.hh ?? defaultHour;
  if (hh > 23 || st.mm > 59) return { when: null, rest };
  let when = spDate(st.y, st.m, st.d, hh, st.mm);
  if (Number.isNaN(when.getTime())) return { when: null, rest };
  // Hora sem data, já passada hoje → amanhã (ex.: "às 8h" dito às 21h).
  if (!st.dateFound && when.getTime() < now.getTime() - 60_000) when = new Date(when.getTime() + 86_400_000);
  return { when, rest };
}

/** Limpa sobras de preposição no começo/fim do título ("de ligar pro Tales" → "ligar pro Tales"). */
export function cleanTitle(s: string): string {
  return s
    .replace(/^\s*(?:de|do|da|que|pra|para|a|o|em|no|na|:|-|,)\s+/i, "")
    .replace(/\s+(?:as|às|a|em|no|na|de|do|da|pra|para|,|-|:)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Comandos e intenções ────────────────────────────────────────────────────

export type RuleIntent =
  | { kind: "ajuda" }
  | { kind: "confirmar"; yes: boolean }
  | { kind: "feito" }
  | { kind: "adiar"; minutes: number | null; when: Date | null }
  | { kind: "consultar"; what: "meu_dia" | "agenda" | "lembretes" | "tarefas" | "contas" | "financeiro" }
  | { kind: "desfazer" }
  | { kind: "lembrete"; title: string; dueAt: Date; urgent: boolean }
  | { kind: "gasto" | "receita"; amountCents: number; description: string; scope: "pessoal" | "empresa" }
  | { kind: "conta"; billKind: "pagar" | "receber"; amountCents: number; description: string; dueDate: string }
  | { kind: "tarefa"; title: string; assignee: string | null; dueAt: Date | null; priority: "baixa" | "media" | "alta" }
  | { kind: "compromisso"; title: string; startsAt: Date; scope: "pessoal" | "empresa" };

/**
 * Interpreta uma mensagem por regras. Devolve null quando não reconhece —
 * aí a IA assume. Nunca lança.
 */
export function parseByRules(raw: string, now: Date = new Date()): RuleIntent | null {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const t = norm(text);

  if (/^(ajuda|help|menu|comandos|\?)$/.test(t)) return { kind: "ajuda" };
  if (/^(sim|s|confirmo|confirma|pode|isso|ok|certo|correto|positivo|yes)[.!]?$/.test(t)) return { kind: "confirmar", yes: true };
  if (/^(nao|n|cancela|cancelar|negativo|deixa|esquece)[.!]?$/.test(t)) return { kind: "confirmar", yes: false };
  if (/^(feito|pronto|concluido|concluí|concluido!|resolvido|ja fiz|fiz|ok feito|feito!)[.!]?$/.test(t)) return { kind: "feito" };
  if (/^(desfaz|desfazer|apaga o ultimo|apagar ultimo|cancela o ultimo|volta)[.!]?$/.test(t)) return { kind: "desfazer" };

  // adia 1h / adiar 30 min / adia amanhã / adia pra amanhã 9h
  const adia = t.match(/^(?:adiar|adie|adia|mais tarde|depois)(?:\s+(?:pra|para|em|por))?\s*(.*)$/);
  if (adia) {
    const arg = adia[1]?.trim() ?? "";
    if (!arg) return { kind: "adiar", minutes: 60, when: null };
    const rel = arg.match(/^(\d+)\s*(h|hora|horas|min|minuto|minutos|dia|dias)$/);
    if (rel) {
      const qty = Number(rel[1]);
      const unit = rel[2]!;
      const minutes = unit.startsWith("h") ? qty * 60 : unit.startsWith("min") ? qty : qty * 1440;
      return { kind: "adiar", minutes, when: null };
    }
    const { when } = extractWhen(` ${arg} `, now, 9);
    if (when) return { kind: "adiar", minutes: null, when };
    return null;
  }

  if (/^(meu dia|resumo|resumo do dia|como esta meu dia|o que tenho hoje|hoje)[?.!]?$/.test(t)) return { kind: "consultar", what: "meu_dia" };
  if (/^(agenda|compromissos|minha agenda|agenda da semana)[?.!]?$/.test(t)) return { kind: "consultar", what: "agenda" };
  if (/^(lembretes|pendencias|pendentes|meus lembretes)[?.!]?$/.test(t)) return { kind: "consultar", what: "lembretes" };
  if (/^(tarefas|equipe|tarefas da equipe|minhas tarefas)[?.!]?$/.test(t)) return { kind: "consultar", what: "tarefas" };
  if (/^(contas|contas a pagar|contas a receber|vencimentos)[?.!]?$/.test(t)) return { kind: "consultar", what: "contas" };
  if (/^(financeiro|gastos|receitas|resumo financeiro|quanto gastei|quanto gastei esse mes)[?.!]?$/.test(t)) return { kind: "consultar", what: "financeiro" };

  const scopeOf = (s: string): "pessoal" | "empresa" => (/\b(pessoal|minha|meu|casa|familia)\b/.test(norm(s)) ? "pessoal" : "empresa");

  // Gasto / receita: "gastei 50 no almoço", "gasto 1.200 aluguel", "recebi 300 do João"
  const money = text.match(/^(gastei|gasto|paguei|despesa|comprei|recebi|receita|entrou|ganhei|vendi)\s+(?:de\s+)?(?:r\$\s*)?([\d.,]+)\s*(?:reais|r\$|conto|pila)?\s*(?:com|em|no|na|de|do|da|pra|para|-|:)?\s*(.*)$/i);
  if (money) {
    const verb = norm(money[1]!);
    const amountCents = parseBRL(money[2]!);
    const description = cleanTitle(money[3] ?? "") || (verb.startsWith("receb") || verb === "entrou" || verb === "ganhei" || verb === "vendi" ? "Receita" : "Gasto");
    if (amountCents != null && amountCents > 0) {
      const isIncome = ["recebi", "receita", "entrou", "ganhei", "vendi"].includes(verb);
      return { kind: isIncome ? "receita" : "gasto", amountCents, description, scope: scopeOf(description) };
    }
  }

  // Conta: "conta a pagar 1.500 aluguel dia 10/11", "pagar 300 energia até 25/10", "receber 500 do João amanhã"
  const bill = text.match(/^(?:conta\s+(?:a\s+)?)?(pagar|receber)\s+(?:de\s+)?(?:r\$\s*)?([\d.,]+)\s*(?:reais)?\s*(.*)$/i);
  if (bill) {
    const amountCents = parseBRL(bill[2]!);
    if (amountCents != null && amountCents > 0) {
      const { when, rest } = extractWhen(` ${bill[3] ?? ""} `, now, 9);
      const description = cleanTitle(rest.replace(/(^|\s)(ate|até|vence|vencimento|dia)(?=\s|$)/gi, " ")) || (norm(bill[1]!) === "pagar" ? "Conta a pagar" : "Conta a receber");
      const dueDate = when ? spDateISO(when) : spDateISO(now);
      return { kind: "conta", billKind: norm(bill[1]!) as "pagar" | "receber", amountCents, description, dueDate };
    }
  }

  // Lembrete: "lembra de ligar pro Tales amanhã às 9h", "me lembre às 15h de ...", "lembrete: pagar luz 10/11"
  const rem = text.match(/^(?:me\s+)?(?:lembra|lembre|lembrar|lembrete|alerta|avisa|avise|me avisa)(?:-me|\s+me)?\s*:?\s*(.*)$/i);
  if (rem) {
    const body = rem[1] ?? "";
    const urgent = /\b(urgente|urgência|urgencia|importante)\b/i.test(body);
    const { when, rest } = extractWhen(` ${body.replace(/\b(urgente|importante)\b/gi, " ")} `, now, 9);
    const title = cleanTitle(rest);
    if (when && title) return { kind: "lembrete", title, dueAt: when, urgent };
    if (title && !when) {
      // Sem horário: lembrete pra daqui 1 hora? Não — pede horário via IA/resposta.
      return null;
    }
  }

  // Tarefa: "tarefa: trocar a vitrine para o Nilmar até sexta", "tarefa pro Vagner: conferir estoque"
  const task = text.match(/^(?:nova\s+)?tarefa\s*(?:pro|pra|para)?\s*(?:o|a)?\s*([A-Za-zÀ-ÿ]+)?\s*:?\s*(.*)$/i);
  if (task && (task[2] ?? "").trim()) {
    let assignee: string | null = task[1] ?? null;
    let body = task[2] ?? "";
    if (assignee && /^(de|do|da|que|o|a)$/i.test(assignee)) assignee = null;
    const forMatch = body.match(/\s(?:pro|pra|para)\s+(?:o|a)?\s*([A-Za-zÀ-ÿ]+)\b/i);
    if (!assignee && forMatch) { assignee = forMatch[1]!; body = body.replace(forMatch[0], " "); }
    const priority: "baixa" | "media" | "alta" = /\b(urgente|alta|prioridade)\b/i.test(body) ? "alta" : /\b(baixa|quando der)\b/i.test(body) ? "baixa" : "media";
    const { when, rest } = extractWhen(` ${body.replace(/(^|\s)(ate|até)(?=\s|$)/gi, " ")} `, now, 18);
    const title = cleanTitle(rest.replace(/\b(urgente|prioridade alta|baixa prioridade)\b/gi, " "));
    if (title) return { kind: "tarefa", title, assignee, dueAt: when, priority };
  }

  // Compromisso: "reunião com o contador amanhã às 14h", "agendar dentista sexta 10h", "compromisso: ..."
  const appt = text.match(/^(?:agendar|agenda|marcar|marca|compromisso|reuniao|reunião|encontro|visita|consulta)\s*:?\s*(.*)$/i);
  if (appt) {
    const prefix = norm(text.split(/\s|:/)[0] ?? "");
    const keepPrefix = ["reuniao", "encontro", "visita", "consulta"].includes(prefix);
    const { when, rest } = extractWhen(` ${appt[1] ?? ""} `, now, 9);
    const title = cleanTitle(`${keepPrefix ? `${text.split(/\s|:/)[0]} ` : ""}${rest}`);
    if (when && title) return { kind: "compromisso", title, startsAt: when, scope: scopeOf(title) };
  }

  return null;
}

export const HELP_TEXT = [
  "Sou seu Gerente IA. Fale comigo como falaria com uma secretária:",
  "",
  "• *Lembrete* — \"lembra de ligar pro contador amanhã às 9h\"",
  "• *Gasto/receita* — \"gastei 50 no almoço\", \"recebi 300 do João\"",
  "• *Conta* — \"pagar 1.500 aluguel dia 10/11\", \"receber 500 da Maria sexta\"",
  "• *Tarefa pra equipe* — \"tarefa pro Nilmar: conferir estoque até sexta\"",
  "• *Compromisso* — \"reunião com o contador quinta às 14h\"",
  "• *Consultas* — \"meu dia\", \"agenda\", \"lembretes\", \"tarefas\", \"contas\", \"financeiro\"",
  "• *Cliente* — \"o que combinei com o Carlos?\"",
  "",
  "Quando eu avisar um lembrete, responda *feito* ou *adia 1h*.",
  "Errou algo? Mande *desfazer* ou me corrija em texto.",
].join("\n");
