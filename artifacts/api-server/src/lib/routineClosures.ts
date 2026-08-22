import {
  db, employeesTable, routineChecklistsTable, routineChecklistScopesTable,
  routineResponsesTable, routineUrgentBypassesTable, routineClosuresTable,
  type RoutineChecklist, type RoutineChecklistScope, type RoutineNoJustification,
} from "@workspace/db";
import { eq, and, gte, lte, isNotNull } from "drizzle-orm";
import { dateInfoFor, isDueToday, resolveUserContext, scopeMatchesUser, isOnLeaveToday } from "./routinesShared";
import { previousMonthKey, currentMonthKey } from "./timeBankClosures";
import { logger } from "./logger";

// Fechamento mensal de Rotinas e Produtividade (Fase 5): snapshot CONGELADO
// por funcionário e mês, mesmo padrão de timeBankClosures.ts (generateClosuresForMonth)
// — idempotente via índice único (tenantId, employeeId, periodMonth) +
// onConflictDoNothing, então rodar de novo pro mesmo mês é seguro.
//
// Recalcula retroativamente, dia a dia do mês, quais checklists estavam
// "devidos" pro funcionário (mesma lógica de escopo/recorrência de
// getPendingRoutines em rotinas.ts, mas pra uma data passada em vez de
// "agora" — ver routinesShared.ts) e cruza com o que foi de fato
// respondido. Não trava nem penaliza ninguém — é só relatório.

export { previousMonthKey, currentMonthKey };

function monthDayKeys(periodMonth: string): string[] {
  const [y, m] = periodMonth.split("-").map(Number);
  const lastDay = new Date(y!, m!, 0).getDate();
  return Array.from({ length: lastDay }, (_, i) => `${periodMonth}-${String(i + 1).padStart(2, "0")}`);
}

function monthRange(periodMonth: string): { from: Date; to: Date } {
  const [y, m] = periodMonth.split("-").map(Number);
  const lastDay = new Date(y!, m!, 0).getDate();
  return {
    from: new Date(`${periodMonth}-01T00:00:00-03:00`),
    to: new Date(`${periodMonth}-${String(lastDay).padStart(2, "0")}T23:59:59-03:00`),
  };
}

type TenantRoutineData = { checklists: RoutineChecklist[]; scopesByChecklist: Map<number, RoutineChecklistScope[]> };
const tenantDataCache = new Map<number, TenantRoutineData>();
async function getTenantRoutineData(tenantId: number): Promise<TenantRoutineData> {
  const cached = tenantDataCache.get(tenantId);
  if (cached) return cached;
  const checklists = await db.select().from(routineChecklistsTable)
    .where(and(eq(routineChecklistsTable.tenantId, tenantId), eq(routineChecklistsTable.active, true)));
  const scopes = await db.select().from(routineChecklistScopesTable).where(eq(routineChecklistScopesTable.tenantId, tenantId));
  const scopesByChecklist = new Map<number, RoutineChecklistScope[]>();
  for (const s of scopes) scopesByChecklist.set(s.checklistId, [...(scopesByChecklist.get(s.checklistId) ?? []), s]);
  const data = { checklists, scopesByChecklist };
  tenantDataCache.set(tenantId, data);
  return data;
}

function hasPendency(val: string | RoutineNoJustification): boolean {
  return typeof val === "object" && !!val.pendencia;
}

