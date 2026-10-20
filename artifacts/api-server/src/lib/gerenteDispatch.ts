// Gerente IA → equipe: tarefa delegada pelo dono vai pelo WhatsApp do
// vendedor (telefone do cadastro do RH, colaborador vinculado ao usuário).
// O vendedor confirma respondendo "feito" + foto (prova): a foto vira
// comentário da tarefa no quadro, a tarefa fecha e o dono é avisado.
//
// Só intercepta mensagens do vendedor que sejam confirmação ("feito",
// "pronto", "concluído" — com ou sem número da tarefa) ou a foto logo depois
// de um "feito". Qualquer outra mensagem dele segue o fluxo normal.
import { and, eq, desc, inArray, isNull, lt, gte, ne } from "drizzle-orm";
import {
  db, gerenteTaskDispatchesTable, employeesTable, tasksTable, taskCommentsTable, whatsappSessionsTable,
} from "@workspace/db";
import { normalizePhone } from "./phone";
import { sendRawWhatsAppText } from "./outbound";
import { logger } from "./logger";
import { fmtWhen, norm } from "./gerenteRules";

const OPEN = ["enviada", "aguardando_prova"];
const PROOF_WINDOW_MS = 2 * 3_600_000;

async function sellerPhone(tenantId: number, userId: number): Promise<string | null> {
  const [e] = await db.select({ phone: employeesTable.phone }).from(employeesTable)
    .where(and(eq(employeesTable.tenantId, tenantId), eq(employeesTable.userId, userId), eq(employeesTable.isActive, true)))
    .limit(1);
  const p = normalizePhone(e?.phone ?? "");
  return p && p.length >= 12 ? p : null;
}

/** Linha por onde as tarefas saem: a última que o dono usou; senão a 1ª conectada. */
async function pickLine(tenantId: number, preferred: string | null): Promise<string[]> {
  const rows = await db.select({ sessionKey: whatsappSessionsTable.sessionKey }).from(whatsappSessionsTable)
    .where(and(eq(whatsappSessionsTable.tenantId, tenantId), eq(whatsappSessionsTable.status, "connected")));
  const keys = rows.map((r) => r.sessionKey);
  return preferred ? [preferred, ...keys.filter((k) => k !== preferred)] : keys;
}

async function sendVia(phone: string, lines: string[], text: string): Promise<string | null> {
  for (const k of lines) if (await sendRawWhatsAppText(phone, k, text)) return k;
  return null;
}

/**
 * Envia a tarefa ao WhatsApp do responsável. Devolve uma linha curta pra
 * resposta ao dono (enviada / sem telefone / falhou). Nunca lança.
 */
export async function dispatchTaskToSeller(tenantId: number, p: {
  taskId: number; userId: number; assigneeName: string; title: string; dueAt: Date | null; priority: string; ownerSessionKey: string | null;
}): Promise<string> {
  try {
    const phone = await sellerPhone(tenantId, p.userId);
    if (!phone) {
      await db.insert(gerenteTaskDispatchesTable).values({ tenantId, taskId: p.taskId, userId: p.userId, assigneeName: p.assigneeName, status: "sem_telefone" });
      return `⚠️ ${p.assigneeName.split(" ")[0]} não tem WhatsApp no cadastro do RH — a tarefa ficou só no quadro.`;
    }
    const first = p.assigneeName.split(" ")[0];
    const text = [
      `📋 *Nova tarefa${p.priority === "alta" ? " (URGENTE)" : ""}*`,
      `Olá, ${first}! ${p.title}`,
      p.dueAt ? `⏰ Prazo: ${fmtWhen(p.dueAt)}` : null,
      "",
      `Quando terminar, responda *feito ${p.taskId}* e mande uma *foto* como prova. 📸`,
    ].filter((l) => l !== null).join("\n");
    const used = await sendVia(phone, await pickLine(tenantId, p.ownerSessionKey), text);
    await db.insert(gerenteTaskDispatchesTable).values({
      tenantId, taskId: p.taskId, userId: p.userId, assigneeName: p.assigneeName, phone,
      sessionKey: used, status: used ? "enviada" : "falhou", sentAt: used ? new Date() : null,
    });
    return used ? `📲 Enviada no WhatsApp de ${first}. Aviso quando ele mandar a prova.` : `⚠️ Não consegui enviar no WhatsApp de ${first} (linha desconectada?). A tarefa está no quadro.`;
  } catch (err) {
    logger.warn({ err, tenantId }, "Gerente IA: falha ao enviar tarefa ao vendedor");
    return "⚠️ Não consegui enviar a tarefa pelo WhatsApp; ela está no quadro.";
  }
}

