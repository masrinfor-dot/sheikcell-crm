import { db, employeesTable, workShiftsTable, timeClockEntriesTable, timeBankAdjustmentsTable, leaveRecordsTable, holidaysTable, type TimeClockEntry, type WorkShift } from "@workspace/db";
import { eq, and, gte, lte, asc, sum } from "drizzle-orm";

// Inconsistências sinalizadas no dia (pedido 15/09, análise Tangerino
// "Controle de Inconsistências") — só informativo, nunca bloqueia nada:
// "excesso_2h_diarias" = mais de 2h de hora extra no dia (CLT art. 59 — limite
// de referência); "interjornada_curta" = menos de 11h de descanso entre o fim
// de um turno e o início do próximo (CLT art. 66 — descanso mínimo entre
// jornadas).
export type TimeBankDayInconsistency = "excesso_2h_diarias" | "interjornada_curta";

export type TimeBankDay = {
  date: string; // YYYY-MM-DD (America/Sao_Paulo)
  workedMinutes: number;
  expectedMinutes: number;
  complete: boolean; // false = falta bater alguma batida do turno (ex.: esqueceu a saída) — não conta no cálculo
  leaveKind: string | null; // "ferias" | "atestado" | "falta_justificada" | "falta_injustificada" | "outro" | null
  holidayName: string | null; // nome do feriado no dia, se houver (ver holidaysTable)
  inconsistencies: TimeBankDayInconsistency[];
  entries: { kind: string; at: string }[];
};

export type TimeBankResult = {
  workedMinutes: number;
  expectedMinutes: number;
  adjustmentMinutes: number;
  balanceMinutes: number;
  days: TimeBankDay[];
};

// Chave de dia civil no fuso da loja (America/Sao_Paulo), não UTC — evita que
// uma batida às 23h vire "dia seguinte" incorretamente.
function dayKeySaoPaulo(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d);
}

function nextDayKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
}

function previousDayKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10);
}

function weekdayOfDayKey(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  // Meio-dia UTC do dia civil em questão: evita virar o dia por causa de fuso/DST ao extrair o weekday.
  const noon = new Date(Date.UTC(y!, m! - 1, d!, 12));
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", weekday: "short" }).format(noon);
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wd] ?? 0;
}

// Afastamentos que abatem o expediente esperado do banco de horas (o
// colaborador não devia expediente naquele dia, então não pode gerar saldo
// negativo). "falta_injustificada" e "outro" ficam de fora de propósito: a
// primeira é justamente a penalidade que deve continuar gerando déficit, e a
// segunda é genérica demais pra assumir isenção automática — o admin usa um
// ajuste manual de banco de horas nesse caso.
const EXCUSED_LEAVE_KINDS = new Set(["ferias", "atestado", "falta_justificada"]);

type ShiftResult = { dayKey: string; minutes: number; complete: boolean; entries: TimeClockEntry[] };

