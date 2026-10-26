// "Retomar depois" (atendimento por canais, 26/10/2026): no horário combinado
// a conversa volta sozinha para "Responder agora" (a regra está em
// attendanceState.ts — é só comparação de horários) e aqui o responsável
// recebe o aviso do sino da Central (mesma notificação do "retorno" agendado).
// Se o cliente mandou mensagem antes do horário, o lembrete é cancelado.
import { and, eq, isNotNull, isNull, lte, notInArray, sql } from "drizzle-orm";
import { db, chatNotificationsTable, conversationsTable } from "@workspace/db";
import { broadcast } from "./sseEmitter";
import { isPotentialConversation, restrictedRecipients } from "./conversationScope";
import { logger } from "./logger";

let running = false;

function hhmm(d: Date): string {
  return d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export async function runSnoozeReminders(now = new Date()): Promise<number> {
  if (running) return 0;
  running = true;
  let sent = 0;
  try {
    const c = conversationsTable;
    // Lembretes cancelados pelo cliente (mandou mensagem depois de marcar):
    // limpa, pra não ficar "retomar" pendurado.
    await db.update(c).set({ snoozeUntil: null, snoozeSetAt: null, snoozedBy: null, snoozeNotifiedAt: null })
      .where(and(isNotNull(c.snoozeUntil), sql`${c.snoozeSetAt} < coalesce(${c.lastMessageAt}, 'epoch'::timestamptz)`));

    const due = await db.select().from(c)
      .where(and(
        isNotNull(c.snoozeUntil),
        lte(c.snoozeUntil, now),
        isNull(c.snoozeNotifiedAt),
        sql`${c.snoozeSetAt} >= coalesce(${c.lastMessageAt}, 'epoch'::timestamptz)`,
        notInArray(c.status, ["resolved", "archived"]),
        eq(c.isArchived, false),
      ))
      .limit(50);

    for (const conv of due) {
      try {
        // Reivindica (evita aviso em dobro com dois processos/ticks).
        const [claimed] = await db.update(c).set({ snoozeNotifiedAt: now, updatedAt: now })
          .where(and(eq(c.id, conv.id), isNull(c.snoozeNotifiedAt))).returning();
        if (!claimed) continue;
        const userId = claimed.assigneeId ?? claimed.snoozedBy;
        const content = `Retomar conversa — combinado para ${hhmm(claimed.snoozeUntil!)}`;
        let notificationId: number | null = null;
        if (userId != null) {
          const [n] = await db.insert(chatNotificationsTable).values({
            tenantId: claimed.tenantId,
            userId,
            kind: "retorno",
            conversationId: claimed.id,
            convName: claimed.name,
            content,
          }).returning({ id: chatNotificationsTable.id }).catch((err) => {
            logger.warn({ err, conversationId: claimed.id }, "Falha ao gravar aviso de retomar");
            return [] as { id: number }[];
          });
          notificationId = n?.id ?? null;
        }
        const restrictedTo = await restrictedRecipients(claimed);
        broadcast("conversation_updated", claimed, {
          tenantId: claimed.tenantId, sectorId: claimed.sectorId, sessionKey: claimed.sessionKey,
          isPotential: isPotentialConversation(claimed), restrictedTo,
        });
        broadcast("schedule_due", {
          scheduledId: null,
          notificationId,
          kind: "retorno",
          conversationId: claimed.id,
          convName: claimed.name,
          content,
          sendAt: claimed.snoozeUntil,
        }, {
          tenantId: claimed.tenantId,
          sectorId: claimed.sectorId,
          isPotential: false,
          restrictedTo: userId != null ? [userId] : restrictedTo,
        });
        sent++;
      } catch (err) {
        logger.warn({ err, conversationId: conv.id }, "Falha no lembrete de retomar conversa");
      }
    }
  } catch (err) {
    logger.warn({ err }, "Falha ao processar lembretes de retomar conversa");
  } finally {
    running = false;
  }
  return sent;
}
