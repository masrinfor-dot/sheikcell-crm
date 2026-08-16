import { db, employeesTable, workShiftsTable, timeClockEntriesTable, timeBankAdjustmentsTable, type TimeClockEntry } from "@workspace/db";
import { eq, and, gte, lte, asc, sum } from "drizzle-orm";

export type TimeBankDay = {
  date: string; // YYYY-MM-DD (America/Sao_Paulo)
  workedMinutes: number;
  expectedMinutes: number;
  complete: boolean; // false = batidas do dia não fecham (ex.: intervalo sem fim) — não conta no cálculo
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

function weekdayOfDayKey(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  // Meio-dia UTC do dia civil em questão: evita virar o dia por causa de fuso/DST ao extrair o weekday.
  const noon = new Date(Date.UTC(y!, m! - 1, d!, 12));
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", weekday: "short" }).format(noon);
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wd] ?? 0;
}

// Soma os minutos trabalhados de um dia a partir das batidas: pareia o
// primeiro "in" com o último "out", descontando os intervalos
// (break_start/break_end) pareados entre eles. Um intervalo aberto (start
// sem end correspondente) marca o dia como incompleto — não entra no total.
function computeDayWorked(dayEntries: TimeClockEntry[]): { minutes: number; complete: boolean } {
  const ins = dayEntries.filter((e) => e.kind === "in");
  const outs = dayEntries.filter((e) => e.kind === "out");
  if (ins.length === 0 || outs.length === 0) return { minutes: 0, complete: true }; // sem batida = dia sem trabalho (falta/folga), não "incompleto"
  const firstIn = ins[0]!.at;
  const lastOut = outs[outs.length - 1]!.at;
  if (lastOut <= firstIn) return { minutes: 0, complete: false };

  const starts = dayEntries.filter((e) => e.kind === "break_start");
  const ends = dayEntries.filter((e) => e.kind === "break_end");
  let breakMinutes = 0;
  const pairs = Math.min(starts.length, ends.length);
  for (let i = 0; i < pairs; i++) {
    const s = starts[i]!.at;
    const e = ends[i]!.at;
    if (e > s) breakMinutes += (e.getTime() - s.getTime()) / 60000;
  }
  const complete = starts.length === ends.length;
  const totalSpan = (lastOut.getTime() - firstIn.getTime()) / 60000;
  return { minutes: Math.max(0, Math.round(totalSpan - breakMinutes)), complete };
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

  const byDay = new Map<string, TimeClockEntry[]>();
  for (const e of entries) {
    const key = dayKeySaoPaulo(e.at);
    const arr = byDay.get(key);
    if (arr) arr.push(e); else byDay.set(key, [e]);
  }

  // Percorre todo dia civil do período (não só os com batida) pra contar
  // expediente esperado mesmo em dias de falta.
  const dayKeys: string[] = [];
  {
    const endKey = dayKeySaoPaulo(to);
    const cursor = new Date(from);
    let guard = 0;
    while (guard++ < 400) {
      const key = dayKeySaoPaulo(cursor);
      dayKeys.push(key);
      if (key === endKey) break;
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  const days: TimeBankDay[] = [];
  let workedMinutes = 0;
  let expectedMinutes = 0;
  for (const key of dayKeys) {
    const dayEntries = (byDay.get(key) ?? []).slice().sort((a, b) => a.at.getTime() - b.at.getTime());
    let dayExpected = 0;
    // Escala "flexible" (sem horário fixo) nunca tem expediente esperado —
    // o banco de horas dela só soma o que foi trabalhado, nunca cobra falta.
    if (shift && shift.type === "fixed" && shift.weekdays.includes(weekdayOfDayKey(key))) {
      dayExpected = shift.expectedMinutesPerDay ?? 0;
    }
    expectedMinutes += dayExpected;
    const { minutes, complete } = computeDayWorked(dayEntries);
    workedMinutes += minutes;
    days.push({
      date: key,
      workedMinutes: minutes,
      expectedMinutes: dayExpected,
      complete,
      entries: dayEntries.map((e) => ({ kind: e.kind, at: e.at.toISOString() })),
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
// colaborador NO DIA (fuso America/Sao_Paulo) — a UI mostra só esse botão,
// sem deixar o colaborador escolher o tipo manualmente.
export function nextPunchKind(todayEntries: TimeClockEntry[], hasBreak: boolean): "in" | "break_start" | "break_end" | "out" | null {
  const sorted = todayEntries.slice().sort((a, b) => a.at.getTime() - b.at.getTime());
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