// Pareia entrada→saída na ordem cronológica das batidas, permitindo o turno
// cruzar a meia-noite (ex.: entra 22h, sai 06h do dia seguinte) — o turno
// inteiro (e os minutos trabalhados) é atribuído ao dia civil da ENTRADA,
// convenção usual de turno noturno. Antes disso, agrupar batidas só pelo dia
// civil da própria batida "quebrava" turnos noturnos ao meio: a entrada
// ficava presa num dia sem a saída correspondente (que caía no dia
// seguinte), zerando o trabalhado dos dois dias.
//
// Uma entrada sem saída correspondente até o fim do período (esqueceu de
// bater a saída) vira um turno com complete:false em vez de simplesmente
// desaparecer do cálculo — precisa aparecer pro admin corrigir.
function pairShifts(sortedEntries: TimeClockEntry[]): ShiftResult[] {
  const results: ShiftResult[] = [];
  let openIn: TimeClockEntry | null = null;
  let spanEntries: TimeClockEntry[] = [];
  let pendingBreakStart: TimeClockEntry | null = null;
  let breakMinutes = 0;
  let brokenSpan = false; // algo fora de ordem dentro do turno aberto (break sem par, etc.)

  const closeOpenAsIncomplete = () => {
    if (!openIn) return;
    results.push({ dayKey: dayKeySaoPaulo(openIn.at), minutes: 0, complete: false, entries: spanEntries });
    openIn = null; spanEntries = []; pendingBreakStart = null; breakMinutes = 0; brokenSpan = false;
  };

  for (const e of sortedEntries) {
    if (e.kind === "in") {
      // Duas entradas seguidas sem saída no meio: fecha a anterior como
      // incompleta (não descarta) e abre um novo turno nesta.
      closeOpenAsIncomplete();
      openIn = e;
      spanEntries = [e];
      continue;
    }
    if (!openIn) {
      // Batida órfã (break/saída sem entrada aberta) — sinaliza sozinha em
      // vez de silenciosamente ignorar.
      results.push({ dayKey: dayKeySaoPaulo(e.at), minutes: 0, complete: false, entries: [e] });
      continue;
    }
    spanEntries.push(e);
    if (e.kind === "break_start") {
      if (pendingBreakStart) brokenSpan = true; // dois break_start seguidos
      pendingBreakStart = e;
    } else if (e.kind === "break_end") {
      if (pendingBreakStart && e.at > pendingBreakStart.at) {
        breakMinutes += (e.at.getTime() - pendingBreakStart.at.getTime()) / 60000;
        pendingBreakStart = null;
      } else {
        brokenSpan = true; // break_end sem break_start correspondente
      }
    } else if (e.kind === "out") {
      if (pendingBreakStart) brokenSpan = true; // intervalo não fechado antes da saída
      const totalSpan = (e.at.getTime() - openIn.at.getTime()) / 60000;
      const complete = !brokenSpan && totalSpan > 0;
      const minutes = complete ? Math.max(0, Math.round(totalSpan - breakMinutes)) : 0;
      results.push({ dayKey: dayKeySaoPaulo(openIn.at), minutes, complete, entries: spanEntries });
      openIn = null; spanEntries = []; pendingBreakStart = null; breakMinutes = 0; brokenSpan = false;
    }
  }
  closeOpenAsIncomplete(); // entrada sem saída até o fim do período informado

  return results;
}

// Tolerância de atraso (pedido 15/09, análise Tangerino "Regras de Ponto" —
// campo "Tolerância de Atrasos"): atraso na entrada dentro de
// shift.toleranceMinutes não gera déficit — credita de volta os minutos
// tolerados no turno, sem precisar de ajuste manual do RH. Só se aplica à
// entrada (não à saída antecipada), escala fixa, e só quando o turno foi
// batido normalmente (complete=true). Mutação in-place de propósito (mesmo
// padrão de pairShifts, evita duplicar a estrutura só pra isso).
function applyLateTolerance(shiftResults: ShiftResult[], shift: WorkShift | null): void {
  if (!shift || shift.type !== "fixed" || !shift.startTime) return;
  const toleranceMinutes = shift.toleranceMinutes ?? 0;
  if (toleranceMinutes <= 0) return;
  for (const r of shiftResults) {
    if (!r.complete || r.minutes <= 0) continue;
    const firstEntry = r.entries[0];
    if (!firstEntry || firstEntry.kind !== "in") continue;
    if (!shift.weekdays.includes(weekdayOfDayKey(r.dayKey))) continue;
    const scheduledStart = new Date(`${r.dayKey}T${shift.startTime}:00-03:00`);
    if (Number.isNaN(scheduledStart.getTime())) continue;
    const lateMinutes = (firstEntry.at.getTime() - scheduledStart.getTime()) / 60000;
    if (lateMinutes > 0 && lateMinutes <= toleranceMinutes) {
      r.minutes += Math.round(lateMinutes);
    }
  }
}

