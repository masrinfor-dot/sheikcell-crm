import {
  db, routineChecklistsTable, routineChecklistScopesTable, routineResponsesTable, routineAlertsTable,
  employeesTable, usersTable,
} from "@workspace/db";
import { eq, and, isNotNull } from "drizzle-orm";
import { todayInfo, isDueToday, resolveUserContext, scopeMatchesUser, isOnLeaveToday, checklistOccurrences } from "./routinesShared";
import { broadcast } from "./sseEmitter";
import { logger } from "./logger";

// Fase 7: alerta automático pro gestor da loja — dois gatilhos:
//  1) checklist obrigatório com horário fixo, prazo (scheduledTime +
//     toleranceMinutes) já vencido hoje, ainda sem resposta;
//  2) resposta de hoje com pergunta alertLevel="critico" respondida
//     negativamente.
// Job periódico (não em tempo real — ver scheduler.ts), idempotente por
// dedupeKey (onConflictDoNothing, mesmo espírito do fechamento mensal).
// Entrega: linha persistida em routine_alerts (funciona mesmo com o gestor
// offline) + broadcast SSE pro mesmo canal em tempo real já usado pelo
// resto do sistema (sseEmitter.ts), restrito ao(s) destinatário(s).

const NEGATIVE_ANSWER: Record<string, string> = { yes_no: "Não", done_not_done: "Não executado" };

async function recipientsForStore(tenantId: number, storeId: number | null): Promise<number[]> {
  const supervisors = storeId != null
    ? await db.select({ id: usersTable.id }).from(usersTable)
        .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.role, "supervisor"), eq(usersTable.storeId, storeId)))
    : [];
  if (supervisors.length) return supervisors.map((s) => s.id);
  // Sem gerente cadastrado nessa loja (ou funcionário sem loja) — cai pros
  // admins do tenant, pra não perder o alerta no vácuo.
  const admins = await db.select({ id: usersTable.id }).from(usersTable)
    .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.role, "admin")));
  return admins.map((a) => a.id);
}

async function createAlert(params: {
  tenantId: number; recipientUserId: number; employeeUserId: number; employeeName: string;
  checklistId: number; checklistName: string; kind: "atraso" | "critico"; message: string; dedupeKey: string;
}): Promise<boolean> {
  const [inserted] = await db.insert(routineAlertsTable).values(params)
    .onConflictDoNothing({ target: routineAlertsTable.dedupeKey })
    .returning({ id: routineAlertsTable.id });
  if (!inserted) return false;
  broadcast("routine_alert", { kind: params.kind, employeeName: params.employeeName, checklistName: params.checklistName, message: params.message },
    { tenantId: params.tenantId, restrictedTo: [params.recipientUserId] });
  return true;
}

