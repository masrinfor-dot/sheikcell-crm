import { createHmac } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { db, rafflesTable, raffleDrawsTable, conversationsTable, usersTable, attendanceLogsTable } from "@workspace/db";
import { requireAuth, requireTenant, requireModule } from "../middlewares/auth";
import { logger } from "../lib/logger";
import { normalizePhone } from "../lib/phone";

const router: IRouter = Router();
router.use("/raffles", requireModule("sorteios"));

// attempts/lastAttemptAt são opcionais pra não quebrar draws antigos já
// gravados no banco antes desta mudança (trata ausente como "nunca tentou").
type Winner = {
  phone: string; name: string; conversationId: number; sent: boolean; error?: string;
  attempts?: number; lastAttemptAt?: string;
};

// Reenvio automático (pedido 14/09): até 2 tentativas A MAIS além do envio
// inicial (3 no total) antes de desistir e deixar só o "Reenviar" manual (sem
// limite, como já era). Um ganhador com attempts=0 nunca é tocado pelo job
// automático — é o estado de um sorteio criado em modo "revisar antes de
// enviar" (ver doRunRaffleDraw), que só é enviado quando alguém aciona na mão.
const MAX_AUTO_ATTEMPTS = 3;
const AUTO_RETRY_INTERVAL_MS = 10 * 60_000;

// ---------- validação ----------

function numArrayOrNull(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out = v.map((x) => parseInt(String(x), 10)).filter((n) => Number.isFinite(n));
  return out.length ? out : null;
}

function strArrayOrNull(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out = v.map((x) => String(x).trim()).filter(Boolean);
  return out.length ? out.slice(0, 20) : null;
}

