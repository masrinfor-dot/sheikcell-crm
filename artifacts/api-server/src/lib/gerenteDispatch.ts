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
  db, gerenteTaskDispatchesTable, gerenteTeamPhonesTable, employeesTable, tasksTable, taskCommentsTable, whatsappSessionsTable,
} from "@workspace/db";
import { normalizePhone } from "./phone";
import { sendRawWhatsAppText } from "./outbound";
import { logger } from "./logger";
import { fmtWhen, norm, spParts, spDate, spDateISO, spTimeHM } from "./gerenteRules";

const OPEN = ["enviada", "aguardando_prova"];
const QUESTION_WINDOW_MS = 2 * 3_600_000;

/** Rodapé das mensagens de tarefa: respostas de um toque. */
export function quickReplyHelp(taskId: number | null): string {
  const n = taskId ? ` ${taskId}` : " + nº";
  return `Responda:\n*1${n}* ✅ terminei (depois mande a foto 📸)\n*2${n}* ⏰ adiar pra amanhã\n*3${n}* ❓ tenho uma dúvida`;
}

async function ownerFirstName(tenantId: number): Promise<string> {
  const { usersTable } = await import("@workspace/db");
  const [u] = await db.select({ name: usersTable.name }).from(usersTable)
    .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.isActive, true), eq(usersTable.role, "admin"))).orderBy(usersTable.id).limit(1);
  return u?.name.trim().split(" ")[0] ?? "o gestor";
}
const PROOF_WINDOW_MS = 2 * 3_600_000;

export async function sellerPhone(tenantId: number, userId: number): Promise<string | null> {
  // 1º: número cadastrado no Gerente IA (Configurações → Equipe no WhatsApp).
  const [t] = await db.select({ phone: gerenteTeamPhonesTable.phone }).from(gerenteTeamPhonesTable)
    .where(and(eq(gerenteTeamPhonesTable.tenantId, tenantId), eq(gerenteTeamPhonesTable.userId, userId))).limit(1);
  if (t?.phone) return t.phone;
  // 2º: telefone antigo do cadastro do RH (antes do RH ir pro ERP).
  const [e] = await db.select({ phone: employeesTable.phone }).from(employeesTable)
    .where(and(eq(employeesTable.tenantId, tenantId), eq(employeesTable.userId, userId), eq(employeesTable.isActive, true)))
    .limit(1);
  const p = normalizePhone(e?.phone ?? "");
  return p && p.length >= 12 ? p : null;
}

