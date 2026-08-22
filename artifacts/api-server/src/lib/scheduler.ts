import { createHmac } from "node:crypto";
import { and, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import {
  db,
  chatNotificationsTable,
  conversationsTable,
  messagesTable,
  scheduledMessagesTable,
  tasksTable,
} from "@workspace/db";
import { broadcast } from "./sseEmitter";
import { isPotentialConversation, restrictedRecipients } from "./conversationScope";
import { logger } from "./logger";
import { getSurveySettings, SURVEY_DEFAULTS, type SurveySettings } from "./surveySettings";
import { sendOutboundText } from "./outbound";
import { isSurveyReminderDue } from "./surveyReminderEligibility";

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
            // Persiste o aviso ANTES do broadcast: se o vendedor estiver
            // offline (ou fora do buffer de replay do SSE), o sino carrega o
            // não lido ao abrir a Central. Falha aqui não pode impedir o SSE.
            if (item.createdById != null) {
              await db.insert(chatNotificationsTable).values({
                tenantId: rConv.tenantId,
                userId: item.createdById,
                kind: "retorno",
                scheduledId: item.id,
                conversationId: rConv.id,
                convName: rConv.name,
                content: item.content,
              }).catch((err) => logger.warn({ err, scheduledId: item.id }, "Falha ao persistir aviso de retorno"));
            }
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
          lastMessageSenderName: "Mensagem agendada",
          lastMessageAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(conversationsTable.id, conv.id));

        broadcast("message", { conversationId: conv.id, message: msg },
          { tenantId: conv.tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv) });

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
                { tenantId: conv.tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv) });
            }
            // Aviso direcionado ao autor: o envio agendado falhou (ex.: WhatsApp
            // despareado). Sem isso, a falha só apareceria abrindo a conversa.
            // Persistido para sobreviver a vendedor offline (sino carrega depois).
            if (item.createdById != null) {
              await db.insert(chatNotificationsTable).values({
                tenantId: conv.tenantId,
                userId: item.createdById,
                kind: "failed",
                scheduledId: item.id,
                conversationId: conv.id,
                convName: conv.name,
                content: item.content,
              }).catch((err) => logger.warn({ err, scheduledId: item.id }, "Falha ao persistir aviso de falha de envio"));
            }
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

// ── Lembrete único da pesquisa de satisfação ─────────────────────────────────
// Cliente não respondeu a pesquisa? Um único lembrete é enviado depois de
// `reminderHours` (config por loja, padrão 24h), desde que a janela de
// resposta (retrato gravado no envio) ainda esteja aberta. O envio passa pelo
// mesmo caminho do envio manual (fila anti-ban do bridge). A conversa é
// reivindicada atomicamente (survey_reminder_sent_at IS NULL → agora), então
// nunca sai mais de um lembrete por atendimento — mesmo se o tick concorrer.
let remindersRunning = false;
export async function sendSurveyReminders(): Promise<void> {
  if (remindersRunning) return;
  remindersRunning = true;
  try {
    const now = Date.now();
    // Candidatas: pesquisa pendente, sem lembrete, enviada há pelo menos 1h
    // (piso do reminderHours) e com a janela do RETRATO ainda aberta — o prazo
    // gravado no envio é a autoridade (pesquisas antigas sem retrato ficam de
    // fora). O filtro fino por loja acontece abaixo.
    const candidates = await db.select().from(conversationsTable)
      .where(and(
        isNotNull(conversationsTable.pendingSurveyLogId),
        isNull(conversationsTable.surveyReminderSentAt),
        lte(conversationsTable.surveySentAt, new Date(now - 3_600_000)),
        isNotNull(conversationsTable.surveyWindowHours),
        sql`${conversationsTable.surveySentAt} + make_interval(hours => ${conversationsTable.surveyWindowHours}) > now()`,
      ))
      .limit(50);

    const cfgByTenant = new Map<number, SurveySettings>();
    for (const conv of candidates) {
      try {
        let cfg = cfgByTenant.get(conv.tenantId);
        if (!cfg) {
          cfg = await getSurveySettings(conv.tenantId).catch(() => ({ ...SURVEY_DEFAULTS }));
          cfgByTenant.set(conv.tenantId, cfg);
        }
        // Regras completas (fácil de desligar por loja, janela do retrato
        // autoritativa, só WhatsApp 1:1 etc.) na função pura testável.
        if (!isSurveyReminderDue(conv, cfg, now)) continue;

        // Reivindica ANTES de enviar: se o cliente respondeu nesse meio-tempo
        // (pendingSurveyLogId mudou/limpou) ou outro tick chegou primeiro, o
        // UPDATE não pega nenhuma linha e nada é enviado.
        const claimed = await db.update(conversationsTable)
          .set({ surveyReminderSentAt: new Date() })
          .where(and(
            eq(conversationsTable.id, conv.id),
            eq(conversationsTable.pendingSurveyLogId, conv.pendingSurveyLogId!),
            isNull(conversationsTable.surveyReminderSentAt),
          ))
          .returning({ id: conversationsTable.id });
        if (claimed.length === 0) continue;

        const scaleMax = conv.surveyScaleMax ?? cfg.scaleMax;
        const scaleMin = scaleMax === 10 ? 0 : 1;
        const text = `Oi! 👋 Ainda dá tempo de avaliar seu atendimento: de ${scaleMin} a ${scaleMax}, que nota você dá? (${scaleMax} = excelente)\n\nResponda apenas com o número. Obrigado! 🙏`;
        // Falhou o envio? O lembrete fica marcado mesmo assim — melhor perder o
        // lembrete do que arriscar mandar dois para o mesmo cliente.
        const delivered = await sendOutboundText(conv.id, text, "Pesquisa de satisfação (lembrete)");
        if (!delivered) logger.warn({ conversationId: conv.id }, "Lembrete de pesquisa não entregue pelo bridge");
      } catch (err) {
        logger.warn({ err, conversationId: conv.id }, "Falha ao processar lembrete de pesquisa");
      }
    }
  } catch (err) {
    logger.warn({ err }, "Tick de lembretes de pesquisa falhou");
  } finally {
    remindersRunning = false;
  }
}