function sanitizeRaffle(body: Record<string, unknown>): { data?: typeof rafflesTable.$inferInsert; error?: string } {
  const name = String(body["name"] ?? "").trim();
  const prize = String(body["prize"] ?? "").trim();
  const messageTemplate = String(body["messageTemplate"] ?? "").trim();
  if (!name) return { error: "Dê um nome ao sorteio" };
  if (!prize) return { error: "Informe o prêmio" };
  if (!messageTemplate) return { error: "Escreva a mensagem para o ganhador" };
  const winnersCount = parseInt(String(body["winnersCount"] ?? 1), 10);
  if (!Number.isFinite(winnersCount) || winnersCount < 1 || winnersCount > 20) {
    return { error: "Quantidade de ganhadores deve ser de 1 a 20" };
  }
  const recurrence = String(body["recurrence"] ?? "once");
  if (!["once", "weekly", "monthly"].includes(recurrence)) return { error: "Recorrência inválida" };
  let dayOfWeek: number | null = null;
  let dayOfMonth: number | null = null;
  if (recurrence === "weekly") {
    dayOfWeek = parseInt(String(body["dayOfWeek"] ?? ""), 10);
    if (!Number.isFinite(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) return { error: "Escolha o dia da semana do sorteio" };
  }
  if (recurrence === "monthly") {
    dayOfMonth = parseInt(String(body["dayOfMonth"] ?? ""), 10);
    if (!Number.isFinite(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28) return { error: "Dia do mês deve ser de 1 a 28" };
  }
  let periodDays: number | null = null;
  if (body["periodDays"] != null && String(body["periodDays"]).trim() !== "") {
    periodDays = parseInt(String(body["periodDays"]), 10);
    if (!Number.isFinite(periodDays) || periodDays < 1 || periodDays > 365) return { error: "Período deve ser de 1 a 365 dias" };
  }
  return {
    data: {
      name: name.slice(0, 120),
      prize: prize.slice(0, 200),
      messageTemplate: messageTemplate.slice(0, 1000),
      storeName: String(body["storeName"] ?? "").trim().slice(0, 120) || null,
      sectorIds: numArrayOrNull(body["sectorIds"]),
      vendedorIds: numArrayOrNull(body["vendedorIds"]),
      sessionKeys: strArrayOrNull(body["sessionKeys"]),
      clientTypes: strArrayOrNull(body["clientTypes"]),
      periodDays,
      onlyResolved: body["onlyResolved"] === true,
      surveyRespondedOnly: body["surveyRespondedOnly"] === true,
      excludePreviousWinners: body["excludePreviousWinners"] !== false,
      winnersCount,
      recurrence,
      dayOfWeek,
      dayOfMonth,
      active: body["active"] !== false,
    },
  };
}

// ---------- elegíveis + sorteio ----------

type Raffle = typeof rafflesTable.$inferSelect;

async function eligibleClients(raffle: Raffle): Promise<{ phone: string; name: string; conversationId: number }[]> {
  // Só clientes (conversas) da MESMA loja do sorteio (multi-loja: fail closed).
  const conds = [
    eq(conversationsTable.tenantId, raffle.tenantId),
    sql`${conversationsTable.phone} <> ''`,
    eq(conversationsTable.channel, "whatsapp"),
  ];
  const sectorIds = numArrayOrNull(raffle.sectorIds);
  const vendedorIds = numArrayOrNull(raffle.vendedorIds);
  const sessionKeys = strArrayOrNull(raffle.sessionKeys);
  if (sectorIds) conds.push(inArray(conversationsTable.sectorId, sectorIds));
  if (vendedorIds) conds.push(inArray(conversationsTable.assigneeId, vendedorIds));
  if (sessionKeys) conds.push(inArray(conversationsTable.sessionKey, sessionKeys));
  if (raffle.onlyResolved) conds.push(inArray(conversationsTable.status, ["resolved", "archived"]));
  if (raffle.periodDays) {
    conds.push(gte(conversationsTable.updatedAt, new Date(Date.now() - raffle.periodDays * 86_400_000)));
  }

  let rows = await db.select({
    id: conversationsTable.id,
    phone: conversationsTable.phone,
    name: conversationsTable.name,
    status: conversationsTable.status,
    updatedAt: conversationsTable.updatedAt,
  }).from(conversationsTable).where(and(...conds));

  // Tipo de cliente: "comprou" (venda registrada), "prospeccao" (atendimento
  // ainda não finalizado) ou um motivo de finalização exato. Combináveis (OU).
  const clientTypes = strArrayOrNull(raffle.clientTypes);
  if (clientTypes) {
    const wantComprou = clientTypes.includes("comprou");
    const wantProspec = clientTypes.includes("prospeccao");
    const reasons = clientTypes.filter((t) => t !== "comprou" && t !== "prospeccao");

    const okPhones = new Set<string>();
    const logConds = [];
    if (wantComprou) logConds.push(eq(attendanceLogsTable.hadSale, true));
    if (reasons.length) logConds.push(inArray(attendanceLogsTable.resolutionReason, reasons));
    if (logConds.length) {
      const logWhere = [eq(attendanceLogsTable.tenantId, raffle.tenantId), or(...logConds)!];
      if (raffle.periodDays) {
        logWhere.push(gte(attendanceLogsTable.createdAt, new Date(Date.now() - raffle.periodDays * 86_400_000)));
      }
      const logs = await db.select({ contact: attendanceLogsTable.clientContact })
        .from(attendanceLogsTable).where(and(...logWhere));
      for (const l of logs) {
        const key = normalizePhone(l.contact);
        if (key) okPhones.add(key);
      }
    }
    rows = rows.filter((r) => {
      const key = normalizePhone(r.phone);
      if (okPhones.has(key)) return true;
      if (wantProspec && r.status !== "resolved" && r.status !== "archived") return true;
      return false;
    });
  }

  // Só quem respondeu a pesquisa de satisfação: telefone com pelo menos um
  // attendance_log com nota registrada (respeita o período do sorteio, se houver).
  if (raffle.surveyRespondedOnly) {
    const surveyWhere = [
      // Isolamento entre lojas: só notas de atendimentos DESTA loja contam.
      eq(attendanceLogsTable.tenantId, raffle.tenantId),
      sql`${attendanceLogsTable.satisfactionRating} IS NOT NULL`,
    ];
    if (raffle.periodDays) {
      surveyWhere.push(gte(attendanceLogsTable.createdAt, new Date(Date.now() - raffle.periodDays * 86_400_000)));
    }
    const rated = await db.select({ contact: attendanceLogsTable.clientContact })
      .from(attendanceLogsTable).where(and(...surveyWhere));
    const ratedPhones = new Set<string>();
    for (const l of rated) {
      const key = normalizePhone(l.contact);
      if (key) ratedPhones.add(key);
    }
    rows = rows.filter((r) => ratedPhones.has(normalizePhone(r.phone)));
  }

  // Cada cliente (telefone) entra UMA vez — fica com a conversa mais recente.
  const byPhone = new Map<string, { phone: string; name: string; conversationId: number; at: number }>();
  for (const r of rows) {
    const key = normalizePhone(r.phone);
    if (!key) continue;
    const at = r.updatedAt ? new Date(r.updatedAt).getTime() : 0;
    const cur = byPhone.get(key);
    if (!cur || at > cur.at) byPhone.set(key, { phone: r.phone, name: r.name, conversationId: r.id, at });
  }

  let list = [...byPhone.values()];

  if (raffle.excludePreviousWinners) {
    const draws = await db.select({ winners: raffleDrawsTable.winners })
      .from(raffleDrawsTable).where(eq(raffleDrawsTable.raffleId, raffle.id));
    const won = new Set<string>();
    for (const d of draws) {
      for (const w of (d.winners as Winner[] | null) ?? []) won.add(normalizePhone(String(w.phone)));
    }
    list = list.filter((c) => !won.has(normalizePhone(c.phone)));
  }

  return list.map(({ phone, name, conversationId }) => ({ phone, name, conversationId }));
}

function fillTemplate(template: string, w: { name: string }, raffle: Raffle, vendedorStore?: string | null): string {
  // {loja}: primeiro o que foi digitado no sorteio; senão, a loja do vendedor
  // responsável pela conversa do ganhador (redes de lojas); senão, genérico.
  return template
    .replaceAll("{nome}", w.name || "cliente")
    .replaceAll("{premio}", raffle.prize)
    .replaceAll("{loja}", raffle.storeName || vendedorStore || "nossa loja");
}

/** Loja do vendedor responsável pela conversa (para preencher {loja} em redes). */
async function storeOfConversation(conversationId: number, tenantId: number): Promise<string | null> {
  const [row] = await db.select({ storeName: usersTable.storeName })
    .from(conversationsTable)
    .innerJoin(usersTable, eq(usersTable.id, conversationsTable.assigneeId))
    .where(and(eq(conversationsTable.id, conversationId), eq(conversationsTable.tenantId, tenantId)))
    .limit(1);
  return row?.storeName ?? null;
}

async function sendWhatsAppText(conversationId: number, content: string, tenantId: number): Promise<boolean> {
  const [conv] = await db.select().from(conversationsTable)
    .where(and(eq(conversationsTable.id, conversationId), eq(conversationsTable.tenantId, tenantId))).limit(1);
  if (!conv || !conv.phone) return false;

  const { messagesTable } = await import("@workspace/db");
  const { broadcast } = await import("../lib/sseEmitter");
  const { isPotentialConversation, restrictedRecipients } = await import("../lib/conversationScope");

  const [msg] = await db.insert(messagesTable).values({
    tenantId: conv.tenantId,
    conversationId: conv.id,
    content,
    direction: "outbound",
    type: "text",
    status: "sent",
    senderName: "Sorteio automático",
  }).returning();

  await db.update(conversationsTable).set({
    lastMessage: content,
    lastMessageDirection: "outbound",
    lastMessageSenderName: "Sorteio automático",
    lastMessageAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(conversationsTable.id, conv.id));

  broadcast("message", { conversationId: conv.id, message: msg }, {
    tenantId: conv.tenantId,
    sectorId: conv.sectorId,
    sessionKey: conv.sessionKey,
    isPotential: isPotentialConversation(conv),
    restrictedTo: await restrictedRecipients(conv),
  });

  const bridgeUrl = process.env["WHATSAPP_BRIDGE_URL"] ?? "http://localhost:3002";
  const bridgeSecret = createHmac(
    "sha256",
    process.env["SESSION_SECRET"] ?? "sheikcell-dev-only-secret",
  ).update("whatsapp-bridge-v1").digest("hex");
  let delivered = true;
  try {
    const r = await fetch(`${bridgeUrl}/whatsapp/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Secret": bridgeSecret },
      body: JSON.stringify({ to: conv.phone, text: content, session: conv.sessionKey }),
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
      broadcast("message_updated", { conversationId: conv.id, message: failedMsg }, {
        tenantId: conv.tenantId,
        sectorId: conv.sectorId,
        sessionKey: conv.sessionKey,
        isPotential: isPotentialConversation(conv),
        restrictedTo: await restrictedRecipients(conv),
      });
    }
  }
  return delivered;
}

/** Tenta enviar (ou reenviar) a mensagem de um ganhador, e devolve a cópia
 * atualizada do Winner — usado pelo sorteio automático, pelo "Reenviar"
 * manual, pelo "Enviar para todos" e pelo reenvio automático (até 2x). Nunca
 * lança: falha vira `sent: false` + `error` preenchido, igual sempre foi. */
async function attemptSendToWinner(raffle: Raffle, w: Winner): Promise<Winner> {
  let sent = false;
  let error: string | undefined;
  try {
    const vendedorStore = raffle.storeName ? null : await storeOfConversation(w.conversationId, raffle.tenantId);
    sent = await sendWhatsAppText(w.conversationId, fillTemplate(raffle.messageTemplate, w, raffle, vendedorStore), raffle.tenantId);
    if (!sent) error = "Falha no envio pelo WhatsApp";
  } catch (err) {
    error = err instanceof Error ? err.message : "Erro no envio";
  }
  const updated: Winner = { ...w, sent, attempts: (w.attempts ?? 0) + 1, lastAttemptAt: new Date().toISOString() };
  if (error) updated.error = error; else delete updated.error;
  return updated;
}

// Evita dois sorteios do MESMO sorteio ao mesmo tempo neste processo
// (clique duplo no "Sortear agora" ou tick do agendador junto com manual).
const drawInProgress = new Set<number>();

/** Executa um sorteio: escolhe ganhadores ao acaso e, por padrão, já envia a
 * mensagem automática (`autoSend: true`, comportamento de sempre — usado por
 * TODO sorteio recorrente/agendado, sem exceção). `autoSend: false` (pedido
 * 14/09, só disponível no "Sortear agora" manual) sorteia e grava os
 * ganhadores SEM tentar mandar nada ainda — fica pendente de revisão, e
 * alguém dispara o envio depois (por ganhador, ou "Enviar para todos"). */
export async function runRaffleDraw(
  raffle: Raffle,
  periodKey: string,
  opts: { autoSend?: boolean } = {},
): Promise<{ draw: typeof raffleDrawsTable.$inferSelect; eligible: number }> {
  if (drawInProgress.has(raffle.id)) throw new Error("Este sorteio já está sendo executado — aguarde");
  drawInProgress.add(raffle.id);
  try {
    return await doRunRaffleDraw(raffle, periodKey, opts.autoSend !== false);
  } finally {
    drawInProgress.delete(raffle.id);
  }
}

async function doRunRaffleDraw(raffle: Raffle, periodKey: string, autoSend: boolean): Promise<{ draw: typeof raffleDrawsTable.$inferSelect; eligible: number }> {
  const pool = await eligibleClients(raffle);
  // isAuto = disparado pelo AGENDADOR (recorrência), não pelo botão "Sortear
  // agora" — não confundir com o parâmetro `autoSend` (se as mensagens já
  // saem sozinhas ou ficam pendentes de revisão): um sorteio agendado é
  // SEMPRE isAuto=true E autoSend=true (o agendador nunca cria em modo
  // revisão); só o "Sortear agora" manual pode escolher autoSend=false.
  const isAuto = !periodKey.startsWith("manual-");
  // Backstop no banco: registra o período ANTES de enviar qualquer mensagem.
  // Se outro processo já sorteou este período, o índice único barra aqui.
  let placeholderId: number | null = null;
  if (isAuto) {
    try {
      const [ph] = await db.insert(raffleDrawsTable).values({
        tenantId: raffle.tenantId, raffleId: raffle.id, periodKey, eligibleCount: pool.length, winners: [],
      }).returning({ id: raffleDrawsTable.id });
      placeholderId = ph?.id ?? null;
    } catch {
      throw new Error("Este período já foi sorteado");
    }
  }
  // Embaralha (Fisher-Yates) e pega os N primeiros.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const picked = pool.slice(0, raffle.winnersCount);

  const winners: Winner[] = [];
  for (const w of picked) {
    if (autoSend) {
      winners.push(await attemptSendToWinner(raffle, { ...w, sent: false }));
    } else {
      // Modo "revisar antes de enviar" (pedido 14/09): grava o ganhador
      // sorteado sem tentar mandar nada — attempts=0 é o sinal de "nunca
      // tentou", tanto pro job de reenvio automático (que ignora esse
      // estado) quanto pra tela mostrar "aguardando envio" em vez de "falhou".
      winners.push({ ...w, sent: false, attempts: 0 });
    }
  }

  let draw: typeof raffleDrawsTable.$inferSelect;
  if (placeholderId != null) {
    const [upd] = await db.update(raffleDrawsTable).set({ winners, eligibleCount: pool.length })
      .where(eq(raffleDrawsTable.id, placeholderId)).returning();
    draw = upd!;
  } else {
    const [ins] = await db.insert(raffleDrawsTable).values({
      tenantId: raffle.tenantId, raffleId: raffle.id, periodKey, eligibleCount: pool.length, winners,
    }).returning();
    draw = ins!;
  }

  // Só o fluxo automático marca o período como rodado — sorteio manual não pode
  // "roubar" a chave da recorrência (senão o automático rodaria de novo no mesmo dia).
  if (isAuto) {
    await db.update(rafflesTable).set({ lastRunKey: periodKey }).where(eq(rafflesTable.id, raffle.id));
  }
  return { draw, eligible: pool.length };
}

// ---------- recorrência (chamado pelo agendador) ----------

function spParts(): { ymd: string; weekday: number; day: number; hour: number; isoWeek: string; month: string } {
  const now = new Date();
  const tz = "America/Sao_Paulo";
  const ymd = now.toLocaleDateString("en-CA", { timeZone: tz });
  const wd = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "short" });
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
  const day = parseInt(ymd.slice(8, 10), 10);
  const hour = parseInt(now.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }), 10);
  return { ymd, weekday, day, hour, isoWeek: `${ymd.slice(0, 4)}-W${ymd}`, month: ymd.slice(0, 7) };
}

let ticking = false;

/** Roda sorteios recorrentes no dia certo (a partir das 10h, horário de Brasília). */
export async function runDueRaffles(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const p = spParts();
    if (p.hour < 10) return; // sorteia a partir das 10h para não madrugar o cliente
    const raffles = await db.select().from(rafflesTable)
      .where(and(eq(rafflesTable.active, true)));
    for (const r of raffles) {
      try {
        let key: string | null = null;
        if (r.recurrence === "weekly" && r.dayOfWeek === p.weekday) key = `${p.ymd}`;
        if (r.recurrence === "monthly" && r.dayOfMonth === p.day) key = p.month;
        if (!key || r.lastRunKey === key) continue;
        // Reivindica de forma atômica: só um processo sorteia por período.
        const [claimed] = await db.update(rafflesTable).set({ lastRunKey: key })
          .where(and(eq(rafflesTable.id, r.id), eq(rafflesTable.active, true),
            r.lastRunKey == null ? sql`${rafflesTable.lastRunKey} IS NULL` : eq(rafflesTable.lastRunKey, r.lastRunKey)))
          .returning();
        if (!claimed) continue;
        await runRaffleDraw({ ...r, lastRunKey: key }, key);
        logger.info({ raffleId: r.id, key }, "Sorteio recorrente executado");
      } catch (err) {
        logger.warn({ err, raffleId: r.id }, "Falha em sorteio recorrente");
      }
    }
  } catch (err) {
    logger.warn({ err }, "Tick de sorteios falhou");
  } finally {
    ticking = false;
  }
}

let retrying = false;

/** Reenvio automático (até 2 tentativas a mais, pedido 14/09) pra ganhadores
 * cujo envio falhou — chamado pelo agendador na mesma cadência do tick de
 * sorteios recorrentes (5 min). Só mexe em quem JÁ tentou pelo menos uma vez
 * (attempts >= 1) e ainda não bateu o teto (MAX_AUTO_ATTEMPTS); nunca toca
 * num ganhador com attempts=0 (sorteio em modo "revisar antes de enviar" —
 * esse só sai quando alguém aciona na mão, nunca sozinho) nem num que já
 * esgotou as tentativas automáticas (aí só o "Reenviar" manual resolve).
 * Espera AUTO_RETRY_INTERVAL_MS desde a última tentativa antes de tentar de
 * novo, pra dar chance de uma falha passageira (WhatsApp reconectando etc.)
 * se resolver sozinha. Escopo de 7 dias: um draw mais velho que isso já
 * teria esgotado as tentativas automáticas há muito tempo, não precisa mais
 * ser reexaminado a cada tick. */
export async function retryFailedRaffleWinners(): Promise<void> {
  if (retrying) return;
  retrying = true;
  try {
    const cutoff = new Date(Date.now() - AUTO_RETRY_INTERVAL_MS);
    const recentSince = new Date(Date.now() - 7 * 86_400_000);
    const candidateDraws = await db.select().from(raffleDrawsTable)
      .where(gte(raffleDrawsTable.createdAt, recentSince));
    for (const draw of candidateDraws) {
      const winners = ((draw.winners as Winner[] | null) ?? []).map((w) => ({ ...w }));
      let changed = false;
      for (let i = 0; i < winners.length; i++) {
        const w = winners[i]!;
        const attempts = w.attempts ?? 0;
        if (w.sent || attempts === 0 || attempts >= MAX_AUTO_ATTEMPTS) continue;
        const lastAttempt = w.lastAttemptAt ? new Date(w.lastAttemptAt) : null;
        if (lastAttempt && lastAttempt > cutoff) continue; // ainda dentro do intervalo — espera mais
        const [raffle] = await db.select().from(rafflesTable).where(eq(rafflesTable.id, draw.raffleId)).limit(1);
        if (!raffle) continue;
        try {
          winners[i] = await attemptSendToWinner(raffle, w);
          changed = true;
        } catch (err) {
          logger.warn({ err, drawId: draw.id, phone: w.phone }, "Falha no reenvio automático de sorteio");
        }
      }
      if (changed) {
        await db.update(raffleDrawsTable).set({ winners }).where(eq(raffleDrawsTable.id, draw.id));
      }
    }
  } catch (err) {
    logger.warn({ err }, "Tick de reenvio automático de sorteios falhou");
  } finally {
    retrying = false;
  }
}

// ---------- rotas ----------
// Admin (e quem tem a função "sorteios" liberada) gerencia TODOS os sorteios.
// Vendedor comum também pode criar sorteios, mas só entre os PRÓPRIOS clientes
// e só vê/gerencia os sorteios que ele mesmo criou (prospecção).

async function isRaffleManager(req: { session: { userId?: number; userRole?: string } }): Promise<boolean> {
  if (req.session.userRole === "admin") return true;
  const userId = req.session.userId;
  if (!userId) return false;
  const [u] = await db.select({ moduleAccess: usersTable.moduleAccess })
    .from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  // Vendedor comum continua podendo criar sorteio dos próprios clientes
  // (regra de negócio à parte, ver comentário acima) — só o gerenciamento
  // de TODOS os sorteios da loja exige acesso de EDIÇÃO explícito ao módulo
  // (nível "view" deixaria ver a lista mas não editar/apagar de terceiros).
  return u?.moduleAccess?.sorteios === "edit";
}

/** Carrega o sorteio (da loja) e garante que o usuário pode mexer nele. */
async function loadOwnRaffle(req: { session: { userId?: number; userRole?: string } }, id: number, tenantId: number): Promise<{ raffle?: Raffle; status?: number; error?: string }> {
  if (isNaN(id)) return { status: 400, error: "ID inválido" };
  const [raffle] = await db.select().from(rafflesTable)
    .where(and(eq(rafflesTable.id, id), eq(rafflesTable.tenantId, tenantId))).limit(1);
  if (!raffle) return { status: 404, error: "Sorteio não encontrado" };
  if (!(await isRaffleManager(req)) && raffle.createdById !== req.session.userId) {
    return { status: 404, error: "Sorteio não encontrado" };
  }
  return { raffle };
}

router.get("/raffles", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const manager = await isRaffleManager(req);
  const rows = manager
    ? await db.select().from(rafflesTable)
        .where(eq(rafflesTable.tenantId, tenantId)).orderBy(desc(rafflesTable.id))
    : await db.select().from(rafflesTable)
        .where(and(eq(rafflesTable.tenantId, tenantId), eq(rafflesTable.createdById, req.session.userId!)))
        .orderBy(desc(rafflesTable.id));
  res.json(rows);
});

router.post("/raffles", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { data, error } = sanitizeRaffle((req.body ?? {}) as Record<string, unknown>);
  if (!data) { res.status(400).json({ error }); return; }
  data.tenantId = tenantId;
  data.createdById = req.session.userId!;
  if (!(await isRaffleManager(req))) {
    // Vendedor comum: sorteio SEMPRE restrito aos próprios clientes.
    data.vendedorIds = [req.session.userId!];
    data.sectorIds = null;
    data.sessionKeys = null;
  }
  const [created] = await db.insert(rafflesTable).values(data).returning();
  res.status(201).json(created);
});

router.patch("/raffles/:id", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  const { raffle: existing, status, error: loadErr } = await loadOwnRaffle(req, id, tenantId);
  if (!existing) { res.status(status!).json({ error: loadErr }); return; }

  const body = (req.body ?? {}) as Record<string, unknown>;
  // Sorteio já realizado não pode ser editado (só pausar/reativar) — garante
  // que o histórico reflita as regras usadas no sorteio.
  const [hasDraw] = await db.select({ id: raffleDrawsTable.id })
    .from(raffleDrawsTable).where(eq(raffleDrawsTable.raffleId, id)).limit(1);
  const onlyActiveToggle = Object.keys(body).every((k) => k === "active");
  if (hasDraw && !onlyActiveToggle) {
    res.status(400).json({ error: "Este sorteio já foi realizado e não pode mais ser editado. Você pode pausá-lo ou criar um novo sorteio." });
    return;
  }
  if (hasDraw && onlyActiveToggle) {
    const [updated] = await db.update(rafflesTable).set({ active: body["active"] !== false })
      .where(and(eq(rafflesTable.id, id), eq(rafflesTable.tenantId, tenantId))).returning();
    res.json(updated);
    return;
  }

  // Valida o registro FINAL (campos novos por cima dos atuais)
  const merged = { ...existing, ...body } as Record<string, unknown>;
  const { data, error } = sanitizeRaffle(merged);
  if (!data) { res.status(400).json({ error }); return; }
  data.tenantId = existing.tenantId;
  data.createdById = existing.createdById;
  if (!(await isRaffleManager(req))) {
    data.vendedorIds = [req.session.userId!];
    data.sectorIds = null;
    data.sessionKeys = null;
  }
  const [updated] = await db.update(rafflesTable).set(data)
    .where(and(eq(rafflesTable.id, id), eq(rafflesTable.tenantId, tenantId))).returning();
  res.json(updated);
});

router.delete("/raffles/:id", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  const { raffle, status, error } = await loadOwnRaffle(req, id, tenantId);
  if (!raffle) { res.status(status!).json({ error }); return; }
  await db.delete(rafflesTable).where(and(eq(rafflesTable.id, id), eq(rafflesTable.tenantId, tenantId)));
  res.json({ ok: true });
});

// Prévia: quantos clientes participam com os filtros atuais.
router.get("/raffles/:id/eligible", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  const { raffle, status, error } = await loadOwnRaffle(req, id, tenantId);
  if (!raffle) { res.status(status!).json({ error }); return; }
  const pool = await eligibleClients(raffle);
  res.json({ count: pool.length });
});

// Sortear agora (manual). Por padrão já manda a mensagem pros ganhadores,
// igual sempre — corpo `{ autoSend: false }` (pedido 14/09) sorteia e grava a
// lista sem mandar nada ainda, pra revisar antes de disparar (ver
// send-all/resend abaixo).
router.post("/raffles/:id/run", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  const { raffle, status, error } = await loadOwnRaffle(req, id, tenantId);
  if (!raffle) { res.status(status!).json({ error }); return; }
  const pool = await eligibleClients(raffle);
  if (pool.length === 0) { res.status(400).json({ error: "Nenhum cliente elegível com esses filtros" }); return; }
  const autoSend = (req.body as Record<string, unknown> | undefined)?.["autoSend"] !== false;
  try {
    const { draw, eligible } = await runRaffleDraw(raffle, `manual-${Date.now()}`, { autoSend });
    res.json({ draw, eligible });
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : "Não foi possível sortear agora" });
  }
});

router.get("/raffles/:id/draws", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  const { raffle, status, error } = await loadOwnRaffle(req, id, tenantId);
  if (!raffle) { res.status(status!).json({ error }); return; }
  const rows = await db.select().from(raffleDrawsTable)
    .where(eq(raffleDrawsTable.raffleId, id)).orderBy(desc(raffleDrawsTable.id)).limit(50);
  res.json(rows);
});

// Enviar (1ª tentativa de um ganhador em modo revisão) ou reenviar (envio
// anterior falhou) a mensagem de UM ganhador — sem limite de cliques manuais
// (diferente do reenvio automático, que para em MAX_AUTO_ATTEMPTS).
router.post("/raffles/:id/draws/:drawId/resend", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  const drawId = parseInt(String(req.params.drawId), 10);
  const { raffle, status, error } = await loadOwnRaffle(req, id, tenantId);
  if (!raffle) { res.status(status!).json({ error }); return; }
  if (isNaN(drawId)) { res.status(400).json({ error: "ID inválido" }); return; }
  const [draw] = await db.select().from(raffleDrawsTable)
    .where(and(eq(raffleDrawsTable.id, drawId), eq(raffleDrawsTable.raffleId, id))).limit(1);
  if (!draw) { res.status(404).json({ error: "Sorteio não encontrado" }); return; }

  const phone = String((req.body as Record<string, unknown> | undefined)?.["phone"] ?? "");
  const winners = ((draw.winners as Winner[] | null) ?? []).map((w) => ({ ...w }));
  const idx = winners.findIndex((w) => w.phone === phone && !w.sent);
  if (idx === -1) { res.status(400).json({ error: "Ganhador não encontrado ou mensagem já enviada" }); return; }

  winners[idx] = await attemptSendToWinner(raffle, winners[idx]!);
  const [updated] = await db.update(raffleDrawsTable).set({ winners })
    .where(eq(raffleDrawsTable.id, drawId)).returning();
  res.json({ draw: updated, sent: winners[idx]!.sent });
});

// Envia (ou reenvia) de uma vez só pra TODOS os ganhadores ainda sem
// confirmação de entrega num sorteio — sobretudo útil pro sorteio criado em
// modo "revisar antes de enviar" (pedido 14/09), onde ninguém foi mandado
// ainda e clicar um por um seria inviável com dezenas/centenas de ganhadores.
router.post("/raffles/:id/draws/:drawId/send-all", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  const drawId = parseInt(String(req.params.drawId), 10);
  const { raffle, status, error } = await loadOwnRaffle(req, id, tenantId);
  if (!raffle) { res.status(status!).json({ error }); return; }
  if (isNaN(drawId)) { res.status(400).json({ error: "ID inválido" }); return; }
  const [draw] = await db.select().from(raffleDrawsTable)
    .where(and(eq(raffleDrawsTable.id, drawId), eq(raffleDrawsTable.raffleId, id))).limit(1);
  if (!draw) { res.status(404).json({ error: "Sorteio não encontrado" }); return; }

  const winners = ((draw.winners as Winner[] | null) ?? []).map((w) => ({ ...w }));
  const pendingCount = winners.filter((w) => !w.sent).length;
  if (pendingCount === 0) { res.status(400).json({ error: "Nenhum ganhador pendente de envio" }); return; }

  let sentCount = 0;
  for (let i = 0; i < winners.length; i++) {
    if (winners[i]!.sent) continue;
    winners[i] = await attemptSendToWinner(raffle, winners[i]!);
    if (winners[i]!.sent) sentCount++;
  }
  const [updated] = await db.update(raffleDrawsTable).set({ winners })
    .where(eq(raffleDrawsTable.id, drawId)).returning();
  res.json({ draw: updated, sentCount, totalPending: pendingCount });
});

export default router;
