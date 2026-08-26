import { db, tasksTable, taskAssigneesTable, taskRemindersTable } from "@workspace/db";
import { eq, and, ne, isNotNull } from "drizzle-orm";
import { broadcast } from "./sseEmitter";
import { logger } from "./logger";

// Agenda (Quadro de Tarefas): lembrete automático de compromisso — dispara
// quando faltam `alertMinutesBefore` minutos para o dueDate de uma tarefa
// não concluída. Job periódico (não em tempo real — ver scheduler.ts),
// idempotente por dedupeKey (onConflictDoNothing, mesmo padrão do alerta de
// Rotinas em routineAlerts.ts). Entrega: linha persistida em task_reminders
// (funciona mesmo com o usuário offline) + broadcast SSE em tempo real
// (sseEmitter.ts), restrito ao(s) destinatário(s).

async function createReminder(params: {
  tenantId: number; taskId: number; recipientUserId: number; title: string; dueDate: Date; dedupeKey: string;
}): Promise<boolean> {
  const [inserted] = await db.insert(taskRemindersTable).values(params)
    .onConflictDoNothing({ target: taskRemindersTable.dedupeKey })
    .returning({ id: taskRemindersTable.id });
  if (!inserted) return false;
  broadcast("task_reminder", { taskId: params.taskId, title: params.title, dueDate: params.dueDate.toISOString() },
    { tenantId: params.tenantId, restrictedTo: [params.recipientUserId] });
  return true;
}

export async function generateTaskReminders(): Promise<number> {
  const now = new Date();
  let created = 0;

  const candidates = await db.select().from(tasksTable).where(and(
    eq(tasksTable.isArchived, false),
    ne(tasksTable.status, "done"),
    isNotNull(tasksTable.dueDate),
    isNotNull(tasksTable.alertMinutesBefore),
  ));

  for (const t of candidates) {
    try {
      const dueDate = t.dueDate!;
      const triggerAt = new Date(dueDate.getTime() - (t.alertMinutesBefore ?? 0) * 60_000);
      if (now < triggerAt) continue;
      // Já passou muito do horário (mais de 24h) — isso é atraso, não é mais
      // um "lembrete" a tempo, então não dispara (evita alerta velho inútil
      // reaparecendo pra sempre numa tarefa esquecida há dias).
      if (now.getTime() - dueDate.getTime() > 24 * 60 * 60_000) continue;

      const assigneeRows = await db.select({ userId: taskAssigneesTable.userId }).from(taskAssigneesTable)
        .where(eq(taskAssigneesTable.taskId, t.id));
      const recipients = new Set(assigneeRows.map((a) => a.userId));
      if (t.createdById != null) recipients.add(t.createdById);
      if (recipients.size === 0) continue;

      for (const recipientUserId of recipients) {
        const ok = await createReminder({
          tenantId: t.tenantId, taskId: t.id, recipientUserId, title: t.title, dueDate,
          dedupeKey: `${recipientUserId}:${t.id}:reminder`,
        });
        if (ok) created++;
      }
    } catch (err) {
      logger.warn({ err, taskId: t.id }, "Falha ao gerar lembrete de compromisso da Agenda");
    }
  }

  return created;
}

let running = false;
export async function runTaskReminders(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const created = await generateTaskReminders();
    if (created > 0) logger.info({ created }, "Lembretes de compromisso da Agenda gerados");
  } catch (err) {
    logger.warn({ err }, "Tick de lembretes da Agenda falhou");
  } finally {
    running = false;
  }
}