/** Linha por onde as tarefas saem: a última que o dono usou; senão a 1ª conectada. */
async function pickLine(tenantId: number, preferredIn: string | null): Promise<string[]> {
  // Linha ADM conectada manda em tudo que o Gerente envia.
  let preferred = preferredIn;
  try {
    const { getGerenteSettings, gerenteLine } = await import("./gerente");
    preferred = (await gerenteLine(await getGerenteSettings(tenantId))) ?? preferredIn;
  } catch { /* segue com a linha recebida */ }
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
    const first = p.assigneeName.split(" ")[0];
    const { postToPerson } = await import("./gerenteInternal");
    const chatText = [
      `📋 Nova tarefa${p.priority === "alta" ? " (URGENTE)" : ""} #${p.taskId}`,
      p.title,
      p.dueAt ? `⏰ Prazo: ${fmtWhen(p.dueAt)}` : null,
      "",
      `Responda aqui: 1 ${p.taskId} terminei (depois mande a foto) · 2 ${p.taskId} adiar · 3 ${p.taskId} dúvida`,
    ].filter((l) => l !== null).join("\n");
    const inChat = await postToPerson(tenantId, p.userId, chatText);
    if (!phone) {
      await db.insert(gerenteTaskDispatchesTable).values({ tenantId, taskId: p.taskId, userId: p.userId, assigneeName: p.assigneeName, status: inChat ? "enviada" : "sem_telefone", sentAt: inChat ? new Date() : null });
      return inChat
        ? `💬 Enviada pra ${first} no chat do CRM (sem WhatsApp cadastrado).`
        : `⚠️ ${first} não tem WhatsApp cadastrado (Gerente IA → Configurações → Equipe no WhatsApp) — a tarefa ficou só no quadro.`;
    }
    const text = [
      `📋 *Nova tarefa${p.priority === "alta" ? " (URGENTE)" : ""}*`,
      `Olá, ${first}! ${p.title}`,
      p.dueAt ? `⏰ Prazo: ${fmtWhen(p.dueAt)}` : null,
      "",
      quickReplyHelp(p.taskId),
      await taskLink(tenantId, p.taskId, false, p.userId),
    ].filter((l) => l !== null).join("\n");
    const used = await sendVia(phone, await pickLine(tenantId, p.ownerSessionKey), text);
    await db.insert(gerenteTaskDispatchesTable).values({
      tenantId, taskId: p.taskId, userId: p.userId, assigneeName: p.assigneeName, phone,
      sessionKey: used, status: used ? "enviada" : "falhou", sentAt: used ? new Date() : null,
    });
    return used ? `📲 Enviada no WhatsApp de ${first}${inChat ? " e no chat do CRM" : ""}. Aviso quando ele mandar a prova.`
      : inChat ? `💬 Enviada pra ${first} no chat do CRM (o WhatsApp não saiu — linha desconectada?).`
      : `⚠️ Não consegui enviar no WhatsApp de ${first} (linha desconectada?). A tarefa está no quadro.`;
  } catch (err) {
    logger.warn({ err, tenantId }, "Gerente IA: falha ao enviar tarefa ao vendedor");
    return "⚠️ Não consegui enviar a tarefa pelo WhatsApp; ela está no quadro.";
  }
}

async function notifyOwnerText(tenantId: number, text: string): Promise<void> {
  // Dono + gestores (2º número): os dois acompanham a equipe.
  const { notifyTeamLeads } = await import("./gerente");
  await notifyTeamLeads(tenantId, text);
}

/**
 * A IA olha a foto de prova e diz se ela parece NÃO ter relação com a
 * tarefa. Devolve o motivo (pra avisar o dono) ou null (ok / sem IA).
 */