export function startScheduler(): void {
  setInterval(() => { void deliverScheduledMessages(); }, 30_000);
  // Lembrete da pesquisa de satisfação: granularidade de minutos basta.
  setInterval(() => { void sendSurveyReminders(); }, 60_000);
  // Sorteios recorrentes: checa a cada 5 minutos (roda no dia certo, após as 10h).
  setInterval(() => {
    void import("../routes/raffles").then((m) => m.runDueRaffles()).catch(() => {});
  }, 5 * 60_000);
  // Mensalidades dos lojistas: garante que as cobranças do mês corrente
  // existam. Idempotente (não duplica), então rodar a cada hora é seguro e
  // cobre reinícios/quedas no dia 1º. Roda uma vez logo no boot também.
  void import("./saasBilling").then((m) => m.runMonthlyBilling()).catch(() => {});
  setInterval(() => {
    void import("./saasBilling").then((m) => m.runMonthlyBilling()).catch(() => {});
  }, 60 * 60_000);
  // Fechamento mensal do banco de horas (RH): fecha o mês anterior assim que
  // vira o mês. Idempotente, então rodar de novo a cada hora é seguro e
  // cobre o servidor estar fora do ar no dia 1º.
  void import("./timeBankClosures").then((m) => m.closeMonthlyTimeBanks()).catch(() => {});
  setInterval(() => {
    void import("./timeBankClosures").then((m) => m.closeMonthlyTimeBanks()).catch(() => {});
  }, 60 * 60_000);
  // Fechamento mensal de Rotinas e Produtividade (Fase 5): mesmo gatilho do
  // banco de horas acima — idempotente, então rodar de novo a cada hora é seguro.
  void import("./routineClosures").then((m) => m.closeMonthlyRoutines()).catch(() => {});
  setInterval(() => {
    void import("./routineClosures").then((m) => m.closeMonthlyRoutines()).catch(() => {});
  }, 60 * 60_000);
  // TV Box: garante as mensalidades do mês corrente (idempotente, mesmo
  // espírito da mensalidade das lojas acima) e dispara lembrete/cobrança.
  void import("./tvBoxBilling").then((m) => m.runTvBoxMonthlyBilling()).catch(() => {});
  setInterval(() => {
    void import("./tvBoxBilling").then((m) => m.runTvBoxMonthlyBilling()).catch(() => {});
  }, 60 * 60_000);
  setInterval(() => {
    void import("./tvBoxMessaging").then((m) => m.sendTvBoxReminders()).catch(() => {});
    void import("./tvBoxMessaging").then((m) => m.sendTvBoxCharges()).catch(() => {});
  }, 30 * 60_000);
  logger.info("Agendador de mensagens iniciado (tick 30s)");
}
