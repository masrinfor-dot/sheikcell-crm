import { db, tasksTable, taskAssigneesTable, taskRemindersTable } from "@workspace/db";
import { eq, and, ne, isNotNull } from "drizzle-orm";
import { broadcast } from "./sseEmitter";
import { logger } from "./logger";

// Lembrete DIÁRIO de tarefas pendentes/prazos (pedido 10/09: "informa o
// setor responsável com alertas automáticos todos os dias lembrando de
// tarefas pendentes e prazos também") — complementa o lembrete pontual de
// compromisso (taskReminders.ts, que dispara uma única vez perto do horário
// marcado via alertMinutesBefore). Este roda todo dia pra toda tarefa aberta
// (não concluída/arquivada) com prazo atrasado ou vencendo nas próximas 24h:
// - Persiste um lembrete em task_reminders por responsável (sobrevive
//   offline, mesma tabela/mecanismo do lembrete pontual, só dedupeKey com
//   sufixo ":daily:YYYY-MM-DD" pra não repetir no mesmo dia mesmo rodando o
//   tick várias vezes).
// - Avisa o setor inteiro em tempo real por SSE (quem estiver com o quadro
//   aberto vê na hora, admin/supervisor do setor incluso pela semântica do
//   broadcast por sectorId) — não persistido por pessoa do setor todo pra
//   não explodir linhas em setor grande; quem não está online recebe pela
//   linha de responsável acima.
function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

async function createDailyReminder(params: {
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

export async function generateDailyTaskDigest(): Promise<number> {
  const now = new Date();
  const key = todayKey();
  let created = 0;

  const candidates = await db.select().from(tasksTable).where(and(
    eq(tasksTable.isArchived, false),
    ne(tasksTable.status, "done"),
    isNotNull(tasksTable.dueDate),
  ));

  for (const t of candidates) {
    try {
      const dueDate = t.dueDate!;
      // Só entra no lembrete diário quem está atrasado ou vence nas próximas
      // 24h — tarefa com prazo distante não precisa incomodar todo dia.
      if (dueDate.getTime() - now.getTime() > 24 * 60 * 60_000) continue;

      const overdue = dueDate.getTime() < now.getTime();
      const title = overdue ? `Atrasada: ${t.title}` : `Vence hoje: ${t.title}`;

      const assigneeRows = await db.select({ userId: taskAssigneesTable.userId }).from(taskAssigneesTable)
        .where(eq(taskAssigneesTable.taskId, t.id));
      const recipients = new Set(assigneeRows.map((a) => a.userId));
      if (t.createdById != null) recipients.add(t.createdById);

      for (const recipientUserId of recipients) {
        const ok = await createDailyReminder({
          tenantId: t.tenantId, taskId: t.id, recipientUserId, title, dueDate,
          dedupeKey: `${recipientUserId}:${t.id}:daily:${key}`,
        });
        if (ok) created++;
      }

      // Aviso em tempo real pro setor responsável inteiro.
      if (t.sectorId != null) {
        broadcast("task_daily_digest", { taskId: t.id, title, dueDate: dueDate.toISOString(), overdue, sectorId: t.sectorId },
          { tenantId: t.tenantId, sectorId: t.sectorId, restrictedTo: null });
      }
    } catch (err) {
      logger.warn({ err, taskId: t.id }, "Falha ao gerar lembrete diário de tarefa pendente");
    }
  }

  return created;
}

let running = false;
export async function runDailyTaskDigest(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const created = await generateDailyTaskDigest();
    if (created > 0) logger.info({ created }, "Lembretes diários de tarefas pendentes gerados");
  } catch (err) {
    logger.warn({ err }, "Tick de lembrete diário de tarefas falhou");
  } finally {
    running = false;
  }
}