async function notifyOwnerText(tenantId: number, text: string): Promise<void> {
  const { notifyOwnerByTenant } = await import("./gerente");
  await notifyOwnerByTenant(tenantId, text);
}

async function conclude(d: typeof gerenteTaskDispatchesTable.$inferSelect, proofUrl: string, note: string | null): Promise<void> {
  const now = new Date();
  await db.update(gerenteTaskDispatchesTable).set({ status: "concluida", doneAt: now, proofUrl, proofNote: note })
    .where(eq(gerenteTaskDispatchesTable.id, d.id));
  await db.update(tasksTable).set({ status: "done", updatedAt: now })
    .where(and(eq(tasksTable.id, d.taskId), eq(tasksTable.tenantId, d.tenantId)));
  await db.insert(taskCommentsTable).values({
    tenantId: d.tenantId, taskId: d.taskId, authorId: d.userId,
    content: `✅ Concluída pelo WhatsApp${note ? `: ${note}` : ""} (prova em foto)`, mediaUrl: proofUrl, mediaType: "image",
  });
  const [task] = await db.select({ title: tasksTable.title }).from(tasksTable).where(eq(tasksTable.id, d.taskId)).limit(1);
  await notifyOwnerText(d.tenantId, `✅ *${d.assigneeName.split(" ")[0]} concluiu:* ${task?.title ?? `tarefa ${d.taskId}`}\n📸 Prova anexada na tarefa (CRM → Tarefas / Gerente IA → Meu dia).`);
}

/**
 * Confirmação de tarefa pelo vendedor. true = mensagem consumida (não vira
 * atendimento). Só consome o que é claramente confirmação/prova.
 */
