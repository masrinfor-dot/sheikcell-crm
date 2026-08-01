import { createHmac } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import {
  db,
  conversationsTable,
  messagesTable,
  scheduledMessagesTable,
  tasksTable,
} from "@workspace/db";
import { broadcast } from "./sseEmitter";
import { isPotentialConversation, restrictedRecipients } from "./conversationScope";
import { logger } from "./logger";

let running = false;

/**
 * Roda a cada tick: envia as mensagens agendadas cujo horário chegou.
 * - kind "mensagem": grava a mensagem na conversa, avisa via SSE e encaminha ao
 *   bridge do WhatsApp (mesmo caminho do envio manual). Marca a tarefa espelho
 *   como concluída.
 * - kind "retorno": nada é enviado ao cliente — no horário, o vendedor
 *   responsável recebe um aviso em tempo real (evento SSE "schedule_due") na
 *   Central de Atendimento, e o agendamento vira "done" para sair dos pendentes.
 * - envio agendado que falhar: além de marcar a mensagem como "failed", avisa o
 *   autor via SSE ("schedule_failed") para que a falha não passe despercebida.
 * Nunca lança: falha em um agendamento não pode derrubar o servidor nem os demais.
 */
export async function deliverScheduledMessages(): Promise<void> {
  if (running) return; // evita ticks sobrepostos
  running = true;
  try {
    const due = await db.select().from(scheduledMessagesTable)
      .where(and(
        eq(scheduledMessagesTable.status, "pending"),
        lte(scheduledMessagesTable.sendAt, new Date()),
      ))
      .limit(20);

    for (const item of due) {
      try {
        // Reivindica a linha de forma atômica (pending → processing): se outro
        // processo já pegou — ou o usuário cancelou nesse meio-tempo — pula.
        const [claimed] = await db.update(scheduledMessagesTable)
          .set({ status: "processing" })
          .where(and(
            eq(scheduledMessagesTable.id, item.id),
            eq(scheduledMessagesTable.status, "pending"),
          )).returning();
        if (!claimed) continue;

        if (item.kind !== "mensagem") {
          await db.update(scheduledMessagesTable).set({ status: "done" })
            .where(eq(scheduledMessagesTable.id, item.id));
          // Aviso em tempo real ao vendedor responsável: chegou a hora do
          // retorno ao cliente. Direcionado ao autor do agendamento (admin e
          // supervisor do setor também recebem, pela semântica de restrictedTo).
          const [rConv] = await db.select().from(conversationsTable)
            .where(eq(conversationsTable.id, item.conversationId)).limit(1);
          if (rConv) {
            broadcast("schedule_due", {
              scheduledId: item.id,
              kind: "retorno",
              conversationId: rConv.id,
              convName: rConv.name,
              content: item.content,
              sendAt: item.sendAt,
            }, {
              tenantId: rConv.tenantId,
              sectorId: rConv.sectorId,
              isPotential: false,
              restrictedTo: item.createdById != null ? [item.createdById] : null,
            });
          }
          continue;
        }

        const [conv] = await db.select().from(conversationsTable)
          .where(eq(conversationsTable.id, item.conversationId)).limit(1);
        if (!conv) {
          await db.update(scheduledMessagesTable).set({ status: "failed" })
            .where(eq(scheduledMessagesTable.id, item.id));
          continue;
        }

        const [msg] = await db.insert(messagesTable).values({
          tenantId: conv.tenantId,
          conversationId: conv.id,
          content: item.content,
          direction: "outbound",
          type: "text",
          status: "sent",
          senderName: "Mensagem agendada",
        }).returning();

        await db.update(conversationsTable).set({
          lastMessage: item.content,
          lastMessageDirection: "outbound",
          lastMessageAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(conversationsTable.id, conv.id));

        broadcast("message", { conversationId: conv.id, message: msg },
          { tenantId: conv.tenantId, sectorId: conv.sectorId, isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv) });

        // Encaminha ao WhatsApp (mesma rota do envio manual)
        let delivered = true;
        if (conv.channel === "whatsapp" && conv.phone) {
          const bridgeUrl = process.env["WHATSAPP_BRIDGE_URL"] ?? "http://localhost:3002";
          const bridgeSecret = createHmac(
            "sha256",
            process.env["SESSION_SECRET"] ?? "sheikcell-dev-only-secret",
          ).update("whatsapp-bridge-v1").digest("hex");
          try {
            const r = await fetch(`${bridgeUrl}/whatsapp/send`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Bridge-Secret": bridgeSecret },
              body: JSON.stringify({ to: conv.phone, text: item.content, session: conv.sessionKey }),
              signal: AbortSignal.timeout(60_000),
            });
            if (!r.ok) delivered = false;
          } catch {
            delivered = false;
          }
          if (!delivered && msg) {
            const [failedMsg] = await db.update(messagesTable).set({ status: "failed" })
              .where(eq(messagesTable.id, msg.id)).returning();
            if (failedMsg) {
              broadcast("message_updated", { conversationId: conv.id, message: failedMsg },
                { tenantId: conv.tenantId, sectorId: conv.sectorId, isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv) });
            }
            // Aviso direcionado ao autor: o envio agendado falhou (ex.: WhatsApp
            // despareado). Sem isso, a falha só apareceria abrindo a conversa.
            broadcast("schedule_failed", {
              scheduledId: item.id,
              kind: "mensagem",
              conversationId: conv.id,
              convName: conv.name,
              content: item.content,
              sendAt: item.sendAt,
            }, {
              tenantId: conv.tenantId,
              sectorId: conv.sectorId,
              isPotential: false,
              restrictedTo: item.createdById != null ? [item.createdById] : null,
            });
          }
        }

        await db.update(scheduledMessagesTable)
          .set({ status: delivered ? "sent" : "failed" })
          .where(eq(scheduledMessagesTable.id, item.id));

        // Conclui a tarefa espelho no quadro
        if (item.taskId != null && delivered) {
          await db.update(tasksTable).set({ status: "done", updatedAt: new Date() })
            .where(eq(tasksTable.id, item.taskId));
        }
      } catch (err) {
        logger.warn({ err, scheduledId: item.id }, "Falha ao processar mensagem agendada");
        await db.update(scheduledMessagesTable).set({ status: "failed" })
          .where(eq(scheduledMessagesTable.id, item.id)).catch(() => {});
      }
    }
  } catch (err) {
    logger.warn({ err }, "Tick de mensagens agendadas falhou");
  } finally {
    running = false;
  }
}

export function startScheduler(): void {
  setInterval(() => { void deliverScheduledMessages(); }, 30_000);
  // Sorteios recorrentes: checa a cada 5 minutos (roda no dia certo, após as 10h).
  setInterval(() => {
    void import("../routes/raffles").then((m) => m.runDueRaffles()).catch(() => {});
  }, 5 * 60_000);
  logger.info("Agendador de mensagens iniciado (tick 30s)");
}