export async function generateRoutineAlerts(): Promise<number> {
  const info = todayInfo();
  let created = 0;

  // ── Gatilho 1: atraso ────────────────────────────────────────────────
  // Rotinas com mais de um horário por dia: cada ocorrência atrasada gera
  // seu próprio alerta (dedupeKey inclui o horário só quando o checklist
  // tem de fato múltiplos horários — occurrenceTime="" pro caso de horário
  // único mantém o dedupeKey idêntico a antes, nenhum alerta duplica).
  const mandatoryChecklists = await db.select().from(routineChecklistsTable)
    .where(and(eq(routineChecklistsTable.active, true), eq(routineChecklistsTable.mandatory, true)));

  for (const c of mandatoryChecklists) {
    if (c.recurrence === "continuous" || !c.scheduledTime) continue; // sem horário fixo, não "atrasa"
    if (!isDueToday(c, info)) continue;
    const lateOccs = checklistOccurrences(c).filter((occ) => occ.minutes != null && info.nowMinutes > occ.minutes + c.toleranceMinutes);
    if (!lateOccs.length) continue;

    try {
      const scopes = await db.select().from(routineChecklistScopesTable).where(eq(routineChecklistScopesTable.checklistId, c.id));
      if (!scopes.length) continue;
      const employees = await db.select().from(employeesTable)
        .where(and(eq(employeesTable.tenantId, c.tenantId), isNotNull(employeesTable.userId)));
      for (const emp of employees) {
        if (!emp.userId) continue;
        const ctx = await resolveUserContext(c.tenantId, emp.userId);
        if (!scopes.some((s) => scopeMatchesUser(s, ctx, emp.userId!))) continue;
        if (await isOnLeaveToday(c.tenantId, ctx.employeeId, info.dateKey)) continue;

        for (const occ of lateOccs) {
          const [resp] = await db.select({ id: routineResponsesTable.id }).from(routineResponsesTable)
            .where(and(
              eq(routineResponsesTable.tenantId, c.tenantId), eq(routineResponsesTable.checklistId, c.id),
              eq(routineResponsesTable.userId, emp.userId), eq(routineResponsesTable.periodKey, info.dateKey),
              eq(routineResponsesTable.occurrenceTime, occ.occurrenceTime),
            ));
          if (resp) continue;

          const recipients = await recipientsForStore(c.tenantId, ctx.storeId);
          for (const recipientUserId of recipients) {
            const ok = await createAlert({
              tenantId: c.tenantId, recipientUserId, employeeUserId: emp.userId, employeeName: emp.name,
              checklistId: c.id, checklistName: c.name, kind: "atraso",
              message: `${emp.name} não respondeu "${c.name}"${occ.occurrenceTime ? ` (${occ.occurrenceTime})` : ""} dentro do prazo hoje.`,
              dedupeKey: `${recipientUserId}:${emp.userId}:${c.id}:atraso:${info.dateKey}${occ.occurrenceTime ? `:${occ.occurrenceTime}` : ""}`,
            });
            if (ok) created++;
          }
        }
      }
    } catch (err) {
      logger.warn({ err, checklistId: c.id }, "Falha ao gerar alerta de atraso de Rotinas");
    }
  }

  // ── Gatilho 2: pendência crítica ─────────────────────────────────────
  const todayResponses = await db.select().from(routineResponsesTable).where(eq(routineResponsesTable.periodKey, info.dateKey));
  for (const r of todayResponses) {
    try {
      for (const q of r.questionsSnapshot) {
        if (q.alertLevel !== "critico") continue;
        const val = r.answers[q.id];
        const answerValue = typeof val === "object" && val ? val.value : val;
        if (answerValue !== NEGATIVE_ANSWER[q.type]) continue;

        const ctx = await resolveUserContext(r.tenantId, r.userId);
        const [emp] = ctx.employeeId != null
          ? await db.select({ name: employeesTable.name }).from(employeesTable).where(eq(employeesTable.id, ctx.employeeId))
          : [];
        const [checklist] = await db.select({ name: routineChecklistsTable.name }).from(routineChecklistsTable)
          .where(eq(routineChecklistsTable.id, r.checklistId));
        const employeeName = emp?.name ?? "Funcionário";
        const checklistName = checklist?.name ?? "Checklist";

        const recipients = await recipientsForStore(r.tenantId, ctx.storeId);
        for (const recipientUserId of recipients) {
          const ok = await createAlert({
            tenantId: r.tenantId, recipientUserId, employeeUserId: r.userId, employeeName,
            checklistId: r.checklistId, checklistName, kind: "critico",
            message: `${employeeName} respondeu "${q.label}" como pendência crítica em "${checklistName}".`,
            dedupeKey: `${recipientUserId}:${r.userId}:${r.checklistId}:critico:${q.id}:${info.dateKey}`,
          });
          if (ok) created++;
        }
      }
    } catch (err) {
      logger.warn({ err, responseId: r.id }, "Falha ao gerar alerta crítico de Rotinas");
    }
  }

  return created;
}

let alertsRunning = false;
export async function runRoutineAlerts(): Promise<void> {
  if (alertsRunning) return;
  alertsRunning = true;
  try {
    const created = await generateRoutineAlerts();
    if (created > 0) logger.info({ created }, "Alertas automáticos de Rotinas e Produtividade gerados");
  } catch (err) {
    logger.warn({ err }, "Tick de alertas de Rotinas e Produtividade falhou");
  } finally {
    alertsRunning = false;
  }
}