// Primeira batida "in" / última batida "out" do dia civil (já pareadas por
// pairShifts) — usadas pra medir o descanso entre jornadas (interjornada),
// que compara o fim de um turno com o início do turno seguinte, mesmo que
// caiam em dias civis diferentes.
function dayFirstIn(byDay: Map<string, ShiftResult[]>, key: string): Date | null {
  const first = byDay.get(key)?.[0]?.entries[0];
  return first && first.kind === "in" ? first.at : null;
}
function dayLastOut(byDay: Map<string, ShiftResult[]>, key: string): Date | null {
  const arr = byDay.get(key);
  const last = arr?.[arr.length - 1];
  const lastEntry = last?.entries[last.entries.length - 1];
  return lastEntry && lastEntry.kind === "out" ? lastEntry.at : null;
}

export async function computeTimeBank(employeeId: number, tenantId: number, from: Date, to: Date): Promise<TimeBankResult> {
  const [employee] = await db.select().from(employeesTable)
    .where(and(eq(employeesTable.id, employeeId), eq(employeesTable.tenantId, tenantId)));
  // Bug de vazamento entre lojas (09/09): faltava filtrar por tenantId aqui —
  // sem isso, um employee.shiftId apontando (por engano ou má-fé) pra uma
  // escala de OUTRA loja fazia o banco de horas usar o horário/dias dessa
  // escala estranha em vez de tratar como "sem escala".
  const shift = employee?.shiftId
    ? (await db.select().from(workShiftsTable).where(and(eq(workShiftsTable.id, employee.shiftId), eq(workShiftsTable.tenantId, tenantId))))[0] ?? null
    : null;

  const entries = await db.select().from(timeClockEntriesTable)
    .where(and(
      eq(timeClockEntriesTable.employeeId, employeeId),
      eq(timeClockEntriesTable.tenantId, tenantId),
      gte(timeClockEntriesTable.at, from),
      lte(timeClockEntriesTable.at, to),
    ))
    .orderBy(asc(timeClockEntriesTable.at));

  const shiftResults = pairShifts(entries);
  applyLateTolerance(shiftResults, shift);
  const byDay = new Map<string, ShiftResult[]>();
  for (const r of shiftResults) {
    const arr = byDay.get(r.dayKey);
    if (arr) arr.push(r); else byDay.set(r.dayKey, [r]);
  }

  // Dias de férias/atestado/falta justificada no período: abatem o
  // expediente esperado (ver EXCUSED_LEAVE_KINDS acima).
  const fromKey = dayKeySaoPaulo(from);
  const toKey = dayKeySaoPaulo(to);

  // Feriados no período (pedido 15/09, análise Tangerino "Calendário de
  // Feriados"): mesma lógica de isenção de expediente esperado que férias/
  // atestado/falta justificada — ver excusesExpected em holidaysTable.
  const holidayRows = await db.select({
    date: holidaysTable.date, name: holidaysTable.name, excusesExpected: holidaysTable.excusesExpected,
  }).from(holidaysTable)
    .where(and(eq(holidaysTable.tenantId, tenantId), gte(holidaysTable.date, fromKey), lte(holidaysTable.date, toKey)));
  const holidayByDay = new Map<string, { name: string; excusesExpected: boolean }>();
  for (const h of holidayRows) holidayByDay.set(h.date, { name: h.name, excusesExpected: h.excusesExpected });
  const leaveRows = await db.select({
    kind: leaveRecordsTable.kind,
    startDate: leaveRecordsTable.startDate,
    endDate: leaveRecordsTable.endDate,
  }).from(leaveRecordsTable)
    .where(and(
      eq(leaveRecordsTable.employeeId, employeeId),
      eq(leaveRecordsTable.tenantId, tenantId),
      lte(leaveRecordsTable.startDate, toKey),
      gte(leaveRecordsTable.endDate, fromKey),
    ));
  const leaveKindByDay = new Map<string, string>();
  for (const lr of leaveRows) {
    if (!EXCUSED_LEAVE_KINDS.has(lr.kind)) continue;
    let d = lr.startDate;
    let guard = 0;
    while (d <= lr.endDate && guard++ < 400) {
      leaveKindByDay.set(d, lr.kind);
      d = nextDayKey(d);
    }
  }

  // Percorre todo dia civil do período (não só os com batida) pra contar
  // expediente esperado mesmo em dias de falta.
  const dayKeys: string[] = [];
  {
    const cursor = new Date(from);
    let guard = 0;
    while (guard++ < 400) {
      const key = dayKeySaoPaulo(cursor);
      dayKeys.push(key);
      if (key === toKey) break;
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  const days: TimeBankDay[] = [];
  let workedMinutes = 0;
  let expectedMinutes = 0;
  for (const key of dayKeys) {
    const dayResults = byDay.get(key) ?? [];
    const leaveKind = leaveKindByDay.get(key) ?? null;
    const holiday = holidayByDay.get(key) ?? null;
    let dayExpected = 0;
    // Escala "flexible" (sem horário fixo) nunca tem expediente esperado —
    // o banco de horas dela só soma o que foi trabalhado, nunca cobra falta.
    // Dia coberto por férias/atestado/falta justificada ou feriado (que
    // isenta, ver excusesExpected) também não gera expediente esperado — o
    // colaborador estava de licença/folga, não devendo.
    if (shift && shift.type === "fixed" && shift.weekdays.includes(weekdayOfDayKey(key)) && !leaveKind && !(holiday?.excusesExpected)) {
      dayExpected = shift.expectedMinutesPerDay ?? 0;
    }
    expectedMinutes += dayExpected;
    const minutes = dayResults.reduce((s, r) => s + r.minutes, 0);
    const complete = dayResults.length === 0 ? true : dayResults.every((r) => r.complete);
    workedMinutes += minutes;

    // Inconsistências sinalizadas (pedido 15/09, análise Tangerino) — só
    // informativo, nunca altera o cálculo do saldo.
    const inconsistencies: TimeBankDayInconsistency[] = [];
    if (dayExpected > 0 && minutes - dayExpected > 120) inconsistencies.push("excesso_2h_diarias");
    const firstIn = dayFirstIn(byDay, key);
    const prevOut = dayLastOut(byDay, previousDayKey(key));
    if (firstIn && prevOut) {
      const restMinutes = (firstIn.getTime() - prevOut.getTime()) / 60000;
      if (restMinutes >= 0 && restMinutes < 660) inconsistencies.push("interjornada_curta");
    }

    days.push({
      date: key,
      workedMinutes: minutes,
      expectedMinutes: dayExpected,
      complete,
      leaveKind,
      holidayName: holiday?.name ?? null,
      inconsistencies,
      entries: dayResults.flatMap((r) => r.entries).map((e) => ({ kind: e.kind, at: e.at.toISOString() })),
    });
  }

  const [adjRow] = await db.select({ total: sum(timeBankAdjustmentsTable.minutes) })
    .from(timeBankAdjustmentsTable)
    .where(and(
      eq(timeBankAdjustmentsTable.employeeId, employeeId),
      eq(timeBankAdjustmentsTable.tenantId, tenantId),
      gte(timeBankAdjustmentsTable.createdAt, from),
      lte(timeBankAdjustmentsTable.createdAt, to),
    ));
  const adjustmentMinutes = Number(adjRow?.total ?? 0);

  return {
    workedMinutes,
    expectedMinutes,
    adjustmentMinutes,
    balanceMinutes: workedMinutes - expectedMinutes + adjustmentMinutes,
    days,
  };
}

// Deriva o próximo tipo de batida esperado a partir do último registro do
// colaborador — a UI mostra só esse botão, sem deixar o colaborador escolher
// o tipo manualmente. Recebe as batidas "efetivas" já resolvidas por quem
// chama (hoje, ou hoje + cauda de ontem se houver turno noturno em aberto —
// ver /rh-dp/me/punch), não faz suposição de fuso/dia aqui.
export function nextPunchKind(effectiveEntries: TimeClockEntry[], hasBreak: boolean): "in" | "break_start" | "break_end" | "out" | null {
  const sorted = effectiveEntries.slice().sort((a, b) => a.at.getTime() - b.at.getTime());
  const last = sorted[sorted.length - 1];
  if (!last) return "in";
  if (last.kind === "in") return hasBreak ? "break_start" : "out";
  if (last.kind === "break_start") return "break_end";
  if (last.kind === "break_end") return "out";
  if (last.kind === "out") return null; // já bateu tudo hoje
  return "in";
}

// Resolve a batida esperada pro colaborador AGORA — usado por POST
// /rh-dp/me/punch, pelo check-in por foto no WhatsApp e por GET
// /rh-dp/me/clock-status (que decide se mostra o PontoGate). Centralizado
// aqui pra essas três pontas nunca discordarem sobre o estado do dia.
//
// Bug real (17/09): quando a loja fecha tarde e um colaborador bate a
// SAÍDA já depois da meia-noite, essa batida fica datada de "hoje" mesmo
// sendo o fim do turno de ONTEM. Sem esse ajuste, o dia civil de hoje
// aparecia com uma "saída" órfã (sem nenhuma "entrada" própria de hoje
// antes dela): o clock-status via "sem entrada hoje" e mandava mostrar o
// PontoGate pedindo entrada, mas o punch via a última batida = "saída" e
// recusava com "Você já bateu todos os pontos de hoje.", travando o
// colaborador num loop sem saída. Aqui essa saída órfã é ignorada pro
// cálculo — sem uma "entrada" que também seja de hoje, o dia é tratado
// como ainda não iniciado.
export async function resolveTodaysPunchKind(
  employeeId: number, tenantId: number, hasBreak: boolean,
): Promise<{ kind: "in" | "break_start" | "break_end" | "out" | null; todayEntries: TimeClockEntry[]; effectiveEntries: TimeClockEntry[] }> {
  const todayKey = dayKeySaoPaulo(new Date());
  const dayStart = new Date(`${todayKey}T00:00:00-03:00`);
  const dayEnd = new Date(`${todayKey}T23:59:59-03:00`);
  // Turno noturno cruzando a meia-noite: uma entrada batida ontem à noite
  // sem saída ainda não fechou o turno, mesmo que o "hoje" civil já tenha
  // virado — olha até 20h pra trás pra achar esse turno em aberto.
  const lookbackStart = new Date(dayStart.getTime() - 20 * 3600_000);
  const recentEntries = await db.select().from(timeClockEntriesTable)
    .where(and(
      eq(timeClockEntriesTable.employeeId, employeeId),
      eq(timeClockEntriesTable.tenantId, tenantId),
      gte(timeClockEntriesTable.at, lookbackStart),
      lte(timeClockEntriesTable.at, dayEnd),
    ))
    .orderBy(asc(timeClockEntriesTable.at));
  const todayEntries = recentEntries.filter((e) => dayKeySaoPaulo(e.at) === todayKey);
  const lastEntry = recentEntries[recentEntries.length - 1];

  let effectiveEntries: TimeClockEntry[];
  if (lastEntry && lastEntry.kind !== "out" && dayKeySaoPaulo(lastEntry.at) !== todayKey) {
    // Última batida (de ontem) não foi "saída": o turno está aberto
    // cruzando a virada do dia — continua a partir dele.
    effectiveEntries = recentEntries;
  } else {
    const hasInToday = todayEntries.some((e) => e.kind === "in");
    // Sem "entrada" própria de hoje: ignora qualquer batida órfã de hoje
    // (ex.: a saída de um turno de ontem que só fechou depois da meia-noite)
    // — pro sistema, o dia ainda não começou.
    effectiveEntries = hasInToday ? todayEntries : [];
  }

  return { kind: nextPunchKind(effectiveEntries, hasBreak), todayEntries, effectiveEntries };
}

// Ponto obrigatório só se aplica a escala "fixed" e só nos dias que a escala
// prevê expediente — escala livre ou dia fora de weekdays nunca exige bater
// ponto pra liberar o login. Não decide isenção por cargo (ex.: admin) —
// isso é responsabilidade de quem chama, que tem acesso à sessão.
export async function employeeNeedsClockInToday(
  employeeId: number, tenantId: number, shift: (WorkShift | { type: string; weekdays: number[]; breakStart?: string | null; breakEnd?: string | null }) | null,
): Promise<boolean> {
  if (!shift || shift.type !== "fixed") return false;
  const todayKey = dayKeySaoPaulo(new Date());
  if (!shift.weekdays.includes(weekdayOfDayKey(todayKey))) return false;
  // Mesma resolução usada por POST /rh-dp/me/punch — nunca discordar sobre
  // se o dia já tem uma "entrada" pendente (ver resolveTodaysPunchKind).
  const hasBreak = !!(shift.breakStart && shift.breakEnd);
  const { kind } = await resolveTodaysPunchKind(employeeId, tenantId, hasBreak);
  return kind === "in";
}

function hhmmSaoPaulo(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

// "Pontos britânicos" adaptado (pedido 15/09, análise Tangerino) — o
// Tangerino sinaliza quando um relógio de ponto FÍSICO registra horários
// exatos demais, sinal clássico de fraude (marcação pré-configurada em vez
// da hora real). Nosso sistema não tem esse risco pra batida do próprio
// colaborador (o horário é sempre now() do servidor, o colaborador não pode
// editar) — o risco equivalente aqui é o RH lançar manualmente (source=
// "admin", ver PontoAdmin/"Editar dia") sempre EXATAMENTE no horário da
// escala em vez de conferir o horário real trabalhado, o que apaga
// silenciosamente atrasos/saídas antecipadas reais. Sinaliza (não bloqueia)
// quando 80%+ das batidas manuais do período batem exatamente com o horário
// da escala, com pelo menos 5 batidas manuais no período.
export async function hasSuspiciousManualPattern(employeeId: number, tenantId: number, from: Date, to: Date): Promise<boolean> {
  const [employee] = await db.select().from(employeesTable)
    .where(and(eq(employeesTable.id, employeeId), eq(employeesTable.tenantId, tenantId)));
  const shift = employee?.shiftId
    ? (await db.select().from(workShiftsTable).where(and(eq(workShiftsTable.id, employee.shiftId), eq(workShiftsTable.tenantId, tenantId))))[0] ?? null
    : null;
  if (!shift || shift.type !== "fixed" || !shift.startTime || !shift.endTime) return false;

  const rows = await db.select({ kind: timeClockEntriesTable.kind, at: timeClockEntriesTable.at })
    .from(timeClockEntriesTable)
    .where(and(
      eq(timeClockEntriesTable.employeeId, employeeId),
      eq(timeClockEntriesTable.tenantId, tenantId),
      eq(timeClockEntriesTable.source, "admin"),
      gte(timeClockEntriesTable.at, from),
      lte(timeClockEntriesTable.at, to),
    ));
  const relevant = rows.filter((r) => r.kind === "in" || r.kind === "out");
  if (relevant.length < 5) return false;
  const exactMatches = relevant.filter((r) => {
    const hhmm = hhmmSaoPaulo(r.at);
    return (r.kind === "in" && hhmm === shift.startTime) || (r.kind === "out" && hhmm === shift.endTime);
  }).length;
  return exactMatches / relevant.length >= 0.8;
}

export { dayKeySaoPaulo };
