import {
  db, employeesTable, usersTable, leaveRecordsTable, timeClockEntriesTable,
  type RoutineChecklist, type RoutineChecklistScope,
} from "@workspace/db";
import { eq, and, lte, gte, asc } from "drizzle-orm";

// Extraído de rotinas.ts pra ser reaproveitado por routineClosures.ts (Fase
// 5) sem import circular entre rota e lib — mesma lógica de "devido"/escopo
// usada em GET /rotinas/pending, só que parametrizada por uma data qualquer
// (não só "agora"), pra dar pra recalcular dias passados no fechamento mensal.

export type DateInfo = { dateKey: string; weekday: number; dayOfMonth: number };

export function dateInfoFor(date: Date): DateInfo {
  const dateKey = date.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const weekdayName = date.toLocaleDateString("en-US", { timeZone: "America/Sao_Paulo", weekday: "short" });
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayName);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", day: "2-digit" }).formatToParts(date);
  const dayOfMonth = parseInt(parts.find((p) => p.type === "day")?.value ?? "0", 10);
  return { dateKey, weekday, dayOfMonth };
}

export function todayInfo(): DateInfo & { nowMinutes: number } {
  const now = new Date();
  const info = dateInfoFor(now);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  let hh = parseInt(get("hour"), 10);
  if (hh === 24) hh = 0; // quirk do Intl: meia-noite às vezes vem como "24"
  return { ...info, nowMinutes: hh * 60 + parseInt(get("minute"), 10) };
}

// Devido no dia (dia certo pra recorrência) — não depende de horário do dia,
// só do padrão de dias. Nome mantido "isDueToday" (usado com todayInfo() no
// dia-a-dia e com dateInfoFor(dataPassada) no fechamento mensal).
export function isDueToday(c: RoutineChecklist, info: DateInfo): boolean {
  switch (c.recurrence) {
    case "daily": return true;
    case "continuous": return true;
    case "weekdays": return info.weekday >= 1 && info.weekday <= 5;
    case "specific_days":
    case "weekly": return (c.recurrenceDays ?? []).includes(info.weekday);
    case "monthly": return (c.recurrenceDays ?? [])[0] === info.dayOfMonth;
    case "specific_date": return c.specificDate === info.dateKey;
    default: return false;
  }
}

// Rotinas com mais de um horário por checklist no mesmo dia (ex.: conferência
// de caixa 3x/dia, em vez de só 1x). "occurrenceTime" é a CHAVE gravada em
// routine_responses.occurrence_time — fica "" (mesmo valor de TODAS as
// respostas históricas, e o default da coluna) sempre que o checklist só tem
// UMA ocorrência no dia (continuous, ou um scheduledTime só, sem
// scheduledTimes/com só 1 item), e só vira o horário real ("HH:MM") quando o
// checklist tem de fato mais de um horário configurado (scheduledTimes com
// 2+ itens). Isso garante que nenhum checklist/resposta existente muda de
// comportamento com esta feature — só quem tem múltiplos horários de verdade
// passa a "desdobrar" em várias ocorrências por dia.
export type ChecklistOccurrence = { occurrenceTime: string; time: string | null; minutes: number | null };

export function checklistOccurrences(
  c: Pick<RoutineChecklist, "recurrence" | "scheduledTime" | "scheduledTimes">,
): ChecklistOccurrence[] {
  if (c.recurrence === "continuous" || !c.scheduledTime) return [{ occurrenceTime: "", time: null, minutes: null }];
  const times = c.scheduledTimes && c.scheduledTimes.length ? c.scheduledTimes : [c.scheduledTime];
  const multi = times.length > 1;
  return times.map((t) => ({
    occurrenceTime: multi ? t : "",
    time: t,
    minutes: parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10),
  }));
}

export type UserRoutineContext = { storeId: number | null; sectorId: number | null; jobFunction: string | null; employeeId: number | null };

export async function resolveUserContext(tenantId: number, userId: number): Promise<UserRoutineContext> {
  const [user] = await db.select({ storeId: usersTable.storeId, sectorId: usersTable.sectorId })
    .from(usersTable).where(and(eq(usersTable.id, userId), eq(usersTable.tenantId, tenantId)));
  const [employee] = await db.select({ id: employeesTable.id, jobFunction: employeesTable.jobFunction })
    .from(employeesTable).where(and(eq(employeesTable.userId, userId), eq(employeesTable.tenantId, tenantId)));
  return {
    storeId: user?.storeId ?? null,
    sectorId: user?.sectorId ?? null,
    jobFunction: employee?.jobFunction ?? null,
    employeeId: employee?.id ?? null,
  };
}

// Uma regra "casa" se TODA dimensão preenchida bate (AND); dimensão nula na
// regra = coringa. O checklist se aplica ao usuário se QUALQUER regra casar
// (OR entre regras) — várias regras cobrem várias combinações de uma vez.
export function scopeMatchesUser(scope: RoutineChecklistScope, ctx: UserRoutineContext, userId: number): boolean {
  if (scope.storeId != null && scope.storeId !== ctx.storeId) return false;
  if (scope.sectorId != null && scope.sectorId !== ctx.sectorId) return false;
  if (scope.jobFunction != null && scope.jobFunction !== ctx.jobFunction) return false;
  if (scope.userId != null && scope.userId !== userId) return false;
  return true;
}

// Fase 5: compara o horário da resposta com a 1ª batida "in" do Ponto do
// funcionário no mesmo dia civil (São Paulo). Puro dado pro relatório
// mensal — nunca bloqueia nem penaliza (ver enforceMandatoryRoutines, que
// não usa nada disso). `employeeId` null (funcionário sem cadastro de Ponto
// vinculado) também cai em "sem_ponto_no_dia".
export async function computePontoRelative(
  tenantId: number, employeeId: number | null, dateKey: string, respondedAt: Date,
): Promise<"antes_entrada" | "depois_entrada" | "sem_ponto_no_dia"> {
  if (employeeId == null) return "sem_ponto_no_dia";
  const dayStart = new Date(`${dateKey}T00:00:00-03:00`);
  const dayEnd = new Date(`${dateKey}T23:59:59-03:00`);
  const [firstIn] = await db.select({ at: timeClockEntriesTable.at })
    .from(timeClockEntriesTable)
    .where(and(
      eq(timeClockEntriesTable.tenantId, tenantId), eq(timeClockEntriesTable.employeeId, employeeId),
      eq(timeClockEntriesTable.kind, "in"), gte(timeClockEntriesTable.at, dayStart), lte(timeClockEntriesTable.at, dayEnd),
    ))
    .orderBy(asc(timeClockEntriesTable.at))
    .limit(1);
  if (!firstIn) return "sem_ponto_no_dia";
  return respondedAt.getTime() < firstIn.at.getTime() ? "antes_entrada" : "depois_entrada";
}

export async function isOnLeaveToday(tenantId: number, employeeId: number | null, dateKey: string): Promise<boolean> {
  if (employeeId == null) return false;
  const [leave] = await db.select({ id: leaveRecordsTable.id }).from(leaveRecordsTable)
    .where(and(
      eq(leaveRecordsTable.tenantId, tenantId), eq(leaveRecordsTable.employeeId, employeeId),
      lte(leaveRecordsTable.startDate, dateKey), gte(leaveRecordsTable.endDate, dateKey),
    )).limit(1);
  return !!leave;
}