export async function tryConsumeTaskProof(input: {
  tenantId: number; sessionKey: string; phone: string; text: string; msgType: string; mediaUrl: string | null;
}): Promise<boolean> {
  try {
    const phone = normalizePhone(input.phone);
    if (!phone) return false;
    // Só tarefas ainda abertas no quadro (não arquivadas nem concluídas lá).
    const open = (await db.select({ d: gerenteTaskDispatchesTable }).from(gerenteTaskDispatchesTable)
      .innerJoin(tasksTable, eq(tasksTable.id, gerenteTaskDispatchesTable.taskId))
      .where(and(
        eq(gerenteTaskDispatchesTable.tenantId, input.tenantId), eq(gerenteTaskDispatchesTable.phone, phone),
        inArray(gerenteTaskDispatchesTable.status, OPEN), eq(tasksTable.isArchived, false), ne(tasksTable.status, "done"),
      )).orderBy(desc(gerenteTaskDispatchesTable.id)).limit(20)).map((r) => r.d);
    if (open.length === 0) return false;

    const t = norm(input.text);
    const done = t.match(/^(feito|pronto|concluido|conclui|finalizado|finalizei|terminei|ok feito)(?:\s*#?\s*(\d+))?\b(.*)$/);
    const reply = (msg: string) => sendRawWhatsAppText(phone, input.sessionKey, msg);

    // Foto: vale como prova se veio com "feito" na legenda OU logo depois de um "feito".
    if (input.msgType === "image" && input.mediaUrl) {
      let target: typeof open[number] | undefined;
      if (done) {
        const n = done[2] ? Number(done[2]) : null;
        target = n ? open.find((d) => d.taskId === n) : open.length === 1 ? open[0] : open.find((d) => d.status === "aguardando_prova");
      } else {
        target = open.find((d) => d.status === "aguardando_prova" && d.awaitingProofAt && Date.now() - d.awaitingProofAt.getTime() < PROOF_WINDOW_MS);
      }
      if (!target) return false; // foto comum: segue pro atendimento
      await conclude(target, input.mediaUrl, (done?.[3] ?? input.text).trim().slice(0, 300) || null);
      void reply(`✅ Recebido! Tarefa *${target.taskId}* concluída com a prova. Obrigado!`);
      return true;
    }

    if (!done) return false;
    const n = done[2] ? Number(done[2]) : null;
    const target = n ? open.find((d) => d.taskId === n) : open.length === 1 ? open[0] : undefined;
    if (!target) {
      const titles = await db.select({ id: tasksTable.id, title: tasksTable.title }).from(tasksTable)
        .where(inArray(tasksTable.id, open.map((d) => d.taskId)));
      void reply(`Qual tarefa você terminou? Responda *feito* + número:\n${titles.map((x) => `• ${x.id} — ${x.title}`).join("\n")}`);
      return true;
    }
    await db.update(gerenteTaskDispatchesTable).set({ status: "aguardando_prova", awaitingProofAt: new Date() })
      .where(eq(gerenteTaskDispatchesTable.id, target.id));
    void reply(`👍 Ótimo! Agora manda uma *foto* como prova da tarefa *${target.taskId}*. 📸`);
    return true;
  } catch (err) {
    logger.warn({ err, tenantId: input.tenantId }, "Gerente IA: falha ao tratar confirmação de tarefa");
    return false;
  }
}

/**
 * Job (1 min): tarefa enviada que passou do prazo sem prova → cobra o
 * vendedor uma vez e avisa o dono. Uma vez por tarefa.
 */
export async function runTaskOverdueChecks(tenantId: number): Promise<number> {
  const now = new Date();
  const rows = await db.select({ d: gerenteTaskDispatchesTable, title: tasksTable.title, dueDate: tasksTable.dueDate, taskStatus: tasksTable.status })
    .from(gerenteTaskDispatchesTable).innerJoin(tasksTable, eq(tasksTable.id, gerenteTaskDispatchesTable.taskId))
    .where(and(
      eq(gerenteTaskDispatchesTable.tenantId, tenantId), inArray(gerenteTaskDispatchesTable.status, OPEN),
      isNull(gerenteTaskDispatchesTable.overdueNotifiedAt), lt(tasksTable.dueDate, now),
      gte(tasksTable.dueDate, new Date(now.getTime() - 3 * 86_400_000)),
    )).limit(20);
  let n = 0;
  for (const r of rows) {
    if (r.taskStatus === "done") {
      await db.update(gerenteTaskDispatchesTable).set({ status: "concluida", doneAt: now }).where(eq(gerenteTaskDispatchesTable.id, r.d.id));
      continue;
    }
    await db.update(gerenteTaskDispatchesTable).set({ overdueNotifiedAt: now }).where(eq(gerenteTaskDispatchesTable.id, r.d.id));
    if (r.d.phone && r.d.sessionKey) {
      await sendRawWhatsAppText(r.d.phone, r.d.sessionKey, `⏰ A tarefa *${r.d.taskId} — ${r.title}* passou do prazo. Se já terminou, responda *feito ${r.d.taskId}* com a foto.`);
    }
    await notifyOwnerText(tenantId, `⚠️ *Atrasada:* ${r.title} — ${r.d.assigneeName.split(" ")[0]} ainda não mandou a prova.`);
    n++;
  }
  return n;
}