async function checkProof(tenantId: number, title: string, proofUrl: string): Promise<string | null> {
  if (!title) return null;
  try {
    const { loadMedia } = await import("./gerenteErp");
    const media = await loadMedia(proofUrl);
    if (!media || !media.mime.startsWith("image/")) return null;
    const { getOpenAiClientForTenant } = await import("./aiClient");
    const openai = await getOpenAiClientForTenant(tenantId);
    const c = await openai.chat.completions.create({
      model: "gpt-4o-mini", max_tokens: 120, response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Você confere fotos de prova de tarefas de uma loja de celulares. Seja tolerante: só reprove quando a foto claramente não tem nada a ver com a tarefa (ex.: foto preta, selfie, print aleatório, foto repetida de outra coisa). Responda JSON {\"ok\": true|false, \"motivo\": \"curto, em português\"}." },
        { role: "user", content: [{ type: "text", text: `Tarefa: ${title}` }, { type: "image_url", image_url: { url: `data:${media.mime};base64,${media.buf.toString("base64")}`, detail: "low" } }] },
      ],
    }, { timeout: 15_000 });
    const j = JSON.parse(c.choices[0]?.message?.content ?? "{}") as { ok?: boolean; motivo?: string };
    return j.ok === false ? (j.motivo || "a foto não parece ser da tarefa").slice(0, 200) : null;
  } catch {
    return null;
  }
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
  const link = await taskLink(d.tenantId, d.taskId, true);
  const check = await checkProof(d.tenantId, task?.title ?? "", proofUrl);
  if (check) {
    await db.insert(taskCommentsTable).values({ tenantId: d.tenantId, taskId: d.taskId, authorId: null, content: `⚠️ Conferência automática: ${check}` });
  }
  await notifyOwnerText(d.tenantId, `✅ *${d.assigneeName.split(" ")[0]} concluiu:* ${task?.title ?? `tarefa ${d.taskId}`}\n📸 Prova anexada${check ? `\n⚠️ *Confira a foto:* ${check}` : ""}${link ? `:\n${link.replace(/^🔗 Ver a tarefa: /, "")}` : " na tarefa (CRM → Tarefas)."}`);
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
    const reply = (msg: string) => sendRawWhatsAppText(phone, input.sessionKey, msg);

    // "1 149" = terminei · "2 149" = adiar · "3 149 texto" = dúvida (o número é opcional se só houver uma tarefa).
    const quick = t.match(/^([123])(?:(?:\s+|\s*[-–.:)]\s*)#?(\d{1,7}))?(?:\s+(.+))?$/)
      ?? t.match(/^(adiar|adia|mais prazo|duvida|tenho (?:uma )?duvida)(?:\s+#?(\d{1,7}))?(?:\s*[:,-]?\s+(.+))?$/);
    const quickKind: "done" | "postpone" | "question" | null = !quick ? null
      : quick[1] === "1" ? "done" : quick[1] === "2" || /^(adia|mais prazo)/.test(quick[1]!) ? "postpone" : "question";
    let doneText = t;
    if (quickKind === "done") doneText = `feito${quick![2] ? ` ${quick![2]}` : ""}`;
    else if (quickKind && input.msgType !== "image") {
      const n = quick![2] ? Number(quick![2]) : null;
      const target = n ? open.find((d) => d.taskId === n) : open.length === 1 ? open[0] : undefined;
      const code = quickKind === "postpone" ? "2" : "3";
      if (!target) {
        const titles = await db.select({ id: tasksTable.id, title: tasksTable.title }).from(tasksTable).where(inArray(tasksTable.id, open.map((d) => d.taskId)));
        void reply(`Qual tarefa? Responda *${code}* + número:\n${titles.map((x) => `• ${x.id} — ${x.title}`).join("\n")}`);
        return true;
      }
      if (quickKind === "postpone") { void reply(await postpone(target)); return true; }
      // Texto da dúvida com acentos/maiúsculas originais (sem o "3 149").
      const q = quick![3] ? input.text.trim().replace(/^(?:3|d[uú]vida|tenho\s+(?:uma\s+)?d[uú]vida)\s*[-–.:)]?\s*(?:#?\d{1,7})?\s*[:,-]?\s*/i, "").trim() : "";
      if (q) { void reply(await forwardQuestion(target, q)); return true; }
      await db.update(gerenteTaskDispatchesTable).set({ questionAt: new Date() }).where(eq(gerenteTaskDispatchesTable.id, target.id));
      void reply(`❓ Pode escrever sua dúvida sobre a tarefa *${target.taskId}* que eu passo pro ${await ownerFirstName(target.tenantId)}.`);
      return true;
    }
    // Dúvida em aberto: a próxima mensagem (que não seja foto nem "feito") vai pro dono.
    if (!quickKind && input.msgType !== "image") {
      const asking = open.find((d) => d.questionAt && Date.now() - d.questionAt.getTime() < QUESTION_WINDOW_MS);
      if (asking && !/^(feito|pronto|concluido|conclui|finalizado|finalizei|terminei|ok feito)\b/.test(t)) {
        if (!input.text.trim()) { void reply("Me manda a dúvida por escrito, por favor. ✍️"); return true; }
        void reply(await forwardQuestion(asking, input.text.trim()));
        return true;
      }
    }
    const done = doneText.match(/^(feito|pronto|concluido|conclui|finalizado|finalizei|terminei|ok feito)(?:\s*#?\s*(\d+))?\b(.*)$/);

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

/** Telefone sugerido (RH antigo) para pré-preencher a tela de equipe. */
export async function suggestedPhones(tenantId: number): Promise<Map<number, string>> {
  const rows = await db.select({ userId: employeesTable.userId, phone: employeesTable.phone }).from(employeesTable)
    .where(and(eq(employeesTable.tenantId, tenantId), eq(employeesTable.isActive, true)));
  const m = new Map<number, string>();
  for (const r of rows) { const p = normalizePhone(r.phone ?? ""); if (r.userId && p && p.length >= 12) m.set(r.userId, p); }
  return m;
}

/** Mensagem de teste para um vendedor. Devolve a linha usada ou null. */
export async function sendTeamTest(tenantId: number, phone: string, name: string, ownerSessionKey: string | null): Promise<string | null> {
  const text = `👋 Olá, ${name.split(" ")[0]}! Este é um teste do *Gerente IA* da Sheikcell.\nA partir de agora as tarefas da loja chegam por aqui. Quando terminar uma, responda *feito* + o número da tarefa e mande uma *foto* como prova. 📸\n\nResponda *ok* pra confirmar que recebeu.`;
  return sendVia(phone, await pickLine(tenantId, ownerSessionKey), text);
}

/** Linha "🔗 Ver a tarefa: <link>" (link seguro, sem login). "" se falhar. */
async function taskLink(tenantId: number, taskId: number, canEdit = false, sellerId: number | null = null): Promise<string> {
  try {
    const { getGerenteSettings } = await import("./gerente");
    const { createLink } = await import("./gerenteExtras");
    const url = await createLink(await getGerenteSettings(tenantId), "task", taskId, 30, canEdit, canEdit ? null : sellerId);
    return sellerId && !canEdit ? `🔗 Abrir a tarefa (comecei / foto e concluir / adiar / dúvida): ${url}` : `🔗 Ver a tarefa: ${url}`;
  } catch {
    return "";
  }
}

/** Manda uma mensagem pro WhatsApp de uma pessoa da equipe. Devolve se saiu. */
export async function sendToTeamMember(tenantId: number, userId: number, text: string, opts: { chat?: boolean } = {}): Promise<boolean> {
  // Chat interno do CRM (sala "📋 Gerente · Pessoa") + WhatsApp. Entregue = qualquer um dos dois.
  const { postToPerson } = await import("./gerenteInternal");
  const inChat = opts.chat === false ? false : await postToPerson(tenantId, userId, text);
  const phone = await sellerPhone(tenantId, userId);
  if (!phone) return inChat;
  const { getGerenteSettings } = await import("./gerente");
  const settings = await getGerenteSettings(tenantId);
  return !!(await sendVia(phone, await pickLine(tenantId, settings.lastSessionKey), text)) || inChat;
}

// ─── Respostas rápidas: adiar e dúvida ───────────────────────────────────────

const MAX_AUTO_POSTPONE = 2;

async function postpone(d: typeof gerenteTaskDispatchesTable.$inferSelect): Promise<string> {
  const [task] = await db.select({ title: tasksTable.title, dueDate: tasksTable.dueDate }).from(tasksTable).where(eq(tasksTable.id, d.taskId)).limit(1);
  const title = task?.title ?? `tarefa ${d.taskId}`;
  const first = d.assigneeName.split(" ")[0];
  const owner = await ownerFirstName(d.tenantId);
  if (d.postponeCount >= MAX_AUTO_POSTPONE) {
    await db.insert(taskCommentsTable).values({ tenantId: d.tenantId, taskId: d.taskId, authorId: d.userId, content: "⏰ Pediu mais prazo pelo WhatsApp (já adiada antes)." });
    await notifyOwnerText(d.tenantId, `⏰ *${first} pediu mais prazo de novo* (${d.postponeCount + 1}ª vez): ${title}\nPra mudar o prazo: *link da tarefa ${d.taskId}*, ou responda *avisa ${first}: …*`);
    return `Essa tarefa já foi adiada ${d.postponeCount}x — pedi ao ${owner} pra decidir o novo prazo. 🙏`;
  }
  const base = task?.dueDate && task.dueDate.getTime() > Date.now() ? task.dueDate : new Date();
  const next = new Date(base.getTime() + 86_400_000);
  const p = spParts(next);
  const due = spDate(p.y, p.m, p.d, task?.dueDate ? spParts(task.dueDate).hh || 18 : 18, task?.dueDate ? spParts(task.dueDate).mm : 0);
  await db.update(tasksTable).set({ dueDate: due, updatedAt: new Date() }).where(eq(tasksTable.id, d.taskId));
  await db.update(gerenteTaskDispatchesTable).set({ postponeCount: d.postponeCount + 1, overdueNotifiedAt: null }).where(eq(gerenteTaskDispatchesTable.id, d.id));
  await db.insert(taskCommentsTable).values({ tenantId: d.tenantId, taskId: d.taskId, authorId: d.userId, content: `⏰ Adiada pelo WhatsApp para ${fmtWhen(due)}.` });
  await notifyOwnerText(d.tenantId, `⏰ *${first} adiou:* ${title} → ${fmtWhen(due)}.\nSe não concordar: *link da tarefa ${d.taskId}*.`);
  return `⏰ Ok! Tarefa *${d.taskId}* adiada para ${fmtWhen(due)}. Avisei o ${owner}.`;
}

async function forwardQuestion(d: typeof gerenteTaskDispatchesTable.$inferSelect, question: string): Promise<string> {
  const [task] = await db.select({ title: tasksTable.title }).from(tasksTable).where(eq(tasksTable.id, d.taskId)).limit(1);
  const first = d.assigneeName.split(" ")[0];
  await db.update(gerenteTaskDispatchesTable).set({ questionAt: null }).where(eq(gerenteTaskDispatchesTable.id, d.id));
  await db.insert(taskCommentsTable).values({ tenantId: d.tenantId, taskId: d.taskId, authorId: d.userId, content: `❓ Dúvida: ${question.slice(0, 1500)}` });
  await notifyOwnerText(d.tenantId, `❓ *${first} tem uma dúvida* na tarefa *${d.taskId} — ${task?.title ?? ""}*:\n“${question.slice(0, 800)}”\n\nPra responder: *avisa ${first}: …* ou *comentar tarefa ${d.taskId}: …*`);
  return `✅ Mandei sua dúvida pro ${await ownerFirstName(d.tenantId)}. Ele te responde por aqui.`;
}

// ─── Bom dia e cobrança diária da equipe ─────────────────────────────────────

type DigestTask = { id: number; title: string; dueDate: Date | null; priority: string };

async function openTasksByUser(tenantId: number, ownerId: number | null): Promise<Map<number, { name: string; tasks: DigestTask[] }>> {
  const { usersTable, taskAssigneesTable } = await import("@workspace/db");
  const rows = await db.select({ userId: usersTable.id, name: usersTable.name, id: tasksTable.id, title: tasksTable.title, dueDate: tasksTable.dueDate, priority: tasksTable.priority })
    .from(taskAssigneesTable)
    .innerJoin(tasksTable, eq(tasksTable.id, taskAssigneesTable.taskId))
    .innerJoin(usersTable, eq(usersTable.id, taskAssigneesTable.userId))
    .where(and(eq(tasksTable.tenantId, tenantId), eq(tasksTable.isArchived, false), ne(tasksTable.status, "done"), eq(usersTable.isActive, true)));
  const m = new Map<number, { name: string; tasks: DigestTask[] }>();
  for (const r of rows) {
    if (r.userId === ownerId) continue;
    const e = m.get(r.userId) ?? { name: r.name.trim(), tasks: [] };
    e.tasks.push({ id: r.id, title: r.title, dueDate: r.dueDate, priority: r.priority });
    m.set(r.userId, e);
  }
  return m;
}

/** Garante um envio aberto (pra "1/2/3 + nº" funcionar mesmo em tarefa criada no quadro). */
async function ensureDispatch(tenantId: number, userId: number, name: string, phone: string, sessionKey: string, taskId: number): Promise<void> {
  const [d] = await db.select({ id: gerenteTaskDispatchesTable.id }).from(gerenteTaskDispatchesTable)
    .where(and(eq(gerenteTaskDispatchesTable.taskId, taskId), eq(gerenteTaskDispatchesTable.userId, userId), inArray(gerenteTaskDispatchesTable.status, OPEN))).limit(1);
  if (d) return;
  await db.insert(gerenteTaskDispatchesTable).values({ tenantId, taskId, userId, assigneeName: name, phone, sessionKey, status: "enviada", sentAt: new Date() });
}

function taskLine(t: DigestTask, today: string): string {
  const late = t.dueDate && spDateISO(t.dueDate) < today;
  const when = !t.dueDate ? "sem prazo" : late ? `⚠️ atrasada (${fmtWhen(t.dueDate)})` : spDateISO(t.dueDate) === today ? `hoje ${spTimeHM(t.dueDate)}` : fmtWhen(t.dueDate);
  return `• *${t.id}* ${t.title}${t.priority === "alta" ? " 🔴" : ""} — ${when}`;
}

/**
 * Job (1 min): no horário da manhã, cada pessoa da equipe recebe só as
 * tarefas DELA (atrasadas, de hoje e sem prazo); no fim do expediente, quem
 * ainda tem tarefa de hoje/atrasada aberta é cobrado e o dono recebe o
 * resumo. Domingo não manda. Uma vez por pessoa por dia (tabela de envios).
 */
export async function runTeamDigests(settings: { tenantId: number; teamDigestEnabled: boolean; teamMorningTime: string; teamEveningTime: string; lastSessionKey: string | null }, now: Date = new Date()): Promise<number> {
  if (!settings.teamDigestEnabled) return 0;
  const p = spParts(now);
  if (p.weekday === 0) return 0;
  const hm = spTimeHM(now);
  const kind = hm >= settings.teamEveningTime ? "tarde" : hm >= settings.teamMorningTime ? "manha" : null;
  if (!kind) return 0;
  // Fora da janela de 2h depois do horário, não manda atrasado (ex.: servidor voltou às 23h).
  const [hh, mm] = (kind === "manha" ? settings.teamMorningTime : settings.teamEveningTime).split(":").map(Number);
  const target = spDate(p.y, p.m, p.d, hh ?? 8, mm ?? 0);
  if (now.getTime() - target.getTime() > 2 * 3_600_000) return 0;

  const { gerenteTeamDigestsTable, usersTable } = await import("@workspace/db");
  const today = spDateISO(now);
  const [owner] = await db.select({ id: usersTable.id }).from(usersTable)
    .where(and(eq(usersTable.tenantId, settings.tenantId), eq(usersTable.isActive, true), eq(usersTable.role, "admin"))).orderBy(usersTable.id).limit(1);
  const byUser = await openTasksByUser(settings.tenantId, owner?.id ?? null);
  const lines = await pickLine(settings.tenantId, settings.lastSessionKey);
  let sent = 0;
  const charged: string[] = [];
  for (const [userId, u] of byUser) {
    const relevant = u.tasks.filter((t) => kind === "manha"
      ? !t.dueDate || spDateISO(t.dueDate) <= today
      : !!t.dueDate && spDateISO(t.dueDate) <= today);
    if (!relevant.length) continue;
    // Marca antes de enviar: se dois processos rodarem juntos, só um manda.
    const ins = await db.insert(gerenteTeamDigestsTable).values({ tenantId: settings.tenantId, userId, kind, day: today }).onConflictDoNothing().returning();
    if (!ins.length) continue;
    const phone = await sellerPhone(settings.tenantId, userId);
    if (!phone) continue;
    relevant.sort((a, b) => (a.dueDate?.getTime() ?? Infinity) - (b.dueDate?.getTime() ?? Infinity));
    const first = u.name.split(" ")[0];
    const shown = relevant.slice(0, 10);
    const text = kind === "manha"
      ? [`☀️ *Bom dia, ${first}!* Suas tarefas de hoje:`, ...shown.map((t) => taskLine(t, today)), relevant.length > 10 ? `…e mais ${relevant.length - 10}.` : null, "", quickReplyHelp(shown.length === 1 ? shown[0]!.id : null)].filter((l) => l !== null).join("\n")
      : [`🔔 *${first}, antes de fechar o dia:* estas ainda estão abertas:`, ...shown.map((t) => taskLine(t, today)), "", quickReplyHelp(shown.length === 1 ? shown[0]!.id : null)].join("\n");
    const { postToPerson } = await import("./gerenteInternal");
    await postToPerson(settings.tenantId, userId, text);
    const used = await sendVia(phone, lines, text);
    if (!used) continue;
    for (const t of shown) await ensureDispatch(settings.tenantId, userId, u.name, phone, used, t.id);
    sent++;
    if (kind === "tarde") charged.push(`${first} (${relevant.length})`);
  }
  if (charged.length) await notifyOwnerText(settings.tenantId, `🔔 *Cobrei a equipe* — tarefas de hoje ainda abertas: ${charged.join(", ")}.`);
  return sent;
}

/** Encaminha um arquivo que o dono mandou (foto/PDF) pro WhatsApp de alguém da equipe. */
export async function sendRawWhatsAppMediaToTeam(tenantId: number, userId: number, mediaUrl: string, caption: string | null): Promise<boolean> {
  const phone = await sellerPhone(tenantId, userId);
  if (!phone) return false;
  const { loadMedia } = await import("./gerenteErp");
  const media = await loadMedia(mediaUrl).catch(() => null);
  if (!media) return false;
  const { sendRawWhatsAppMedia } = await import("./outbound");
  const { getGerenteSettings } = await import("./gerente");
  const settings = await getGerenteSettings(tenantId);
  for (const k of await pickLine(tenantId, settings.lastSessionKey)) {
    if (await sendRawWhatsAppMedia(phone, k, { base64: media.buf.toString("base64"), mimetype: media.mime, filename: media.fileName }, caption)) return true;
  }
  return false;
}

// ─── Link do vendedor: agir na tarefa sem WhatsApp ───────────────────────────

async function dispatchFor(tenantId: number, taskId: number, userId: number): Promise<typeof gerenteTaskDispatchesTable.$inferSelect | null> {
  const [d] = await db.select().from(gerenteTaskDispatchesTable)
    .where(and(eq(gerenteTaskDispatchesTable.tenantId, tenantId), eq(gerenteTaskDispatchesTable.taskId, taskId), eq(gerenteTaskDispatchesTable.userId, userId)))
    .orderBy(desc(gerenteTaskDispatchesTable.id)).limit(1);
  if (d) return d;
  const { usersTable } = await import("@workspace/db");
  const [u] = await db.select({ name: usersTable.name }).from(usersTable).where(and(eq(usersTable.id, userId), eq(usersTable.tenantId, tenantId))).limit(1);
  if (!u) return null;
  const [n] = await db.insert(gerenteTaskDispatchesTable).values({ tenantId, taskId, userId, assigneeName: u.name.trim(), phone: await sellerPhone(tenantId, userId), status: "enviada", sentAt: new Date() }).returning();
  return n ?? null;
}

export async function sellerAction(tenantId: number, taskId: number, userId: number, action: "doing" | "postpone" | "question", text?: string): Promise<string> {
  const d = await dispatchFor(tenantId, taskId, userId);
  if (!d) return "Tarefa não encontrada.";
  if (action === "postpone") return postpone(d);
  if (action === "question") {
    const q = (text ?? "").trim();
    if (!q) return "Escreva a dúvida.";
    return forwardQuestion(d, q);
  }
  await db.update(tasksTable).set({ status: "doing", updatedAt: new Date() }).where(and(eq(tasksTable.id, taskId), eq(tasksTable.tenantId, tenantId)));
  const [task] = await db.select({ title: tasksTable.title }).from(tasksTable).where(eq(tasksTable.id, taskId)).limit(1);
  await notifyOwnerText(tenantId, `▶️ *${d.assigneeName.split(" ")[0]} começou:* ${task?.title ?? `tarefa ${taskId}`}`);
  return "▶️ Marcado como em andamento. Quando terminar, mande a foto aqui.";
}

export async function sellerProof(tenantId: number, taskId: number, userId: number, mediaUrl: string, note: string | null): Promise<string> {
  const d = await dispatchFor(tenantId, taskId, userId);
  if (!d) return "Tarefa não encontrada.";
  await conclude(d, mediaUrl, note);
  return "✅ Tarefa concluída com a foto. Obrigado!";
}