export async function generateRoutineClosuresForMonth(periodMonth: string, tenantId?: number): Promise<number> {
  tenantDataCache.clear();
  const employees = tenantId != null
    ? await db.select().from(employeesTable).where(and(eq(employeesTable.tenantId, tenantId), isNotNull(employeesTable.userId)))
    : await db.select().from(employeesTable).where(isNotNull(employeesTable.userId));

  const days = monthDayKeys(periodMonth);
  const { from: monthStart, to: monthEnd } = monthRange(periodMonth);
  let created = 0;

  for (const emp of employees) {
    if (emp.userId == null) continue;
    try {
      const { checklists, scopesByChecklist } = await getTenantRoutineData(emp.tenantId);
      const ctx = await resolveUserContext(emp.tenantId, emp.userId);

      const responses = await db.select({
        checklistId: routineResponsesTable.checklistId, periodKey: routineResponsesTable.periodKey,
        createdAt: routineResponsesTable.createdAt, answers: routineResponsesTable.answers,
        respondedRelativeToPonto: routineResponsesTable.respondedRelativeToPonto,
      }).from(routineResponsesTable).where(and(
        eq(routineResponsesTable.tenantId, emp.tenantId), eq(routineResponsesTable.userId, emp.userId),
        gte(routineResponsesTable.periodKey, days[0]!), lte(routineResponsesTable.periodKey, days[days.length - 1]!),
      ));
      const responseByKey = new Map(responses.map((r) => [`${r.checklistId}:${r.periodKey}`, r]));

      let totalDue = 0, totalAnswered = 0, totalOnTime = 0, totalWithPendency = 0;
      let pontoBeforeEntry = 0, pontoAfterEntry = 0, pontoNoRecord = 0;

      for (const dateKey of days) {
        const info = dateInfoFor(new Date(`${dateKey}T12:00:00-03:00`)); // meio-dia evita risco de virada de fuso
        if (await isOnLeaveToday(emp.tenantId, ctx.employeeId, dateKey)) continue;
        for (const c of checklists) {
          if (!isDueToday(c, info)) continue;
          const scopes = scopesByChecklist.get(c.id) ?? [];
          if (!scopes.some((s) => scopeMatchesUser(s, ctx, emp.userId!))) continue;
          totalDue++;

          const resp = responseByKey.get(`${c.id}:${dateKey}`);
          if (!resp) continue;
          totalAnswered++;

          if (c.recurrence === "continuous" || !c.scheduledTime) {
            totalOnTime++; // sem horário fixo — qualquer resposta no dia conta como "no prazo"
          } else {
            const scheduled = new Date(`${dateKey}T${c.scheduledTime}:00-03:00`);
            const deadline = new Date(scheduled.getTime() + c.toleranceMinutes * 60_000);
            if (resp.createdAt.getTime() <= deadline.getTime()) totalOnTime++;
          }

          if (Object.values(resp.answers).some(hasPendency)) totalWithPendency++;
          if (resp.respondedRelativeToPonto === "antes_entrada") pontoBeforeEntry++;
          else if (resp.respondedRelativeToPonto === "depois_entrada") pontoAfterEntry++;
          else if (resp.respondedRelativeToPonto === "sem_ponto_no_dia") pontoNoRecord++;
        }
      }

      const bypasses = await db.select({ id: routineUrgentBypassesTable.id })
        .from(routineUrgentBypassesTable)
        .where(and(
          eq(routineUrgentBypassesTable.tenantId, emp.tenantId), eq(routineUrgentBypassesTable.userId, emp.userId),
          gte(routineUrgentBypassesTable.createdAt, monthStart), lte(routineUrgentBypassesTable.createdAt, monthEnd),
        ));

      const inserted = await db.insert(routineClosuresTable).values({
        tenantId: emp.tenantId, employeeId: emp.id, employeeName: emp.name, periodMonth,
        totalDue, totalAnswered, totalOnTime, totalWithPendency, totalUrgentBypass: bypasses.length,
        pontoBeforeEntry, pontoAfterEntry, pontoNoRecord,
      })
        .onConflictDoNothing({ target: [routineClosuresTable.tenantId, routineClosuresTable.employeeId, routineClosuresTable.periodMonth] })
        .returning({ id: routineClosuresTable.id });
      if (inserted.length > 0) created++;
    } catch (err) {
      logger.warn({ err, employeeId: emp.id, periodMonth }, "Falha ao fechar Rotinas e Produtividade do colaborador");
    }
  }
  return created;
}

// ── Tick automático — mesmo espírito de closeMonthlyTimeBanks: fecha o mês
// anterior a cada execução, idempotente (pula quem já está fechado). ──
let closureRunning = false;
export async function closeMonthlyRoutines(now: Date = new Date()): Promise<void> {
  if (closureRunning) return;
  closureRunning = true;
  try {
    const m = previousMonthKey(now);
    const created = await generateRoutineClosuresForMonth(m);
    if (created > 0) logger.info({ month: m, created }, "Fechamento mensal de Rotinas e Produtividade gerado automaticamente");
  } catch (err) {
    logger.warn({ err }, "Tick de fechamento mensal de Rotinas e Produtividade falhou");
  } finally {
    closureRunning = false;
  }
}
