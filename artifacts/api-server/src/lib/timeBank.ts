import { db, employeesTable, workShiftsTable, timeClockEntriesTable, timeBankAdjustmentsTable, leaveRecordsTable, type TimeClockEntry } from "@workspace/db";
import { eq, and, gte, lte, asc, sum } from "drizzle-orm";

export type TimeBankDay = {
  date: string; // YYYY-MM-DD (America/Sao_Paulo)
  workedMinutes: number;
  expectedMinutes: number;
  complete: boolean; // false = falta bater alguma batida do turno (ex.: esqueceu a saída) — não conta no cálculo
  leaveKind: string | null; // "ferias" | "atestado" | "falta_justificada" | "falta_injustificada" | "outro" | null
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

export async function computeTimeBank(employeeId: number, tenantId: number, from: Date, to: Date): Promise<TimeBankResult> {
  const [employee] = await db.select().from(employeesTable)
    .where(and(eq(employeesTable.id, employeeId), eq(employeesTable.tenantId, tenantId)));
  const shift = employee?.shiftId
    ? (await db.select().from(workShiftsTable).where(eq(workShiftsTable.id, employee.shiftId)))[0] ?? null
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
  const byDay = new Map<string, ShiftResult[]>();
  for (const r of shiftResults) {
    const arr = byDay.get(r.dayKey);
    if (arr) arr.push(r); else byDay.set(r.dayKey, [r]);
  }

  // Dias de férias/atestado/falta justificada no período: abatem o
  // expediente esperado (ver EXCUSED_LEAVE_KINDS acima).
  const fromKey = dayKeySaoPaulo(from);
  const toKey = dayKeySaoPaulo(to);
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
    let dayExpected = 0;
    // Escala "flexible" (sem horário fixo) nunca tem expediente esperado —
    // o banco de horas dela só soma o que foi trabalhado, nunca cobra falta.
    // Dia coberto por férias/atestado/falta justificada também não gera
    // expediente esperado — o colaborador estava de licença, não devendo.
    if (shift && shift.type === "fixed" && shift.weekdays.includes(weekdayOfDayKey(key)) && !leaveKind) {
      dayExpected = shift.expectedMinutesPerDay ?? 0;
    }
    expectedMinutes += dayExpected;
    const minutes = dayResults.reduce((s, r) => s + r.minutes, 0);
    const complete = dayResults.length === 0 ? true : dayResults.every((r) => r.complete);
    workedMinutes += minutes;
    days.push({
      date: key,
      workedMinutes: minutes,
      expectedMinutes: dayExpected,
      complete,
      leaveKind,
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

// Ponto obrigatório só se aplica a escala "fixed" e só nos dias que a escala
// prevê expediente — escala livre ou dia fora de weekdays nunca exige bater
// ponto pra liberar o login. Não decide isenção por cargo (ex.: admin) —
// isso é responsabilidade de quem chama, que tem acesso à sessão.
export async function employeeNeedsClockInToday(
  employeeId: number, tenantId: number, shift: { type: string; weekdays: number[] } | null,
): Promise<boolean> {
  if (!shift || shift.type !== "fixed") return false;
  const todayKey = dayKeySaoPaulo(new Date());
  if (!shift.weekdays.includes(weekdayOfDayKey(todayKey))) return false;
  const dayStart = new Date(`${todayKey}T00:00:00-03:00`);
  const dayEnd = new Date(`${todayKey}T23:59:59-03:00`);
  const [hasIn] = await db.select({ id: timeClockEntriesTable.id }).from(timeClockEntriesTable)
    .where(and(
      eq(timeClockEntriesTable.employeeId, employeeId),
      eq(timeClockEntriesTable.tenantId, tenantId),
      eq(timeClockEntriesTable.kind, "in"),
      gte(timeClockEntriesTable.at, dayStart),
      lte(timeClockEntriesTable.at, dayEnd),
    )).limit(1);
  return !hasIn;
}

export { dayKeySaoPaulo };
