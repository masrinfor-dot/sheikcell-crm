import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { createReadStream, existsSync, statSync } from "fs";
import path from "path";
import { db, chatNotificationsTable, conversationsTable, messagesTable, sectorsTable, usersTable, conversationParticipantsTable, conversationPinsTable, messagePinsTable, attendanceLogsTable, attendanceStartEventsTable, crmContactsTable, crmCustomFieldsTable, chatLabelsTable, whatsappSessionsTable, quickRepliesTable, scheduledMessagesTable, tasksTable, taskAssigneesTable, crmPurchasesTable, appSettingsTable } from "@workspace/db";
import { eq, desc, and, or, lt, gte, ilike, sql, inArray, notInArray, isNull, asc } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { requireAuth, requireAdminOrSupervisor, tenantIdOf, requireTenant, isTenantSuspended } from "../middlewares/auth";
import { checkPerm, requirePerm, getCurrentAllowedSessionKeys } from "../lib/permissions";
import { requireChatAccess } from "../lib/moduleAccess";
import {
  broadcast,
  sseEmitter,
  bufferedEventsSince,
  reconnectStrategy,
  presenceConnect,
  presenceDisconnect,
  type BufferedEvent,
} from "../lib/sseEmitter";
import { isPotentialConversation, isRestrictedConversation, restrictedRecipients, POTENTIAL_EXCLUDED_STATUSES } from "../lib/conversationScope";
import { ensureCrmContactForConversation, syncCrmAttendant } from "../lib/crmSync";
import { sendOutboundText } from "../lib/outbound";
import { normalizePhone, phoneVariants } from "../lib/phone";
import { getSurveySettings, buildSurveyMessage } from "../lib/surveySettings";
import { fetchLinkPreview, firstUrlIn } from "../lib/linkPreview";

// Sinaliza que a pesquisa está desligada nas configurações (não é erro).
class SurveyDisabled extends Error {}
import {
  processInboundWA,
  processMetaInboundWA,
  type InboundWAPayload,
  type MetaInboundWAPayload,
  MEDIA_DIR,
} from "../lib/whatsappInbound";

const router: IRouter = Router();

// ─── SSE real-time stream ──────────────────────────────────────────────────
router.get("/chat/events", requireAuth, requireChatAccess(), async (req: Request, res: Response): Promise<void> => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const userRole = req.session.userRole!;
  const userSectorId = req.session.userSectorId;
  const userId = req.session.userId!;
  // Multi-loja: a loja da sessão. Eventos NUNCA cruzam a fronteira de loja —
  // superadmin (sem loja) e sessões antigas não recebem nada (fail closed).
  const sessionTenantId = tenantIdOf(req);
  // Permissões do vendedor: recarregadas a cada 30s para que uma revogação
  // feita pelo admin pare de vazar eventos de Potenciais sem exigir reconexão.
  let canSeePotenciais = await checkPerm(req, "ver_potenciais");
  // Mesma lógica pro filtro de linha de WhatsApp: sem isso, um vendedor com
  // stream já aberto continuava recebendo eventos de linhas que o admin
  // acabou de revogar (ou não recebia as recém-liberadas) até reconectar.
  let allowedSessionKeys = await getCurrentAllowedSessionKeys(req);
  const permRefresh = setInterval(() => {
    checkPerm(req, "ver_potenciais").then((v) => { canSeePotenciais = v; }).catch(() => {});
    getCurrentAllowedSessionKeys(req).then((v) => { allowedSessionKeys = v; }).catch(() => {});
    // Loja suspensa: derruba streams já abertos (a suspensão não pode esperar
    // o usuário reconectar). Fecha a conexão — o EventSource do cliente tenta
    // reconectar e é barrado no requireAuth.
    if (sessionTenantId != null) {
      isTenantSuspended(sessionTenantId).then((s) => { if (s) res.end(); }).catch(() => {});
    }
  }, 30_000);

  // Mirror canAccessConversation exactly.
  // - Eventos de conversas RESTRITAS (com responsável ou finalizadas) trazem
  //   `restrictedTo` (responsável + participantes): admin recebe sempre;
  //   supervisor só se o setor bater (supervisor sem setor = global);
  //   vendedor só se estiver na lista.
  // - Demais eventos: potenciais chegam a todos; o resto é escopado por setor.
  const allowed = (ev: { tenantId: number; sectorId: number | null; isPotential?: boolean; restrictedTo?: number[] | null; sessionKey?: string | null }): boolean => {
    // Fronteira de loja em primeiro lugar: só entrega eventos da MESMA loja.
    // Sem loja na sessão (superadmin / sessão antiga) = não recebe nada.
    if (sessionTenantId == null || ev.tenantId !== sessionTenantId) return false;
    if (userRole === "admin") return true;
    // Supervisor: enxerga tudo, em qualquer setor, sem restrição — a
    // privacidade entre vendedores continua valendo só para o papel vendedor.
    if (userRole === "supervisor") return true;
    // Conversa RESTRITA (já tem responsável/participante) sempre chega pra
    // quem é responsável/participante, MESMO fora das linhas de WhatsApp
    // liberadas — foi transferida de propósito pra esse vendedor. Checar
    // isso ANTES do filtro de linha evita que um atendimento transferido
    // pra fora da linha permitida suma de vez (nem pro antigo, nem pro novo
    // responsável).
    if (ev.restrictedTo != null) return ev.restrictedTo.includes(userId);
    // Vendedor com restrição de linha de WhatsApp: evento de potencial/setor
    // fora das linhas liberadas nunca chega.
    if (allowedSessionKeys != null && ev.sessionKey != null && !allowedSessionKeys.includes(ev.sessionKey)) return false;
    if (ev.isPotential && canSeePotenciais) return true;
    return ev.sectorId != null && ev.sectorId === userSectorId;
  };

  const writeEvent = (ev: { id?: number; event: string; data: unknown }) => {
    if (ev.id != null) res.write(`id: ${ev.id}\n`);
    res.write(`event: ${ev.event}\n`);
    res.write(`data: ${JSON.stringify(ev.data)}\n\n`);
  };

  // sseEmitter.emit() chama todo stream aberto no processo (o filtro de
  // escopo roda dentro de allowed()) na mesma call stack de quem disparou o
  // broadcast — inclusive o POST de mensagem de outro usuário/conversa. Se
  // ESTE stream estiver numa conexão morta, res.write() pode lançar; sem
  // try/catch isso derruba o emit inteiro e o erro sobe para o handler alheio
  // (sem middleware de erro nem express-async-errors, o Express 5 responde
  // 500 pra ele, mesmo a mensagem dele já salva no banco). Isolado aqui: uma
  // conexão ruim só se remove a si mesma.
  const send = (payload: BufferedEvent) => {
    if (!allowed(payload)) return;
    try {
      writeEvent(payload);
    } catch {
      sseEmitter.off("broadcast", send);
      res.destroy();
    }
  };

  // ── Reconnect recovery ──
  // EventSource resends the id of the last event it received in the
  // `Last-Event-ID` header. Replay everything missed during the disconnection
  // so no inbound message is lost. If too much was missed (evicted from the
  // buffer) or the server restarted, tell the client to refetch from REST.
  const rawLastId = req.headers["last-event-id"];
  const sinceRaw = Array.isArray(rawLastId) ? rawLastId[0] : rawLastId;
  const sinceId = sinceRaw != null ? Number.parseInt(sinceRaw, 10) : NaN;
  if (Number.isFinite(sinceId)) {
    const strategy = reconnectStrategy(sinceId);
    if (strategy === "resync") {
      writeEvent({ event: "resync", data: { reason: "gap" } });
    } else if (strategy === "replay") {
      for (const ev of bufferedEventsSince(sinceId)) {
        if (allowed(ev)) writeEvent(ev);
      }
    }
  }

  sseEmitter.on("broadcast", send);

  // ── Heartbeat ──
  // Proxies and mobile networks can keep a TCP connection open long after it has
  // effectively died, leaving an attendant "connected" but receiving no events.
  // A periodic SSE comment (ignored by EventSource) keeps intermediaries from
  // idle-closing a healthy stream, and — crucially — the write attempt surfaces a
  // dead connection quickly: it fails/RSTs, the client's EventSource sees the drop
  // and reconnects, replaying anything missed (Last-Event-ID → replay/resync).
  const heartbeat = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 25_000);

  presenceConnect(userId);
  let closed = false; // garante teardown único (não descontar presença 2x)
  req.on("close", () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearInterval(permRefresh);
    sseEmitter.off("broadcast", send);
    presenceDisconnect(userId);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────
async function enrichConversation(conv: typeof conversationsTable.$inferSelect) {
  const [sector] = conv.sectorId
    ? await db.select().from(sectorsTable).where(eq(sectorsTable.id, conv.sectorId))
    : [];
  const [assignee] = conv.assigneeId
    ? await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(eq(usersTable.id, conv.assigneeId))
    : [];
  const participants = await db
    .select({ id: usersTable.id, name: usersTable.name })
    .from(conversationParticipantsTable)
    .innerJoin(usersTable, eq(conversationParticipantsTable.userId, usersTable.id))
    .where(eq(conversationParticipantsTable.conversationId, conv.id));
  return { ...conv, sector: sector ?? null, assignee: assignee ?? null, participants };
}

/**
 * Returns true if the requesting user is allowed to access the given conversation.
 * - Admin: acesso global.
 * - Conversa RESTRITA (com responsável ou finalizada): supervisor só do mesmo
 *   setor (supervisor sem setor = global); vendedor só se for o responsável ou
 *   participante.
 * - Demais conversas: supervisor global; vendedor no próprio setor; potenciais
 *   (leads novos sem dono) visíveis a qualquer vendedor.
 */
async function canAccessConversation(
  conv: Pick<typeof conversationsTable.$inferSelect, "id" | "sectorId" | "assigneeId" | "status" | "isArchived" | "sessionKey">,
  req: Request,
): Promise<boolean> {
  const userRole = req.session.userRole!;
  if (userRole === "admin") return true;
  const userId = req.session.userId!;
  const userSectorId = req.session.userSectorId;
  // Supervisor: acesso irrestrito a qualquer conversa, em qualquer setor
  // (inclusive já assumidas/finalizadas por outro vendedor). A privacidade
  // entre vendedores foi mantida de propósito — só admin/supervisor têm
  // visão global.
  if (userRole === "supervisor") return true;
  if (isRestrictedConversation(conv)) {
    // Conversa já tem dono (ou foi finalizada): responsável/participante
    // sempre acessa, MESMO fora das linhas de WhatsApp liberadas — foi
    // transferida de propósito pra esse vendedor, não é uma "descoberta" de
    // linha alheia. Checar isso ANTES do filtro de linha evita que um
    // atendimento transferido pra fora da linha permitida suma de vez (nem
    // pro antigo, nem pro novo responsável).
    if (conv.assigneeId === userId) return true;
    const [p] = await db.select({ userId: conversationParticipantsTable.userId })
      .from(conversationParticipantsTable)
      .where(and(
        eq(conversationParticipantsTable.conversationId, conv.id),
        eq(conversationParticipantsTable.userId, userId),
      ))
      .limit(1);
    return !!p;
  }
  // Vendedor com restrição de linha de WhatsApp (allowedSessionKeys): fora
  // das linhas liberadas, nem potencial nem conversa do próprio setor conta.
  const allowedSessionKeys = await getCurrentAllowedSessionKeys(req);
  if (allowedSessionKeys != null && !allowedSessionKeys.includes(conv.sessionKey)) return false;
  if (conv.sectorId != null && conv.sectorId === userSectorId) return true;
  return isPotentialConversation(conv) && (await checkPerm(req, "ver_potenciais"));
}

// ─── List conversations ────────────────────────────────────────────────────
router.get("/chat/conversations", requireAuth, requireChatAccess(), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { search, label, status, sectorId, assigneeId } = req.query as Record<string, string | undefined>;

  const userRole = req.session.userRole!;
  const userSectorId = req.session.userSectorId;

  // Multi-loja: base de tudo é a loja do usuário.
  const conditions = [eq(conversationsTable.tenantId, tenantId), eq(conversationsTable.isArchived, false)];

  // Conversas RESTRITAS (com responsável ou finalizadas) têm visibilidade
  // reduzida: só o responsável/participantes (vendedor), o admin e o
  // supervisor do MESMO setor as veem.
  const restricted = or(
    sql`${conversationsTable.assigneeId} IS NOT NULL`,
    inArray(conversationsTable.status, ["resolved", "archived"]),
  )!;

  if (userRole === "admin" || userRole === "supervisor") {
    // Admin e supervisor enxergam tudo (qualquer setor, qualquer status,
    // inclusive já assumidas/resolvidas por outro vendedor). O filtro de
    // setor abaixo é só o filtro OPCIONAL escolhido na tela, não uma
    // restrição de visibilidade.
    if (sectorId) conditions.push(eq(conversationsTable.sectorId, Number(sectorId)));
    // Filtro opcional por vendedor (assignee) na tela do admin/supervisor.
    // Sem isso, o filtro de vendedor era só client-side em cima do lote já
    // limitado a 100 (abaixo) — um vendedor com muitas conversas ativas
    // ficava com a contagem visivelmente menor do que a real.
    if (assigneeId) conditions.push(eq(conversationsTable.assigneeId, Number(assigneeId)));
  } else {
    // Vendedores are ALWAYS sector-scoped and must never see every conversation.
    // - potenciais (leads novos sem dono): visíveis a todos;
    // - conversas do próprio setor NÃO restritas (ex.: pendentes);
    // - conversas restritas apenas quando é o responsável ou participante.
    const userId = req.session.userId!;
    // Restrição por linha de WhatsApp (allowedSessionKeys, sempre fresca do
    // banco — ver getCurrentAllowedSessionKeys): vale pra "descobrir" conversa
    // por potencial/setor fora das linhas liberadas, mas NÃO deve esconder
    // uma conversa que já é sua (responsável/participante) — por isso entra
    // dentro de potencial/sectorUnrestricted abaixo, e não como condição
    // solta que também pegaria "mine". Sem essa distinção, um atendimento
    // transferido pra um vendedor de outra linha sumia de vez, sem aparecer
    // nem pro antigo nem pro novo responsável.
    const userAllowedSessionKeys = await getCurrentAllowedSessionKeys(req);
    const sessionScope = userAllowedSessionKeys != null
      ? (userAllowedSessionKeys.length ? inArray(conversationsTable.sessionKey, userAllowedSessionKeys) : sql`FALSE`)
      : null;
    // Permissão "ver_potenciais" desligada: o vendedor não vê os leads novos
    // de outros setores (só o escopo do próprio setor).
    let potencial = (await checkPerm(req, "ver_potenciais"))
      ? and(
          isNull(conversationsTable.assigneeId),
          notInArray(conversationsTable.status, [...POTENTIAL_EXCLUDED_STATUSES]),
        )!
      : sql`FALSE`;
    const mine = or(
      eq(conversationsTable.assigneeId, userId),
      sql`EXISTS (SELECT 1 FROM ${conversationParticipantsTable} WHERE ${conversationParticipantsTable.conversationId} = ${conversationsTable.id} AND ${conversationParticipantsTable.userId} = ${userId})`,
    )!;
    let sectorUnrestricted = userSectorId
      ? and(eq(conversationsTable.sectorId, userSectorId), sql`NOT (${restricted})`)!
      : sql`FALSE`;
    if (sessionScope) {
      potencial = and(potencial, sessionScope)!;
      sectorUnrestricted = and(sectorUnrestricted, sessionScope)!;
    }
    conditions.push(or(potencial, mine, sectorUnrestricted)!);
    // Resolvidas só aparecem para admin/supervisor: vendedor não vê
    // conversas finalizadas, nem as que ele mesmo finalizou.
    conditions.push(notInArray(conversationsTable.status, ["resolved", "archived"]));
  }

  if (status) conditions.push(eq(conversationsTable.status, status));
  if (search) {
    conditions.push(or(
      ilike(conversationsTable.name, `%${search}%`),
      ilike(conversationsTable.phone, `%${search}%`),
    )!);
  }
  if (label) {
    conditions.push(sql`${conversationsTable.labels} ILIKE ${'%' + label + '%'}`);
  }

  const rows = await db
    .select()
    .from(conversationsTable)
    .where(and(...conditions))
    .orderBy(desc(conversationsTable.lastMessageAt))
    .limit(100);

  const sectors = await db.select().from(sectorsTable).where(eq(sectorsTable.tenantId, tenantId));
  const users = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(eq(usersTable.tenantId, tenantId));
  const sectorMap = Object.fromEntries(sectors.map((s) => [s.id, s]));
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

  const convIds = rows.map((c) => c.id);
  const allParticipants = convIds.length > 0
    ? await db
        .select({ conversationId: conversationParticipantsTable.conversationId, id: usersTable.id, name: usersTable.name })
        .from(conversationParticipantsTable)
        .innerJoin(usersTable, eq(conversationParticipantsTable.userId, usersTable.id))
        .where(inArray(conversationParticipantsTable.conversationId, convIds))
    : [];
  const participantsMap: Record<number, { id: number; name: string }[]> = {};
  for (const p of allParticipants) {
    if (!participantsMap[p.conversationId]) participantsMap[p.conversationId] = [];
    participantsMap[p.conversationId].push({ id: p.id, name: p.name });
  }

  // Nível do cliente no CRM (Novo/Regular/VIP) para os filtros da central.
  // Casa por todas as variações plausíveis do número (com/sem DDI, com/sem o
  // 9º dígito) — contato do CRM salvo num formato antigo não pode "sumir"
  // da central só porque a conversa chegou num formato diferente.
  const normPhones = [...new Set(rows.map((c) => normalizePhone(c.phone)).filter(Boolean))];
  const phoneVariantSet = [...new Set(normPhones.flatMap((p) => phoneVariants(p)))];
  const crmRows = phoneVariantSet.length > 0
    ? await db
        .select({ phone: crmContactsTable.phone, sectorId: crmContactsTable.sectorId, profile: crmContactsTable.profile })
        .from(crmContactsTable)
        .where(and(eq(crmContactsTable.tenantId, tenantId), eq(crmContactsTable.isArchived, false), inArray(crmContactsTable.phone, phoneVariantSet)))
    : [];
  const crmProfileMap: Record<string, string> = {};
  for (const r of crmRows) {
    if (!r.phone) continue;
    const canonical = normalizePhone(r.phone);
    // Prioriza o contato do mesmo setor; telefone sozinho fica como fallback.
    crmProfileMap[`${canonical}|${r.sectorId ?? ""}`] = r.profile;
    if (!(canonical in crmProfileMap)) crmProfileMap[canonical] = r.profile;
  }

  // Conversas fixadas pelo usuário logado (fixar é individual).
  const myPins = convIds.length > 0
    ? await db
        .select({ conversationId: conversationPinsTable.conversationId })
        .from(conversationPinsTable)
        .where(and(eq(conversationPinsTable.userId, req.session.userId!), inArray(conversationPinsTable.conversationId, convIds)))
    : [];
  const pinnedSet = new Set(myPins.map((p) => p.conversationId));

  const enriched = rows.map((c) => {
    const np = normalizePhone(c.phone);
    return {
      ...c,
      sector: c.sectorId ? (sectorMap[c.sectorId] ?? null) : null,
      assignee: c.assigneeId ? (userMap[c.assigneeId] ?? null) : null,
      participants: participantsMap[c.id] ?? [],
      crmProfile: crmProfileMap[`${np}|${c.sectorId ?? ""}`] ?? crmProfileMap[np] ?? null,
      pinned: pinnedSet.has(c.id),
    };
  });

  res.json(enriched);
});

// ─── Get single conversation ───────────────────────────────────────────────
router.get("/chat/conversations/:id", requireAuth, requireChatAccess(), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [conv] = await db.select().from(conversationsTable).where(and(eq(conversationsTable.id, id), eq(conversationsTable.tenantId, tenantId)));
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada" }); return; }
  if (!(await canAccessConversation(conv, req))) { res.status(403).json({ error: "Acesso negado" }); return; }
  res.json(await enrichConversation(conv));
});

// ─── Fixar / desafixar conversa (por usuário) ──────────────────────────────
router.post("/chat/conversations/:id/pin", requireAuth, requireChatAccess(), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [conv] = await db.select().from(conversationsTable).where(and(eq(conversationsTable.id, id), eq(conversationsTable.tenantId, tenantId)));
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada" }); return; }
  if (!(await canAccessConversation(conv, req))) { res.status(403).json({ error: "Acesso negado" }); return; }
  await db.insert(conversationPinsTable)
    .values({ tenantId, conversationId: id, userId: req.session.userId! })
    .onConflictDoNothing();
  res.json({ ok: true, pinned: true });
});

router.delete("/chat/conversations/:id/pin", requireAuth, requireChatAccess(), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [conv] = await db.select().from(conversationsTable).where(and(eq(conversationsTable.id, id), eq(conversationsTable.tenantId, tenantId)));
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada" }); return; }
  if (!(await canAccessConversation(conv, req))) { res.status(403).json({ error: "Acesso negado" }); return; }
  await db.delete(conversationPinsTable)
    .where(and(eq(conversationPinsTable.conversationId, id), eq(conversationPinsTable.userId, req.session.userId!)));
  res.json({ ok: true, pinned: false });
});

// ─── Fixar / desafixar MENSAGEM (compartilhado, estilo WhatsApp) ───────────
// Diferente do /pin acima (favoritar a conversa inteira, por usuário): aqui é
// marcar uma mensagem específica já enviada, visível pra todo mundo que abre
// a conversa. Suporta várias mensagens fixadas ao mesmo tempo (message_pins é
// uma tabela de junção, uma linha por mensagem fixada).
router.get("/chat/conversations/:id/pinned-messages", requireAuth, requireChatAccess(), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [conv] = await db.select().from(conversationsTable).where(and(eq(conversationsTable.id, id), eq(conversationsTable.tenantId, tenantId)));
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada" }); return; }
  if (!(await canAccessConversation(conv, req))) { res.status(403).json({ error: "Acesso negado" }); return; }
  const rows = await db
    .select({
      messageId: messagePinsTable.messageId,
      pinnedBy: messagePinsTable.pinnedBy,
      pinnedAt: messagePinsTable.createdAt,
      content: messagesTable.content,
      type: messagesTable.type,
      senderName: messagesTable.senderName,
      direction: messagesTable.direction,
    })
    .from(messagePinsTable)
    .innerJoin(messagesTable, eq(messagePinsTable.messageId, messagesTable.id))
    .where(eq(messagePinsTable.conversationId, id))
    .orderBy(desc(messagePinsTable.createdAt));
  res.json(rows);
});

router.post("/chat/messages/:id/pin", requireAuth, requireChatAccess(), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [msg] = await db.select().from(messagesTable).where(and(eq(messagesTable.id, id), eq(messagesTable.tenantId, tenantId))).limit(1);
  if (!msg) { res.status(404).json({ error: "Mensagem não encontrada" }); return; }
  const [conv] = await db.select().from(conversationsTable).where(and(eq(conversationsTable.id, msg.conversationId), eq(conversationsTable.tenantId, tenantId))).limit(1);
  if (!conv || !(await canAccessConversation(conv, req))) { res.status(403).json({ error: "Acesso negado" }); return; }
  await db.insert(messagePinsTable)
    .values({ tenantId, conversationId: conv.id, messageId: id, pinnedBy: req.session.userId! })
    .onConflictDoNothing();
  const pinned = {
    messageId: msg.id, pinnedBy: req.session.userId!, pinnedAt: new Date().toISOString(),
    content: msg.content, type: msg.type, senderName: msg.senderName, direction: msg.direction,
  };
  broadcast("message_pinned", { conversationId: conv.id, pinned }, { tenantId: conv.tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv) });
  res.json({ ok: true, pinned });
});

router.delete("/chat/messages/:id/pin", requireAuth, requireChatAccess(), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [msg] = await db.select().from(messagesTable).where(and(eq(messagesTable.id, id), eq(messagesTable.tenantId, tenantId))).limit(1);
  if (!msg) { res.status(404).json({ error: "Mensagem não encontrada" }); return; }
  const [conv] = await db.select().from(conversationsTable).where(and(eq(conversationsTable.id, msg.conversationId), eq(conversationsTable.tenantId, tenantId))).limit(1);
  if (!conv || !(await canAccessConversation(conv, req))) { res.status(403).json({ error: "Acesso negado" }); return; }
  await db.delete(messagePinsTable).where(and(eq(messagePinsTable.messageId, id), eq(messagePinsTable.conversationId, conv.id)));
  broadcast("message_unpinned", { conversationId: conv.id, messageId: id }, { tenantId: conv.tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv) });
  res.json({ ok: true, messageId: id });
});

// Resolve o preview de "responder mensagem": só aceita citar uma mensagem da
// MESMA conversa (evita vazar conteúdo de outra conversa/loja via replyToId
// arbitrário) — se o id não existir ali, a resposta segue sem citação.
async function resolveReplyTo(
  replyToId: number | undefined,
  convId: number,
  tenantId: number,
): Promise<{ replyToId: number | null; replyTo: { id: number; senderName: string | null; content: string; type: string } | null }> {
  if (replyToId == null) return { replyToId: null, replyTo: null };
  const [row] = await db
    .select({ id: messagesTable.id, senderName: messagesTable.senderName, content: messagesTable.content, type: messagesTable.type })
    .from(messagesTable)
    .where(and(
      eq(messagesTable.id, replyToId),
      eq(messagesTable.conversationId, convId),
      eq(messagesTable.tenantId, tenantId),
    ))
    .limit(1);
  if (!row) return { replyToId: null, replyTo: null };
  return { replyToId: row.id, replyTo: row };
}

// Item 5 do roadmap: liga/desliga o prefixo "*Nome:*" que o cliente vê no
// WhatsApp — a identificação em si (senderId/senderName) é sempre gravada,
// isso só controla se aparece pro cliente. Default "true" preserva o
// comportamento de sempre mostrar (ver settings.ts DEFAULTS).
async function isAttendantNameVisibleToCustomer(tenantId: number): Promise<boolean> {
  const [row] = await db.select().from(appSettingsTable)
    .where(and(eq(appSettingsTable.tenantId, tenantId), eq(appSettingsTable.key, "attendant_name_visible_to_customer")))
    .limit(1);
  return row ? row.value !== "false" : true;
}

// ─── Get messages ──────────────────────────────────────────────────────────
router.get("/chat/conversations/:id/messages", requireAuth, requireChatAccess(), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);

  const [conv] = await db.select().from(conversationsTable).where(and(eq(conversationsTable.id, id), eq(conversationsTable.tenantId, tenantId))).limit(1);
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada" }); return; }
  if (!(await canAccessConversation(conv, req))) { res.status(403).json({ error: "Acesso negado" }); return; }

  // Zera o contador de não lidas só quando quem abre é o responsável (ou um
  // vendedor, se a conversa ainda não tem dono). Admin/supervisor espiando a
  // conversa NÃO pode apagar a notificação do vendedor que vai atender.
  const viewerRole = req.session.userRole!;
  const clearsUnread = conv.assigneeId != null
    ? conv.assigneeId === req.session.userId
    : viewerRole === "vendedor";
  if (clearsUnread && conv.unreadCount > 0) {
    await db.update(conversationsTable).set({ unreadCount: 0 }).where(eq(conversationsTable.id, id));
  }

  // Sempre as MAIS RECENTES: ordena decrescente, corta, e devolve em ordem
  // cronológica. (Antes cortava as 200 mais ANTIGAS — em conversas longas as
  // mensagens novas "sumiam" do histórico.)
  // Paginação por cursor: ?before=<messageId> devolve o bloco ANTERIOR à
  // mensagem indicada (mesma ordem cronológica), para "carregar mais" no topo.
  const PAGE = 500;
  const beforeId = req.query.before != null
    ? parseInt(Array.isArray(req.query.before) ? String(req.query.before[0]) : String(req.query.before), 10)
    : null;

  let cursorFilter = undefined;
  if (beforeId != null && Number.isFinite(beforeId)) {
    const [anchor] = await db.select({ id: messagesTable.id, createdAt: messagesTable.createdAt })
      .from(messagesTable)
      .where(and(eq(messagesTable.id, beforeId), eq(messagesTable.conversationId, id)))
      .limit(1);
    if (!anchor) { res.status(404).json({ error: "Mensagem de referência não encontrada" }); return; }
    // Estritamente antes do anchor na ordem (createdAt, id).
    cursorFilter = or(
      lt(messagesTable.createdAt, anchor.createdAt),
      and(eq(messagesTable.createdAt, anchor.createdAt), lt(messagesTable.id, anchor.id)),
    );
  }

  const repliedMsg = alias(messagesTable, "repliedMsg");

  const page = await db
    .select({
      id: messagesTable.id,
      tenantId: messagesTable.tenantId,
      conversationId: messagesTable.conversationId,
      content: messagesTable.content,
      direction: messagesTable.direction,
      type: messagesTable.type,
      status: messagesTable.status,
      senderName: messagesTable.senderName,
      senderId: messagesTable.senderId,
      senderPhone: messagesTable.senderPhone,
      mediaUrl: messagesTable.mediaUrl,
      transcript: messagesTable.transcript,
      externalId: messagesTable.externalId,
      createdAt: messagesTable.createdAt,
      editedAt: messagesTable.editedAt,
      deletedAt: messagesTable.deletedAt,
      reactions: messagesTable.reactions,
      replyToId: messagesTable.replyToId,
      replyToSenderName: repliedMsg.senderName,
      replyToContent: repliedMsg.content,
      replyToType: repliedMsg.type,
    })
    .from(messagesTable)
    .leftJoin(repliedMsg, eq(messagesTable.replyToId, repliedMsg.id))
    .where(cursorFilter
      ? and(eq(messagesTable.conversationId, id), cursorFilter)
      : eq(messagesTable.conversationId, id))
    .orderBy(desc(messagesTable.createdAt), desc(messagesTable.id))
    .limit(PAGE + 1);

  const hasMore = page.length > PAGE;
  const msgs = (hasMore ? page.slice(0, PAGE) : page).reverse().map(({ replyToSenderName, replyToContent, replyToType, ...m }) => ({
    ...m,
    replyTo: m.replyToId != null ? { id: m.replyToId, senderName: replyToSenderName, content: replyToContent, type: replyToType } : null,
  }));

  // Compat: sem cursor e sem cabeçalho, clientes antigos continuam recebendo o
  // array puro. O cabeçalho X-Has-More indica se existe bloco mais antigo.
  res.setHeader("X-Has-More", hasMore ? "1" : "0");
  res.json(msgs);
});

// ─── Editar / apagar mensagem (só quem enviou, ou admin/supervisor) ───────
// IMPORTANTE: isso edita/apaga só o REGISTRO aqui dentro do sistema — não
// reenvia uma revogação pro WhatsApp do cliente. Fazer isso de verdade (igual
// o "apagar para todos" do WhatsApp) exigiria guardar a chave da mensagem do
// Baileys no envio e chamar a ponte pra revogar/editar do lado do protocolo,
// o que ainda não existe hoje. Enquanto isso não é construído, "editado" e
// "mensagem apagada" aparecem só pra quem usa o sistema — o cliente continua
// vendo o texto original no aparelho dele.
async function loadOwnMessageForEdit(
  id: number, tenantId: number, req: import("express").Request, res: import("express").Response,
): Promise<{ msg: typeof messagesTable.$inferSelect; conv: typeof conversationsTable.$inferSelect } | null> {
  const [msg] = await db.select().from(messagesTable)
    .where(and(eq(messagesTable.id, id), eq(messagesTable.tenantId, tenantId))).limit(1);
  if (!msg) { res.status(404).json({ error: "Mensagem não encontrada" }); return null; }
  if (msg.direction !== "outbound") {
    res.status(400).json({ error: "Só é possível editar/apagar mensagens enviadas por nós" });
    return null;
  }
  const isOwner = msg.senderId === req.session.userId;
  const isModerator = req.session.userRole === "admin" || req.session.userRole === "supervisor";
  if (!isOwner && !isModerator) {
    res.status(403).json({ error: "Só quem enviou (ou admin/supervisor) pode editar/apagar" });
    return null;
  }
  const [conv] = await db.select().from(conversationsTable)
    .where(and(eq(conversationsTable.id, msg.conversationId), eq(conversationsTable.tenantId, tenantId))).limit(1);
  if (!conv || !(await canAccessConversation(conv, req))) { res.status(403).json({ error: "Acesso negado" }); return null; }
  return { msg, conv };
}

router.patch("/chat/messages/:id", requireAuth, requireChatAccess(), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const { content } = req.body as { content?: string };
  const clean = typeof content === "string" ? content.trim().slice(0, 4096) : "";
  if (!clean) { res.status(400).json({ error: "Mensagem vazia" }); return; }

  const loaded = await loadOwnMessageForEdit(id, tenantId, req, res);
  if (!loaded) return;
  const { msg, conv } = loaded;
  if (msg.type !== "text") { res.status(400).json({ error: "Só é possível editar mensagens de texto" }); return; }
  if (msg.deletedAt) { res.status(400).json({ error: "Mensagem apagada não pode ser editada" }); return; }

  const [updated] = await db.update(messagesTable)
    .set({ content: clean, editedAt: new Date() })
    .where(eq(messagesTable.id, id))
    .returning();
  const { replyTo } = await resolveReplyTo(updated!.replyToId ?? undefined, updated!.conversationId, tenantId);
  const outMsg = { ...updated!, replyTo };
  broadcast("message_updated", { conversationId: msg.conversationId, message: outMsg }, { tenantId: conv.tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv) });
  res.json(outMsg);
});

router.delete("/chat/messages/:id", requireAuth, requireChatAccess(), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);

  const loaded = await loadOwnMessageForEdit(id, tenantId, req, res);
  if (!loaded) return;
  const { msg, conv } = loaded;
  if (msg.deletedAt) {
    const { replyTo } = await resolveReplyTo(msg.replyToId ?? undefined, msg.conversationId, tenantId);
    res.json({ ...msg, replyTo });
    return;
  }

  const [updated] = await db.update(messagesTable)
    .set({ deletedAt: new Date() })
    .where(eq(messagesTable.id, id))
    .returning();
  const { replyTo } = await resolveReplyTo(updated!.replyToId ?? undefined, updated!.conversationId, tenantId);
  const outMsg = { ...updated!, replyTo };
  broadcast("message_updated", { conversationId: msg.conversationId, message: outMsg }, { tenantId: conv.tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv) });
  res.json(outMsg);
});

// ─── Send media ────────────────────────────────────────────────────────────
router.post("/chat/conversations/:id/media", requireAuth, requireChatAccess(), requirePerm("enviar_midia"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const { base64, mimetype: rawMimetype, filename, caption, ptt, replyToId: replyToIdRaw } = req.body as {
    base64?: string;
    mimetype?: string;
    filename?: string;
    caption?: string;
    ptt?: boolean; // nota de voz (gravação do microfone)
    replyToId?: number;
  };

  if (!base64 || !rawMimetype) {
    res.status(400).json({ error: "base64 e mimetype são obrigatórios" });
    return;
  }
  // Navegadores mandam tipos com parâmetros, ex. "audio/webm;codecs=opus" —
  // normaliza para o tipo base antes de validar.
  const mimetype = rawMimetype.split(";")[0].trim().toLowerCase();

  const ALLOWED_MIMES_OUT = new Set([
    "image/jpeg", "image/png", "image/gif", "image/webp",
    "video/mp4", "video/3gpp", "video/webm", "video/quicktime",
    "audio/ogg", "audio/mpeg", "audio/mp4", "audio/webm", "audio/aac", "audio/wav",
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ]);
  if (!ALLOWED_MIMES_OUT.has(mimetype)) {
    res.status(400).json({ error: "Tipo de arquivo não suportado" });
    return;
  }

  const isImage = mimetype.startsWith("image/");
  const isVideo = mimetype.startsWith("video/");
  const isAudio = mimetype.startsWith("audio/");
  const msgType: "image" | "video" | "audio" | "doc" =
    isImage ? "image" : isVideo ? "video" : isAudio ? "audio" : "doc";
  const waType: "image" | "video" | "audio" | "document" =
    isImage ? "image" : isVideo ? "video" : isAudio ? "audio" : "document";

  const senderName = req.session.userName ?? "Atendente";
  const showNameToCustomer = await isAttendantNameVisibleToCustomer(tenantId);

  const [conv] = await db.select().from(conversationsTable).where(and(eq(conversationsTable.id, id), eq(conversationsTable.tenantId, tenantId))).limit(1);
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada" }); return; }
  if (!(await canAccessConversation(conv, req))) { res.status(403).json({ error: "Acesso negado" }); return; }
  if (conv.assigneeId == null) {
    res.status(409).json({ error: "Inicie o atendimento antes de enviar mensagens" });
    return;
  }

  // Save file to media directory
  const { writeFile, mkdir } = await import("fs/promises");
  const { randomUUID } = await import("crypto");
  await mkdir(MEDIA_DIR, { recursive: true });

  const mimeToExt: Record<string, string> = {
    "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
    "video/mp4": "mp4", "video/3gpp": "3gp", "video/webm": "webm", "video/quicktime": "mov",
    // "weba" para áudio webm — "webm" fica reservado para vídeo no GET /chat/media
    "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a",
    "audio/webm": "weba", "audio/aac": "aac", "audio/wav": "wav",
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  };
  const ext = mimeToExt[mimetype] ?? "bin";
  const savedFilename = `${randomUUID()}.${ext}`;
  const buf = Buffer.from(base64, "base64");

  const MAX_BYTES = 20 * 1024 * 1024;
  if (buf.byteLength > MAX_BYTES) {
    res.status(400).json({ error: "Arquivo muito grande (máximo 20 MB)" });
    return;
  }

  await writeFile(path.join(MEDIA_DIR, savedFilename), buf);
  const mediaUrl = `/api/chat/media/${savedFilename}`;

  const displayName = filename ?? (isImage ? "📷 Foto" : isVideo ? "🎥 Vídeo" : isAudio ? "🎤 Áudio" : "📄 Documento");
  const baseContent = isImage ? "📷 Foto" : isVideo ? "🎥 Vídeo" : isAudio ? "🎤 Áudio" : `📄 ${displayName}`;
  const content = caption ? `${baseContent}\n${caption}` : baseContent;

  const { replyToId, replyTo } = await resolveReplyTo(replyToIdRaw, id, tenantId);

  // Nome/tamanho reais do documento — o mediaUrl salvo usa nome aleatório
  // (savedFilename), então sem isso o balão só teria o UUID pra mostrar.
  const metadata = msgType === "doc" && filename
    ? { fileName: filename, fileSize: buf.byteLength, mimeType: mimetype }
    : null;

  const [inserted] = await db.insert(messagesTable).values({
    tenantId,
    conversationId: id,
    content,
    direction: "outbound",
    type: msgType,
    status: "sent",
    senderName,
    senderId: req.session.userId!,
    mediaUrl,
    replyToId,
    metadata,
  }).returning();
  const msg = { ...inserted!, replyTo };

  await db.update(conversationsTable).set({
    lastMessage: content,
    lastMessageDirection: "outbound",
    lastMessageSenderName: senderName,
    lastMessageAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(conversationsTable.id, id));

  broadcast("message", { conversationId: id, message: msg }, { tenantId: conv.tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv) });

  // Forward to WhatsApp bridge
  if (conv.channel === "whatsapp" && conv.phone) {
    const bridgeUrl = process.env["WHATSAPP_BRIDGE_URL"] ?? "http://localhost:3002";
    const bridgeSecret = createHmac(
      "sha256",
      process.env["SESSION_SECRET"] ?? "sheikcell-dev-only-secret",
    ).update("whatsapp-bridge-v1").digest("hex");
    let delivered = true;
    try {
      const r = await fetch(`${bridgeUrl}/whatsapp/send-media`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Bridge-Secret": bridgeSecret,
        },
        body: JSON.stringify({
          to: conv.phone,
          type: waType,
          base64,
          mimetype,
          filename: filename ?? savedFilename,
          // Cliente vê quem está atendendo (áudios não têm legenda no WhatsApp),
          // exceto se a loja desligou isso em Configurações (item 5 do roadmap).
          caption: isAudio ? caption
            : !showNameToCustomer ? caption
            : (caption ? `*${senderName}:*\n${caption}` : `*${senderName}:*`),
          ptt: isAudio ? (ptt ?? false) : undefined,
          session: conv.sessionKey,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        req.log.warn(
          { status: r.status, body },
          "WhatsApp bridge media delivery failed — media saved but not delivered",
        );
        delivered = false;
      }
    } catch (err) {
      req.log.warn({ err }, "WhatsApp bridge unreachable — media saved but not delivered");
      delivered = false;
    }

    if (!delivered) {
      const [failedRow] = await db.update(messagesTable)
        .set({ status: "failed" })
        .where(eq(messagesTable.id, msg.id))
        .returning();
      if (failedRow) {
        const failedMsg = { ...failedRow, replyTo };
        broadcast("message_updated", { conversationId: id, message: failedMsg }, { tenantId: conv.tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv) });
        res.status(201).json(failedMsg);
        return;
      }
    }
  }

  res.status(201).json(msg);
});

// ─── Nota interna ──────────────────────────────────────────────────────────
// Visível só para a equipe, nunca enviada ao WhatsApp do cliente. Por isso não
// atualiza lastMessage/lastMessageDirection da conversa (não conta como
// resposta ao cliente para a lógica de "aguardando").
router.post("/chat/conversations/:id/notes", requireAuth, requireChatAccess(), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const { content } = req.body as { content?: string };
  if (!content?.trim()) { res.status(400).json({ error: "Nota vazia" }); return; }

  const senderName = req.session.userName ?? "Atendente";

  const [conv] = await db.select().from(conversationsTable).where(and(eq(conversationsTable.id, id), eq(conversationsTable.tenantId, tenantId))).limit(1);
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada" }); return; }
  if (!(await canAccessConversation(conv, req))) { res.status(403).json({ error: "Acesso negado" }); return; }

  const [msg] = await db.insert(messagesTable).values({
    tenantId,
    conversationId: id,
    content: content.trim(),
    direction: "outbound",
    type: "note",
    status: "sent",
    senderName,
    senderId: req.session.userId!,
  }).returning();

  broadcast("message", { conversationId: id, message: msg }, { tenantId: conv.tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv) });
  res.status(201).json(msg);
});

// ─── Send message ──────────────────────────────────────────────────────────
router.post("/chat/conversations/:id/messages", requireAuth, requireChatAccess(), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const { content, replyToId: replyToIdRaw } = req.body as { content?: string; replyToId?: number };
  if (!content?.trim()) { res.status(400).json({ error: "Mensagem vazia" }); return; }

  const senderName = req.session.userName ?? "Atendente";
  const showNameToCustomer = await isAttendantNameVisibleToCustomer(tenantId);

  const [conv] = await db.select().from(conversationsTable).where(and(eq(conversationsTable.id, id), eq(conversationsTable.tenantId, tenantId))).limit(1);
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada" }); return; }
  if (!(await canAccessConversation(conv, req))) { res.status(403).json({ error: "Acesso negado" }); return; }
  if (conv.assigneeId == null) {
    res.status(409).json({ error: "Inicie o atendimento antes de enviar mensagens" });
    return;
  }

  const { replyToId, replyTo } = await resolveReplyTo(replyToIdRaw, id, tenantId);

  const [inserted] = await db.insert(messagesTable).values({
    tenantId,
    conversationId: id,
    content: content.trim(),
    direction: "outbound",
    type: "text",
    status: "sent",
    senderName,
    senderId: req.session.userId!,
    replyToId,
  }).returning();
  const msg = { ...inserted!, replyTo };

  // Preview de link: só pra mensagem que o próprio atendente escreveu (não
  // pra texto recebido do cliente — ver processInboundWA). Fire-and-forget:
  // não atrasa a resposta nem o envio pro WhatsApp; quando o preview chega,
  // atualiza a mensagem e manda o mesmo evento usado pra edição/status.
  const previewUrl = firstUrlIn(content.trim());
  if (previewUrl) {
    fetchLinkPreview(previewUrl, req.session.userId!)
      .then(async (preview) => {
        if (!preview) return;
        const [updated] = await db.update(messagesTable)
          .set({ metadata: { linkPreview: preview } })
          .where(eq(messagesTable.id, inserted!.id))
          .returning();
        if (!updated) return;
        broadcast("message_updated", { conversationId: id, message: { ...updated, replyTo } }, { tenantId: conv.tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv) });
      })
      .catch((err) => req.log.debug({ err }, "link preview: falhou"));
  }

  await db.update(conversationsTable).set({
    lastMessage: content.trim(),
    lastMessageDirection: "outbound",
    lastMessageSenderName: senderName,
    lastMessageAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(conversationsTable.id, id));

  broadcast("message", { conversationId: id, message: msg }, { tenantId: conv.tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv) });

  // Forward to WhatsApp bridge (now uses Meta Cloud API) if this is a WhatsApp conversation
  if (conv.channel === "whatsapp" && conv.phone) {
    const bridgeUrl = process.env["WHATSAPP_BRIDGE_URL"] ?? "http://localhost:3002";
    const bridgeSecret = createHmac(
      "sha256",
      process.env["SESSION_SECRET"] ?? "sheikcell-dev-only-secret",
    ).update("whatsapp-bridge-v1").digest("hex");
    let delivered = true;
    try {
      const r = await fetch(`${bridgeUrl}/whatsapp/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Bridge-Secret": bridgeSecret,
        },
        // Cliente vê quem está atendendo: "*Nome:*" antes da mensagem, exceto
        // se a loja desligou isso em Configurações (item 5 do roadmap).
        body: JSON.stringify({
          to: conv.phone,
          text: showNameToCustomer ? `*${senderName}:*\n${content.trim()}` : content.trim(),
          session: conv.sessionKey,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        req.log.warn(
          { status: r.status, body },
          "WhatsApp bridge delivery failed — message saved but not delivered",
        );
        delivered = false;
      }
    } catch (err) {
      req.log.warn({ err }, "WhatsApp bridge unreachable — message saved but not delivered");
      delivered = false;
    }

    if (!delivered) {
      const [failedRow] = await db.update(messagesTable)
        .set({ status: "failed" })
        .where(eq(messagesTable.id, msg.id))
        .returning();
      if (failedRow) {
        const failedMsg = { ...failedRow, replyTo };
        broadcast("message_updated", { conversationId: id, message: failedMsg }, { tenantId: conv.tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv) });
        res.status(201).json(failedMsg);
        return;
      }
    }
  }

  res.status(201).json(msg);
});

// Registra o evento de INÍCIO de um atendimento (transição real de "sem
// responsável" -> "com responsável") — append-only, nunca editado depois.
// Diferente de conversations.attendanceStartedAt (mutável, zerada em
// unassign/transferência), isto alimenta "iniciados por dia" em Relatórios
// de forma confiável mesmo que a conversa seja depois transferida/reaberta.
async function recordAttendanceStart(
  executor: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0],
  p: { tenantId: number; conversationId: number; attendantId: number; sectorId: number | null },
): Promise<number | null> {
  const [attendant] = await executor.select({ storeId: usersTable.storeId }).from(usersTable)
    .where(eq(usersTable.id, p.attendantId)).limit(1);
  await executor.insert(attendanceStartEventsTable).values({
    tenantId: p.tenantId,
    conversationId: p.conversationId,
    attendantId: p.attendantId,
    sectorId: p.sectorId,
    storeId: attendant?.storeId ?? null,
  });
  return attendant?.storeId ?? null;
}

// ─── Sync a finalized conversation into Visão Geral + CRM ───────────────────
// When a chat attendance is resolved we record it as an attendance log (so the
// dashboard "Finalizados"/recent feed counts it the same way as queue
// attendances) and ensure the customer exists in the CRM (find-or-create by
// normalized phone), keeping the three modules in sync.
async function syncResolvedConversation(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  conv: typeof conversationsTable.$inferSelect,
  resolutionReason?: string | null,
  // Resultado comercial informado no modal de finalização: houve venda? valor?
  sale?: { hadSale: boolean; amount: number; description: string } | null,
  // Retorna o id do attendance_log criado (ou null) para ligar a pesquisa de
  // satisfação enviada ao cliente à avaliação que ele responder.
): Promise<number | null> {
  const [attendant] = conv.assigneeId
    ? await tx.select().from(usersTable).where(eq(usersTable.id, conv.assigneeId)).limit(1)
    : [];
  // Attribute the attendance to the conversation's sector, falling back to the
  // assignee's sector so a conversation without an explicit sector still counts
  // on the dashboard when it was handled by a sectorized attendant.
  const effectiveSectorId = conv.sectorId ?? attendant?.sectorId ?? null;
  const [sector] = effectiveSectorId != null
    ? await tx.select().from(sectorsTable).where(and(eq(sectorsTable.id, effectiveSectorId), eq(sectorsTable.tenantId, conv.tenantId))).limit(1)
    : [];

  // 1) Attendance log — feeds the Visão Geral dashboard and CRM service history.
  //    sectorId is required (NOT NULL); skip the log only when the attendance
  //    cannot be attributed to any sector.
  let attendanceLogId: number | null = null;
  if (effectiveSectorId != null) {
    // Tempo de atendimento conta a partir de quando o vendedor assumiu a
    // conversa (attendanceStartedAt), não do primeiro contato do cliente —
    // senão conversas reabertas/tempo em espera inflam a média artificialmente.
    const serviceStart = conv.attendanceStartedAt ?? conv.createdAt;
    const serviceSeconds = Math.round((Date.now() - serviceStart.getTime()) / 1000);
    // Tempo de PRIMEIRA resposta: mede agilidade inicial (até a primeira
    // mensagem do atendente depois do início), diferente do tempo total
    // acima. Reaproveita o histórico de mensagens já existente — sem
    // precisar de tracking novo em tempo real.
    const [firstReply] = await tx.select({ createdAt: messagesTable.createdAt })
      .from(messagesTable)
      .where(and(
        eq(messagesTable.conversationId, conv.id),
        eq(messagesTable.direction, "outbound"),
        gte(messagesTable.createdAt, serviceStart),
      ))
      .orderBy(asc(messagesTable.createdAt))
      .limit(1);
    const firstResponseSeconds = firstReply
      ? Math.max(0, Math.round((firstReply.createdAt.getTime() - serviceStart.getTime()) / 1000))
      : null;
    const [log] = await tx.insert(attendanceLogsTable).values({
      tenantId: conv.tenantId,
      queueEntryId: 0, // chat attendances have no queue entry
      conversationId: conv.id,
      clientName: conv.name,
      clientContact: conv.phone,
      sectorId: effectiveSectorId,
      sectorName: sector?.name ?? "Desconhecido",
      attendantId: conv.assigneeId,
      attendantName: attendant?.name ?? null,
      storeId: conv.storeId ?? attendant?.storeId ?? null,
      channel: conv.channel,
      outcome: "completed",
      resolutionReason: resolutionReason?.trim() || null,
      serviceTimeSeconds: serviceSeconds >= 0 ? serviceSeconds : null,
      firstResponseSeconds,
      hadSale: sale ? sale.hadSale : null,
      saleAmount: sale?.hadSale ? String(sale.amount) : null,
    }).returning({ id: attendanceLogsTable.id });
    attendanceLogId = log?.id ?? null;
  }

  // 2) CRM contact — link the conversation to a CRM record (find-or-create by
  //    phone). The lookup is scoped to the conversation's effective sector so we
  //    never read or mutate a same-phone contact that belongs to another sector.
  const normalizedPhone = normalizePhone(conv.phone);
  const phoneVariantsForFinalize = phoneVariants(conv.phone);
  // Grupos/comunidades não entram no CRM (não são um cliente com telefone).
  if (normalizedPhone && !(conv.phone ?? "").includes("@g.us")) {
    const sectorCondition = effectiveSectorId != null
      ? eq(crmContactsTable.sectorId, effectiveSectorId)
      : isNull(crmContactsTable.sectorId);
    const [existing] = await tx.select().from(crmContactsTable)
      .where(and(eq(crmContactsTable.tenantId, conv.tenantId), eq(crmContactsTable.isArchived, false), inArray(crmContactsTable.phone, phoneVariantsForFinalize), sectorCondition))
      .limit(1);
    let contactId: number | null = null;
    if (existing) {
      contactId = existing.id;
      await tx.update(crmContactsTable)
        .set({
          updatedAt: new Date(),
          ...(existing.phone !== normalizedPhone ? { phone: normalizedPhone } : {}),
        })
        .where(eq(crmContactsTable.id, existing.id));
    } else {
      const [created] = await tx.insert(crmContactsTable).values({
        tenantId: conv.tenantId,
        name: conv.name,
        contact: conv.phone,
        phone: normalizedPhone,
        sectorId: effectiveSectorId,
        attendantId: conv.assigneeId ?? null,
        status: "active",
        profile: "Novo",
      }).returning();
      contactId = created?.id ?? null;
    }

    // 3) Venda informada ao finalizar → vira uma compra no histórico do cliente
    //    no CRM, atualizando o total gasto e o perfil (Regular/VIP) — mesma
    //    regra da compra lançada manualmente no CRM.
    if (sale?.hadSale && sale.amount > 0 && contactId != null) {
      await tx.insert(crmPurchasesTable).values({
        tenantId: conv.tenantId,
        contactId,
        description: sale.description || `Venda no atendimento — ${conv.name}`,
        amount: String(sale.amount),
        notes: resolutionReason?.trim() || null,
      });
      const all = await tx.select().from(crmPurchasesTable).where(eq(crmPurchasesTable.contactId, contactId));
      const total = all.reduce((s, p) => s + parseFloat(String(p.amount ?? "0")), 0);
      const profileUpdate: Record<string, unknown> = { totalPurchases: String(total), updatedAt: new Date() };
      if (total >= 5000) profileUpdate.profile = "VIP";
      else if (total >= 1000) profileUpdate.profile = "Regular";
      await tx.update(crmContactsTable).set(profileUpdate).where(eq(crmContactsTable.id, contactId));
    }
  }

  return attendanceLogId;
}

// ─── Update conversation ───────────────────────────────────────────────────
router.patch("/chat/conversations/:id", requireAuth, requireChatAccess(), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const { status, labels, sectorId, assigneeId, name, isArchived, resolutionReason, hadSale, saleAmount, saleDescription } = req.body as {
    status?: string; labels?: string; sectorId?: number;
    assigneeId?: number; name?: string; isArchived?: boolean;
    resolutionReason?: string;
    hadSale?: boolean; saleAmount?: number | string; saleDescription?: string;
  };

  const [conv] = await db.select().from(conversationsTable).where(and(eq(conversationsTable.id, id), eq(conversationsTable.tenantId, tenantId))).limit(1);
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada" }); return; }
  if (!(await canAccessConversation(conv, req))) { res.status(403).json({ error: "Acesso negado" }); return; }

  const userRole = req.session.userRole!;

  // Permissões individuais do vendedor: finalizar e transferir são configuráveis.
  if (userRole === "vendedor") {
    if ((status === "resolved" || status === "archived" || isArchived === true) && !(await checkPerm(req, "finalizar"))) {
      res.status(403).json({ error: "Você não tem permissão para finalizar atendimentos. Fale com o administrador." });
      return;
    }
    // Máquina de estados: só dá pra finalizar um atendimento que já está
    // "Ativo" (com responsável). Potencial/Pendente precisam ser assumidos
    // primeiro — evita finalizar direto um lead que ninguém atendeu ainda.
    if ((status === "resolved" || status === "archived" || isArchived === true) && conv.assigneeId == null) {
      res.status(400).json({ error: "Esse atendimento ainda não está Ativo. Assuma o atendimento antes de finalizar." });
      return;
    }
    if (sectorId !== undefined && sectorId !== conv.sectorId && !(await checkPerm(req, "transferir"))) {
      res.status(403).json({ error: "Você não tem permissão para transferir conversas de setor. Fale com o administrador." });
      return;
    }
    if (assigneeId !== undefined && assigneeId !== conv.assigneeId && !(await checkPerm(req, "transferir"))) {
      res.status(403).json({ error: "Você não tem permissão para transferir conversas. Fale com o administrador." });
      return;
    }
  }

  // Transferência para outro vendedor: valida o destino (ativo; vendedor só
  // recebe conversa do próprio setor). Vendedor não pode "des-atribuir".
  if (assigneeId != null && assigneeId !== conv.assigneeId) {
    const [target] = await db.select().from(usersTable).where(and(eq(usersTable.id, assigneeId), eq(usersTable.tenantId, tenantId))).limit(1);
    if (!target || !target.isActive) { res.status(400).json({ error: "Vendedor de destino inválido" }); return; }
    // Vendedor só transfere para outro vendedor — nunca para admin/supervisor.
    if (userRole === "vendedor" && target.role !== "vendedor") {
      res.status(400).json({ error: "Só é possível transferir para um vendedor" });
      return;
    }
    if (target.role === "vendedor" && target.sectorId != null) {
      const destSector = sectorId ?? conv.sectorId;
      if (destSector != null && target.sectorId !== destSector) {
        res.status(400).json({ error: "Esse vendedor é de outro setor. Transfira o setor junto ou escolha um vendedor do setor da conversa." });
        return;
      }
    }
    // Mesma trava de linha restrita aplicada em POST /participants: vendedor
    // preso a uma linha específica de WhatsApp não pode virar responsável de
    // conversa de outra linha (senão fica sem receber os eventos em tempo real).
    if (target.allowedSessionKeys != null && !target.allowedSessionKeys.includes(conv.sessionKey)) {
      res.status(400).json({ error: "Esse vendedor só recebe conversas de uma linha específica de WhatsApp e não pode ser responsável por esta conversa." });
      return;
    }
  } else if (userRole === "vendedor" && assigneeId === null && conv.assigneeId != null) {
    res.status(403).json({ error: "Apenas admin ou supervisor podem remover o responsável" });
    return;
  }

  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (status !== undefined) update.status = status;
  if (labels !== undefined) update.labels = labels;
  if (name !== undefined) update.name = name;
  if (isArchived !== undefined) update.isArchived = isArchived;
  // Finalizar/arquivar encerra a pendência — zera o contador de não lidas
  // aqui mesmo, porque o zeramento normal (ao abrir a conversa) só acontece
  // pro responsável (assignee); sem isso, uma conversa finalizada por
  // admin/supervisor (ou finalizada sem a última mensagem ter sido aberta)
  // ficava com unreadCount preso pra sempre, inflando os badges de contagem.
  if (update.status === "resolved" || update.status === "archived" || update.isArchived === true) {
    update.unreadCount = 0;
  }
  // Reatribuir responsável segue exclusivo de admin/supervisor; transferir de
  // setor também é permitido ao vendedor autorizado (permissão "transferir").
  let isSectorTransfer = false;
  let isGenuineStart = false;
  if (userRole === "admin" || userRole === "supervisor" || userRole === "vendedor") {
    if (sectorId !== undefined && (userRole !== "vendedor" || sectorId !== conv.sectorId)) update.sectorId = sectorId;
    // Vendedor autorizado transfere para outro vendedor (nunca "des-atribui" —
    // já bloqueado acima); a conversa vai direto para os Ativos do destino.
    if (assigneeId !== undefined && (userRole !== "vendedor" || assigneeId != null)) {
      update.assigneeId = assigneeId;
      if (userRole === "vendedor" && status === undefined) update.status = "open";
    }
    // Transferring a conversation to a DIFFERENT sector hands it off to another
    // team of vendedores. Route it into that sector's "Pendentes" queue by
    // clearing the assignee and setting status "pending", so a vendedor there
    // reviews and assumes it ("Iniciar atendimento") instead of it silently
    // staying under the previous vendedor. Skipped when the caller explicitly
    // sets a status/assignee in the same request or the conversation is
    // already finished.
    // Vendedor: a transferência SEMPRE segue o fluxo de handoff (limpa o
    // responsável e vai para Pendentes) — campos extras do cliente são
    // ignorados para impedir que uma transferência mantenha dono/status.
    isSectorTransfer =
      sectorId !== undefined &&
      sectorId !== conv.sectorId &&
      (userRole === "vendedor" || (assigneeId === undefined && status === undefined)) &&
      conv.status !== "resolved" &&
      conv.status !== "archived";
    if (isSectorTransfer && userRole === "vendedor") {
      delete update.status;
      delete update.isArchived;
    }
    if (isSectorTransfer) {
      update.assigneeId = null;
      update.status = "pending";
    }
    // Data/hora de INÍCIO do atendimento: marcada quando a conversa ganha um
    // responsável (estava sem dono) e limpa quando volta para a fila sem dono.
    // A loja (storeId) acompanha QUALQUER atendente novo (mesmo reatribuição
    // direta entre dois atendentes já ativos), mas NÃO é zerada ao perder o
    // responsável — mantém a última loja conhecida, pra "não resolvidos"
    // ainda conseguir localizar a loja mesmo sem atendente atual.
    if ("assigneeId" in update) {
      const newAssignee = update.assigneeId as number | null;
      if (newAssignee != null) {
        isGenuineStart = conv.assigneeId == null;
        if (isGenuineStart) update.attendanceStartedAt = new Date();
        const [na] = await db.select({ storeId: usersTable.storeId }).from(usersTable)
          .where(eq(usersTable.id, newAssignee)).limit(1);
        update.storeId = na?.storeId ?? null;
      } else {
        update.attendanceStartedAt = null;
      }
    }
  }

  // Run the update and the dashboard/CRM sync atomically. A locked read of the
  // pre-update status guarantees the sync fires exactly once per transition into
  // "resolved" even under concurrent PATCH requests, and rolls back the status
  // change if the sync fails.
  let resolvedLogId: number | null = null;
  // Motivo de finalização (quando esta chamada está resolvendo a conversa agora),
  // lido fora da transação pra alimentar o card do CRM logo abaixo.
  let resolutionReasonForCrm: string | null | undefined;
  const updated = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(conversationsTable)
      .where(and(eq(conversationsTable.id, id), eq(conversationsTable.tenantId, tenantId))).for("update").limit(1);
    const wasResolved = locked?.status === "resolved";

    const [row] = await tx.update(conversationsTable).set(update)
      .where(and(eq(conversationsTable.id, id), eq(conversationsTable.tenantId, tenantId))).returning();

    if (isGenuineStart && row?.assigneeId != null) {
      await recordAttendanceStart(tx, { tenantId, conversationId: id, attendantId: row.assigneeId, sectorId: row.sectorId });
    }

    if (status === "resolved" && !wasResolved) {
      // Sanitize untrusted client input: only accept a string motive, capped.
      const cleanReason = typeof resolutionReason === "string" ? resolutionReason.slice(0, 500) : null;
      resolutionReasonForCrm = cleanReason;
      // Venda informada no modal: sanitiza valor (número positivo) e descrição.
      const amountNum = Number(saleAmount);
      const sale = typeof hadSale === "boolean"
        ? {
            hadSale,
            amount: hadSale && Number.isFinite(amountNum) && amountNum > 0 ? amountNum : 0,
            description: typeof saleDescription === "string" ? saleDescription.trim().slice(0, 300) : "",
          }
        : null;
      resolvedLogId = await syncResolvedConversation(tx, row, cleanReason, sale);
    }
    return row;
  });

  // Pesquisa de satisfação: ao finalizar um atendimento de WhatsApp (1:1, não
  // grupo), envia a pergunta de nota pelo mesmo caminho do envio manual — que
  // passa pela fila anti-ban do bridge — e marca a conversa como aguardando a
  // resposta ligada ao attendance_log recém-criado. Falha no envio nunca
  // desfaz a finalização (a pesquisa é melhor esforço).
  if (
    resolvedLogId != null &&
    updated.channel === "whatsapp" &&
    updated.phone &&
    !updated.phone.includes("@g.us")
  ) {
    try {
      const surveyCfg = await getSurveySettings(tenantId);
      if (!surveyCfg.enabled) throw new SurveyDisabled();
      // Marca a espera ANTES do envio: o cliente pode responder no instante em
      // que a pergunta chega (antes de o bridge retornar), e essa resposta já
      // precisa encontrar a pesquisa pendente — senão a nota se perde e a
      // conversa reabre.
      await db.update(conversationsTable)
        .set({
          pendingSurveyLogId: resolvedLogId,
          surveySentAt: new Date(),
          // Retrato da configuração no envio: mudar a escala/prazo/cupom depois
          // não afeta esta pesquisa já enviada.
          surveyScaleMax: surveyCfg.scaleMax,
          surveyWindowHours: surveyCfg.responseWindowHours,
          surveyRewardText: surveyCfg.rewardEnabled && surveyCfg.rewardText.trim() ? surveyCfg.rewardText.trim() : null,
          // Pesquisa nova = lembrete novo (um por atendimento).
          surveyReminderSentAt: null,
        })
        .where(and(eq(conversationsTable.id, updated.id), eq(conversationsTable.tenantId, tenantId)));
      const delivered = await sendOutboundText(
        updated.id,
        buildSurveyMessage(surveyCfg, resolvedLogId),
        "Pesquisa de satisfação",
      );
      if (!delivered) {
        // Envio falhou: desfaz a espera — mas só se ela ainda apontar para ESTE
        // log (uma resposta concorrente ou uma pesquisa mais nova nunca é apagada).
        await db.update(conversationsTable)
          .set({ pendingSurveyLogId: null, surveySentAt: null, surveyScaleMax: null, surveyWindowHours: null, surveyRewardText: null, surveyReminderSentAt: null })
          .where(and(
            eq(conversationsTable.id, updated.id),
            eq(conversationsTable.tenantId, tenantId),
            eq(conversationsTable.pendingSurveyLogId, resolvedLogId),
          ));
      }
    } catch (err) {
      if (!(err instanceof SurveyDisabled)) {
        console.error("[survey] falha ao enviar pesquisa de satisfação:", err);
      }
    }
  }

  // Deliver to everyone who could see it BEFORE the change (potenciais are
  // cross-sector visible, so read wasPotential from the pre-update row) as well
  // as everyone who can see it now.
  const wasPotential = isPotentialConversation(conv);
  const recipients = await restrictedRecipients(updated);
  // Espelha responsável E coluna no cartão do CRM (transferência, finalização,
  // reabertura etc.): qualquer mudança de dono ou status move o cartão junto.
  if (updated.assigneeId !== conv.assigneeId || updated.status !== conv.status || updated.isArchived !== conv.isArchived) {
    await syncCrmAttendant(updated, resolutionReasonForCrm);
  }
  broadcast("conversation_updated", updated, { tenantId: updated.tenantId, sectorId: updated.sectorId, sessionKey: updated.sessionKey, isPotential: wasPotential || isPotentialConversation(updated), restrictedTo: recipients });
  // Transição para RESTRITA (ganhou responsável ou foi finalizada): quem via a
  // conversa antes (setor/potencial) e não está na lista de autorizados precisa
  // removê-la da tela. O evento leva só o id + quem pode mantê-la (sem conteúdo).
  if (recipients != null && !isRestrictedConversation(conv)) {
    broadcast("conversation_hidden", { id: updated.id, keepFor: recipients, sectorId: updated.sectorId }, { tenantId: updated.tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: wasPotential });
  }
  // On a sector transfer the broadcast above targets the NEW sector, so the
  // ORIGIN sector's vendedores would otherwise never learn the conversation
  // left. Notify them explicitly so they drop it from their list.
  if (isSectorTransfer && conv.sectorId != null && conv.sectorId !== updated.sectorId) {
    broadcast("conversation_updated", updated, { tenantId: updated.tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: false });
  }
  res.json(updated);
});

// ─── Claim conversation (self-assign / take from queue) ────────────────────
// Any authenticated user may take a conversation they can access and assign it
// to themselves, moving it from "Pendentes" (queue) to "Ativos". This is a
// sector-scoped self-assignment, so it is safe for vendedores who cannot
// otherwise change assigneeId via the PATCH route.
router.post("/chat/conversations/:id/claim", requireAuth, requireChatAccess(), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);

  const [conv] = await db.select().from(conversationsTable).where(and(eq(conversationsTable.id, id), eq(conversationsTable.tenantId, tenantId))).limit(1);
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada" }); return; }
  if (!(await canAccessConversation(conv, req))) { res.status(403).json({ error: "Acesso negado" }); return; }
  // Permissão "ver_potenciais": sem ela o vendedor não pode assumir leads novos.
  if (isPotentialConversation(conv) && !(await checkPerm(req, "ver_potenciais"))) {
    res.status(403).json({ error: "Você não tem permissão para assumir Potenciais. Fale com o administrador." });
    return;
  }
  // Only conversations that are not already taken by someone else may be claimed.
  // Re-claiming a conversation already assigned to the current user is idempotent.
  if (conv.assigneeId != null && conv.assigneeId !== req.session.userId) {
    res.status(409).json({ error: "Conversa já está em atendimento por outro vendedor" });
    return;
  }

  // When a vendedor claims a potencial from another sector, move it into their
  // own sector so it stays properly scoped to them afterwards.
  const userRole = req.session.userRole!;
  const userSectorId = req.session.userSectorId;
  const isGenuineStart = conv.assigneeId == null;
  const [claimant] = await db.select({ storeId: usersTable.storeId }).from(usersTable)
    .where(eq(usersTable.id, req.session.userId!)).limit(1);
  const claimSet: Partial<typeof conversationsTable.$inferInsert> = {
    assigneeId: req.session.userId,
    status: "pending",
    updatedAt: new Date(),
    storeId: claimant?.storeId ?? null,
    // Início do atendimento: só marca na primeira vez (re-claim é idempotente).
    ...(isGenuineStart ? { attendanceStartedAt: new Date() } : {}),
  };
  if (userRole !== "admin" && userRole !== "supervisor" && userSectorId && conv.sectorId !== userSectorId) {
    claimSet.sectorId = userSectorId;
  }

  // If the conversation was a potencial BEFORE the claim, every vendedor could
  // see it, so the transition must reach them all (they'll drop it from their
  // "Potenciais" list). A normal same-sector claim stays sector-scoped and must
  // NOT be broadcast cross-sector.
  const wasPotential = isPotentialConversation(conv);

  // Atomic: only claims if still unassigned (or already mine) at write time —
  // two vendedores clicking at the same time can't both take the conversation.
  const [updated] = await db.update(conversationsTable)
    .set(claimSet)
    .where(and(
      eq(conversationsTable.id, id),
      eq(conversationsTable.tenantId, tenantId),
      or(isNull(conversationsTable.assigneeId), eq(conversationsTable.assigneeId, req.session.userId!)),
    )).returning();
  if (!updated) {
    res.status(409).json({ error: "Conversa já está em atendimento por outro vendedor" });
    return;
  }
  if (isGenuineStart) {
    await recordAttendanceStart(db, { tenantId, conversationId: id, attendantId: req.session.userId!, sectorId: updated.sectorId });
  }

  const claimRecipients = await restrictedRecipients(updated);
  await syncCrmAttendant(updated);
  broadcast("conversation_updated", updated, { tenantId: updated.tenantId, sectorId: updated.sectorId, sessionKey: updated.sessionKey, isPotential: wasPotential, restrictedTo: claimRecipients });
  // A conversa ficou restrita ao vendedor que assumiu: avisa quem a via antes
  // (potencial cross-sector ou fila do setor) para removê-la da lista.
  if (claimRecipients != null) {
    broadcast("conversation_hidden", { id: updated.id, keepFor: claimRecipients, sectorId: updated.sectorId }, { tenantId: updated.tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: wasPotential });
  }
  res.json(updated);
});

// ─── WhatsApp connections (read-only, for labeling) ────────────────────────
// Lista leve das conexões de WhatsApp (número de atendimento) para que o
// frontend identifique por qual conexão cada conversa chega. Diferente de
// /whatsapp/sessions (admin), aqui qualquer usuário logado pode ler — só
// nome/numero, sem QR nem status detalhado.
router.get("/chat/wa-sessions", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await db
    .select({
      sessionKey: whatsappSessionsTable.sessionKey,
      displayName: whatsappSessionsTable.displayName,
      phoneNumber: whatsappSessionsTable.phoneNumber,
      color: whatsappSessionsTable.color,
      icon: whatsappSessionsTable.icon,
    })
    .from(whatsappSessionsTable)
    .where(eq(whatsappSessionsTable.tenantId, tenantId))
    .orderBy(whatsappSessionsTable.id);
  res.json(rows);
});

// ─── Excluir atendimento (admin ou supervisor) ─────────────────────────────
// Remove definitivamente a conversa (mensagens, participantes, agendamentos
// e histórico de início de atendimento juntos). Antes só era permitido em
// Potenciais (lead novo sem dono), depois virou admin em qualquer categoria
// (Pendentes/Ativos/Resolvidas) e agora também libera supervisor (a pedido
// explícito do cliente). Ação irreversível: some o histórico de mensagens da
// conversa, mas NÃO apaga a ficha do cliente no CRM (isso é só a
// conversa/atendimento em si).
router.delete("/chat/conversations/:id", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [conv] = await db.select().from(conversationsTable).where(and(eq(conversationsTable.id, id), eq(conversationsTable.tenantId, tenantId))).limit(1);
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada" }); return; }
  const wasPotential = isPotentialConversation(conv);
  const recipients = await restrictedRecipients(conv);

  await db.transaction(async (tx) => {
    await tx.delete(messagesTable).where(eq(messagesTable.conversationId, id));
    await tx.delete(conversationParticipantsTable).where(eq(conversationParticipantsTable.conversationId, id));
    await tx.delete(conversationPinsTable).where(eq(conversationPinsTable.conversationId, id));
    // scheduled_messages não tem cascade -- sem isso a exclusão falharia
    // (violação de FK) sempre que a conversa tivesse um agendamento pendente.
    await tx.delete(scheduledMessagesTable).where(eq(scheduledMessagesTable.conversationId, id));
    await tx.delete(attendanceStartEventsTable).where(eq(attendanceStartEventsTable.conversationId, id));
    await tx.delete(conversationsTable).where(and(eq(conversationsTable.id, id), eq(conversationsTable.tenantId, tenantId)));
  });

  // Potenciais são visíveis a todos DA LOJA; conversas já assumidas/resolvidas
  // são restritas a quem podia vê-las antes (setor/participantes/responsável).
  broadcast("conversation_deleted", { id }, { tenantId: conv.tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: wasPotential, restrictedTo: wasPotential ? null : recipients });
  res.json({ ok: true });
});

// ─── Uso atual da trava anti-disparo em massa (Atendimento ativo) ─────────
// Deixa o front avisar ANTES de tentar criar ("você já usou 8/10 essa hora"),
// em vez de só descobrir o limite quando a criação é recusada com 429.
router.get("/chat/outbound-usage", requireAuth, requireChatAccess(), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const requested = parseInt(String(req.query["assigneeId"] ?? ""), 10);
  const userRole = req.session.userRole!;
  // Vendedor só vê o próprio uso; admin/supervisor pode consultar qualquer
  // atendente da loja (pra decidir por quem vai criar o atendimento ativo).
  const assigneeId = userRole === "vendedor" || !Number.isFinite(requested)
    ? req.session.userId!
    : requested;

  const settingsRows = await db.select().from(appSettingsTable)
    .where(and(eq(appSettingsTable.tenantId, tenantId), inArray(appSettingsTable.key, ["outbound_hourly_limit", "outbound_daily_limit"])));
  const settingsMap = Object.fromEntries(settingsRows.map((r) => [r.key, r.value]));
  const hourlyLimit = Math.max(1, parseInt(settingsMap["outbound_hourly_limit"] ?? "10", 10) || 10);
  const dailyLimit = Math.max(1, parseInt(settingsMap["outbound_daily_limit"] ?? "40", 10) || 40);
  const hourAgo = new Date(Date.now() - 60 * 60_000);
  const dayAgo = new Date(Date.now() - 24 * 60 * 60_000);
  const countSince = async (since: Date) => {
    const [row] = await db.select({ count: sql<number>`count(*)` })
      .from(conversationsTable)
      .where(and(
        eq(conversationsTable.tenantId, tenantId),
        eq(conversationsTable.assigneeId, assigneeId),
        eq(conversationsTable.channel, "whatsapp"),
        gte(conversationsTable.createdAt, since),
      ));
    return Number(row?.count ?? 0);
  };
  const [hourlyUsed, dailyUsed] = await Promise.all([countSince(hourAgo), countSince(dayAgo)]);
  res.json({ hourly: { used: hourlyUsed, limit: hourlyLimit }, daily: { used: dailyUsed, limit: dailyLimit } });
});

// ─── Create conversation manually ─────────────────────────────────────────
router.post("/chat/conversations", requireAuth, requireChatAccess(), requirePerm("criar_atendimento"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { phone, name, channel, sectorId, assigneeId: requestedAssigneeId, sessionKey: requestedSessionKey } = req.body as {
    phone?: string; name?: string; channel?: string; sectorId?: number; assigneeId?: number; sessionKey?: string;
  };
  if (!phone || !name) { res.status(400).json({ error: "Telefone e nome obrigatórios" }); return; }

  // Linha de WhatsApp (canal) do atendimento manual: antes sempre nascia na
  // linha "default", então o mesmo número (ex.: atacado vs. varejo, duas
  // conexões de WhatsApp diferentes) não conseguia ter um segundo atendimento
  // criado manualmente enquanto o primeiro estivesse em andamento. Agora quem
  // cria escolhe a linha (quando a loja tem mais de uma conectada); "default"
  // continua sendo o valor padrão quando não é informado.
  const tenantSessions = await db.select({ sessionKey: whatsappSessionsTable.sessionKey })
    .from(whatsappSessionsTable).where(eq(whatsappSessionsTable.tenantId, tenantId));
  const validSessionKeys = new Set(["default", ...tenantSessions.map((s) => s.sessionKey)]);
  if (requestedSessionKey != null && !validSessionKeys.has(requestedSessionKey)) {
    res.status(400).json({ error: "Linha de WhatsApp inválida." });
    return;
  }
  const targetSessionKey = requestedSessionKey ?? "default";

  // Vendedor restrito a outras linhas ficaria trancado fora da conversa que
  // ele mesmo acabou de criar — barra antes, com uma mensagem clara, em vez
  // de deixar um atendimento órfão.
  const allowedSessionKeys = await getCurrentAllowedSessionKeys(req);
  if (allowedSessionKeys != null && !allowedSessionKeys.includes(targetSessionKey)) {
    res.status(403).json({ error: "Você não tem acesso a essa linha de WhatsApp para criar atendimentos manuais. Fale com o administrador." });
    return;
  }

  // Bloqueia atendimento duplicado: se já existe conversa EM ANDAMENTO (não
  // finalizada/arquivada) para esse número NA MESMA LINHA de WhatsApp, não
  // cria outra. Duas linhas diferentes (ex.: atacado e varejo) são canais
  // independentes — o mesmo cliente pode ter um atendimento aberto em cada
  // uma ao mesmo tempo. Compara contra todas as variações plausíveis do
  // número (com/sem DDI, com/sem o 9º dígito), pois o valor salvo pode ter
  // formato diferente do digitado.
  const digits = phone.replace(/\D/g, "");
  const dupCandidates = phoneVariants(phone);
  if (digits && dupCandidates.length > 0) {
    const [dup] = await db.select({
      id: conversationsTable.id,
      name: conversationsTable.name,
      status: conversationsTable.status,
      assigneeId: conversationsTable.assigneeId,
    })
      .from(conversationsTable)
      .where(and(
        eq(conversationsTable.tenantId, tenantId),
        notInArray(conversationsTable.status, ["resolved", "archived"]),
        inArray(conversationsTable.phone, dupCandidates),
        eq(conversationsTable.sessionKey, targetSessionKey),
      ))
      .limit(1);
    if (dup) {
      const quem = dup.assigneeId != null ? "já está em atendimento" : "já está na fila aguardando atendimento";
      res.status(409).json({
        error: `Este número ${quem} nesta linha de WhatsApp (${dup.name}). Abra a conversa existente em vez de criar outra.`,
        conversationId: dup.id,
      });
      return;
    }
  }

  // Número precisa EXISTIR no WhatsApp para abrir atendimento de WhatsApp.
  // Se o bridge estiver fora do ar ou desconectado, libera (não trava a loja).
  if ((channel ?? "whatsapp") === "whatsapp" && digits) {
    const bridgeUrl = process.env["WHATSAPP_BRIDGE_URL"] ?? "http://localhost:3002";
    const bridgeSecret = createHmac(
      "sha256",
      process.env["SESSION_SECRET"] ?? "sheikcell-dev-only-secret",
    ).update("whatsapp-bridge-v1").digest("hex");
    try {
      const r = await fetch(`${bridgeUrl}/whatsapp/check-number`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Bridge-Secret": bridgeSecret },
        body: JSON.stringify({ phone: digits }),
        signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) {
        const check = await r.json() as { exists?: boolean };
        if (check.exists === false) {
          res.status(400).json({ error: `O número ${digits} não existe no WhatsApp. Confira o DDD e o nono dígito antes de criar o atendimento.` });
          return;
        }
      }
      // 503 (desconectado) ou outro status: segue sem bloquear.
    } catch {
      // Bridge inacessível: segue sem bloquear.
    }
  }

  const userRole = req.session.userRole!;
  const userSectorId = req.session.userSectorId;

  // Vendedores must create conversations in their own sector only
  const effectiveSectorId = (userRole === "admin" || userRole === "supervisor")
    ? (sectorId ?? userSectorId ?? 1)
    : (userSectorId ?? 1);

  // Atendente responsável: vendedor sempre vira o próprio dono (não escolhe
  // outro). Admin/supervisor pode indicar quem vai tocar esse "atendimento
  // ativo" — precisa existir, estar ativo e ser da mesma loja.
  let targetAssigneeId: number | null = null;
  if (userRole === "vendedor") {
    targetAssigneeId = req.session.userId!;
  } else if (requestedAssigneeId != null) {
    const [target] = await db.select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.id, requestedAssigneeId), eq(usersTable.tenantId, tenantId), eq(usersTable.isActive, true)))
      .limit(1);
    if (!target) { res.status(400).json({ error: "Atendente responsável inválido" }); return; }
    targetAssigneeId = target.id;
  }

  // Trava anti-disparo em massa: só se aplica a "atendimento ativo" de
  // verdade — canal WhatsApp (Baileys, sem API oficial da Meta = risco real
  // de ban) E já nasce com responsável (vai mandar mensagem na hora).
  // Conversa criada sem responsável (admin joga na fila) não conta: ninguém
  // mandou mensagem pra esse número ainda.
  if ((channel ?? "manual") === "whatsapp" && targetAssigneeId != null) {
    const settingsRows = await db.select().from(appSettingsTable)
      .where(and(eq(appSettingsTable.tenantId, tenantId), inArray(appSettingsTable.key, ["outbound_hourly_limit", "outbound_daily_limit"])));
    const settingsMap = Object.fromEntries(settingsRows.map((r) => [r.key, r.value]));
    const hourlyLimit = Math.max(1, parseInt(settingsMap["outbound_hourly_limit"] ?? "10", 10) || 10);
    const dailyLimit = Math.max(1, parseInt(settingsMap["outbound_daily_limit"] ?? "40", 10) || 40);
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60_000);
    const countSince = async (since: Date) => {
      const [row] = await db.select({ count: sql<number>`count(*)` })
        .from(conversationsTable)
        .where(and(
          eq(conversationsTable.tenantId, tenantId),
          eq(conversationsTable.assigneeId, targetAssigneeId!),
          eq(conversationsTable.channel, "whatsapp"),
          gte(conversationsTable.createdAt, since),
        ));
      return Number(row?.count ?? 0);
    };
    const [hourlyUsed, dailyUsed] = await Promise.all([countSince(hourAgo), countSince(dayAgo)]);
    if (hourlyUsed >= hourlyLimit) {
      res.status(429).json({ error: `Limite de ${hourlyLimit} atendimentos ativos por hora atingido para este atendente. Aguarde ou peça ao admin para ajustar o limite em Configurações.` });
      return;
    }
    if (dailyUsed >= dailyLimit) {
      res.status(429).json({ error: `Limite de ${dailyLimit} atendimentos ativos por dia atingido para este atendente. Aguarde amanhã ou peça ao admin para ajustar o limite em Configurações.` });
      return;
    }
  }

  let targetStoreId: number | null = null;
  if (targetAssigneeId != null) {
    const [ta] = await db.select({ storeId: usersTable.storeId }).from(usersTable)
      .where(eq(usersTable.id, targetAssigneeId)).limit(1);
    targetStoreId = ta?.storeId ?? null;
  }

  const [conv] = await db.insert(conversationsTable).values({
    tenantId,
    phone: normalizePhone(phone) || phone, name,
    channel: channel ?? "manual",
    sessionKey: targetSessionKey,
    sectorId: effectiveSectorId,
    status: "open",
    assigneeId: targetAssigneeId,
    attendanceStartedAt: targetAssigneeId != null ? new Date() : null,
    storeId: targetStoreId,
    lastMessageAt: new Date(),
  }).returning();

  if (targetAssigneeId != null) {
    await recordAttendanceStart(db, { tenantId, conversationId: conv.id, attendantId: targetAssigneeId, sectorId: conv.sectorId });
  }

  broadcast("conversation_new", conv, { tenantId: conv.tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv) });
  // Keep the CRM in sync with atendimentos: register the customer immediately.
  await ensureCrmContactForConversation(conv);
  res.status(201).json(conv);
});

// ─── Etiquetas (chat labels) management ───────────────────────────────────
// ─── Agendamentos (mensagem agendada / retorno ao cliente) ─────────────────
// Cria também uma tarefa espelho no quadro de Tarefas com o mesmo prazo.
router.post("/chat/conversations/:id/schedules", requireAuth, requireChatAccess(), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const { kind, content, sendAt } = req.body as { kind?: string; content?: string; sendAt?: string };

  const [conv] = await db.select().from(conversationsTable).where(and(eq(conversationsTable.id, id), eq(conversationsTable.tenantId, tenantId))).limit(1);
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada" }); return; }
  if (!(await canAccessConversation(conv, req))) { res.status(403).json({ error: "Acesso negado" }); return; }

  const cleanKind = kind === "retorno" ? "retorno" : "mensagem";
  // Mensagem agendada SAI para o cliente: vendedor só agenda em conversa que é
  // dele (mesma regra de posse do envio — assuma o atendimento antes de agendar).
  const role = req.session.userRole;
  if (cleanKind === "mensagem" && role === "vendedor" && conv.assigneeId !== req.session.userId) {
    res.status(403).json({ error: "Assuma o atendimento antes de agendar uma mensagem para este cliente" });
    return;
  }
  const text = (content ?? "").trim();
  if (!text) { res.status(400).json({ error: "Escreva o texto da mensagem ou do retorno" }); return; }
  const when = sendAt ? new Date(sendAt) : null;
  if (!when || isNaN(when.getTime())) { res.status(400).json({ error: "Data/hora inválida" }); return; }
  if (when.getTime() < Date.now() - 60_000) { res.status(400).json({ error: "Escolha um horário no futuro" }); return; }

  // Tarefa espelho no quadro (lembrete visível para a equipe)
  const [task] = await db.insert(tasksTable).values({
    tenantId,
    title: cleanKind === "mensagem"
      ? `📅 Mensagem agendada — ${conv.name}`
      : `📞 Retorno ao cliente — ${conv.name}`,
    description: `${text}\n\nCliente: ${conv.name} (${conv.phone})`,
    status: "todo",
    priority: "media",
    createdById: req.session.userId ?? null,
    sectorId: conv.sectorId,
    dueDate: when,
  }).returning();
  if (req.session.userId != null) {
    await db.insert(taskAssigneesTable).values({ tenantId, taskId: task!.id, userId: req.session.userId });
  }

  const [created] = await db.insert(scheduledMessagesTable).values({
    tenantId,
    conversationId: conv.id,
    kind: cleanKind,
    content: text.slice(0, 2000),
    sendAt: when,
    createdById: req.session.userId ?? null,
    taskId: task?.id ?? null,
  }).returning();

  res.status(201).json(created);
});

router.get("/chat/conversations/:id/schedules", requireAuth, requireChatAccess(), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [conv] = await db.select().from(conversationsTable).where(and(eq(conversationsTable.id, id), eq(conversationsTable.tenantId, tenantId))).limit(1);
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada" }); return; }
  if (!(await canAccessConversation(conv, req))) { res.status(403).json({ error: "Acesso negado" }); return; }
  const rows = await db.select().from(scheduledMessagesTable)
    .where(and(eq(scheduledMessagesTable.tenantId, tenantId), eq(scheduledMessagesTable.conversationId, id), eq(scheduledMessagesTable.status, "pending")))
    .orderBy(asc(scheduledMessagesTable.sendAt));
  res.json(rows);
});

router.delete("/chat/schedules/:schedId", requireAuth, requireChatAccess(), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const schedId = parseInt(Array.isArray(req.params.schedId) ? req.params.schedId[0] : req.params.schedId, 10);
  const [item] = await db.select().from(scheduledMessagesTable).where(and(eq(scheduledMessagesTable.id, schedId), eq(scheduledMessagesTable.tenantId, tenantId))).limit(1);
  if (!item) { res.status(404).json({ error: "Agendamento não encontrado" }); return; }
  const [conv] = await db.select().from(conversationsTable).where(and(eq(conversationsTable.id, item.conversationId), eq(conversationsTable.tenantId, tenantId))).limit(1);
  if (!conv || !(await canAccessConversation(conv, req))) { res.status(403).json({ error: "Acesso negado" }); return; }
  if (item.status !== "pending") { res.status(409).json({ error: "Esse agendamento já foi processado" }); return; }
  await db.update(scheduledMessagesTable).set({ status: "cancelled" }).where(and(eq(scheduledMessagesTable.id, schedId), eq(scheduledMessagesTable.tenantId, tenantId)));
  // Arquiva a tarefa espelho para não ficar lembrete órfão no quadro.
  if (item.taskId != null) {
    await db.update(tasksTable).set({ isArchived: true, updatedAt: new Date() }).where(and(eq(tasksTable.id, item.taskId), eq(tasksTable.tenantId, tenantId)));
  }
  res.json({ ok: true });
});

// ─── Notificações persistentes do sino ─────────────────────────────────────
// Avisos de retorno vencido e de falha em envio agendado, gravados pelo
// agendador. Cada usuário vê SOMENTE os próprios avisos (fail closed).
router.get("/chat/notifications", requireAuth, requireChatAccess(), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const userId = req.session.userId!;
  const rows = await db.select().from(chatNotificationsTable)
    .where(and(
      eq(chatNotificationsTable.tenantId, tenantId),
      eq(chatNotificationsTable.userId, userId),
      eq(chatNotificationsTable.read, false),
    ))
    .orderBy(desc(chatNotificationsTable.createdAt))
    .limit(100);
  res.json(rows);
});

// Marca como lidos: todos os avisos do usuário, ou só os de uma conversa
// (quando o vendedor abre a conversa a partir do sino).
router.post("/chat/notifications/read", requireAuth, requireChatAccess(), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const userId = req.session.userId!;
  const conversationId = typeof req.body?.conversationId === "number" ? req.body.conversationId : null;
  const conditions = [
    eq(chatNotificationsTable.tenantId, tenantId),
    eq(chatNotificationsTable.userId, userId),
    eq(chatNotificationsTable.read, false),
  ];
  if (conversationId != null) conditions.push(eq(chatNotificationsTable.conversationId, conversationId));
  await db.update(chatNotificationsTable).set({ read: true }).where(and(...conditions));
  res.json({ ok: true });
});

// ─── Quick replies (mensagens rápidas) ─────────────────────────────────────
// Leitura: qualquer usuário logado vê as globais + as que batem com ele nas
// dimensões preenchidas (setor/loja/usuário — todas as preenchidas precisam
// bater, é E lógico, não OU: ver comentário no schema). Admin/supervisor
// sempre vê todas (view de gestão). Gestão (criar/editar/excluir): admin e
// supervisor.
function sanitizeIdList(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const ids = raw.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0);
  return ids.length > 0 ? Array.from(new Set(ids)) : null;
}

router.get("/chat/quick-replies", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const role = req.session.userRole!;
  const userId = req.session.userId!;
  const sectorId = req.session.userSectorId ?? null;
  const storeId = req.session.userStoreId ?? null;
  const rows = await db.select().from(quickRepliesTable).where(eq(quickRepliesTable.tenantId, tenantId)).orderBy(asc(quickRepliesTable.title));
  const visible = (role === "admin" || role === "supervisor")
    ? rows
    : rows.filter((r) => {
        if (r.sectorId != null && r.sectorId !== sectorId) return false;
        if (Array.isArray(r.storeIds) && r.storeIds.length > 0 && (storeId == null || !r.storeIds.includes(storeId))) return false;
        if (Array.isArray(r.userIds) && r.userIds.length > 0 && !r.userIds.includes(userId)) return false;
        return true;
      });
  res.json(visible);
});

router.post("/chat/quick-replies", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { title, content, sectorId, storeIds, userIds } = req.body as { title?: string; content?: string; sectorId?: number | null; storeIds?: number[] | null; userIds?: number[] | null };
  if (!title?.trim() || !content?.trim()) { res.status(400).json({ error: "Título e mensagem são obrigatórios" }); return; }
  const [created] = await db.insert(quickRepliesTable).values({
    tenantId,
    title: title.trim().slice(0, 80),
    content: content.trim().slice(0, 2000),
    sectorId: sectorId ?? null,
    storeIds: sanitizeIdList(storeIds),
    userIds: sanitizeIdList(userIds),
  }).returning();
  res.status(201).json(created);
});

router.patch("/chat/quick-replies/:qrId", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const qrId = parseInt(Array.isArray(req.params.qrId) ? req.params.qrId[0] : req.params.qrId, 10);
  const { title, content, sectorId, storeIds, userIds } = req.body as { title?: string; content?: string; sectorId?: number | null; storeIds?: number[] | null; userIds?: number[] | null };
  const update: Partial<typeof quickRepliesTable.$inferInsert> = {};
  if (title !== undefined) update.title = title.trim().slice(0, 80);
  if (content !== undefined) update.content = content.trim().slice(0, 2000);
  if (sectorId !== undefined) update.sectorId = sectorId;
  if (storeIds !== undefined) update.storeIds = sanitizeIdList(storeIds);
  if (userIds !== undefined) update.userIds = sanitizeIdList(userIds);
  const [updated] = await db.update(quickRepliesTable).set(update).where(and(eq(quickRepliesTable.id, qrId), eq(quickRepliesTable.tenantId, tenantId))).returning();
  if (!updated) { res.status(404).json({ error: "Mensagem rápida não encontrada" }); return; }
  res.json(updated);
});

router.delete("/chat/quick-replies/:qrId", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const qrId = parseInt(Array.isArray(req.params.qrId) ? req.params.qrId[0] : req.params.qrId, 10);
  await db.delete(quickRepliesTable).where(and(eq(quickRepliesTable.id, qrId), eq(quickRepliesTable.tenantId, tenantId)));
  res.json({ ok: true });
});

router.get("/chat/labels", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const labels = await db
    .select()
    .from(chatLabelsTable)
    .where(and(eq(chatLabelsTable.tenantId, tenantId), eq(chatLabelsTable.isActive, true)))
    .orderBy(asc(chatLabelsTable.sortOrder), asc(chatLabelsTable.id));
  res.json(labels);
});

router.post("/chat/labels", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { name, color, sortOrder } = req.body as { name?: string; color?: string; sortOrder?: number };
  if (!name || !name.trim()) { res.status(400).json({ error: "Nome da etiqueta é obrigatório" }); return; }
  const hex = /^#[0-9a-fA-F]{6}$/.test(color ?? "") ? color! : "#1a2e6e";
  const [created] = await db.insert(chatLabelsTable).values({
    tenantId,
    name: name.trim(),
    color: hex,
    sortOrder: sortOrder ?? 0,
  }).returning();
  res.status(201).json(created);
});

router.patch("/chat/labels/:labelId", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const labelId = parseInt(String(req.params.labelId), 10);
  if (isNaN(labelId)) { res.status(400).json({ error: "ID inválido" }); return; }
  const [existing] = await db.select().from(chatLabelsTable).where(and(eq(chatLabelsTable.id, labelId), eq(chatLabelsTable.tenantId, tenantId))).limit(1);
  if (!existing) { res.status(404).json({ error: "Etiqueta não encontrada" }); return; }
  const { name, color, sortOrder, isActive } = req.body as {
    name?: string; color?: string; sortOrder?: number; isActive?: boolean;
  };
  const update: Record<string, unknown> = {};
  if (name !== undefined && name.trim()) update.name = name.trim();
  if (color !== undefined && /^#[0-9a-fA-F]{6}$/.test(color)) update.color = color;
  if (sortOrder !== undefined) update.sortOrder = sortOrder;
  if (isActive !== undefined) update.isActive = isActive;
  if (Object.keys(update).length === 0) { res.status(400).json({ error: "Nenhum campo válido para atualizar" }); return; }
  const [updated] = await db.update(chatLabelsTable).set(update).where(and(eq(chatLabelsTable.id, labelId), eq(chatLabelsTable.tenantId, tenantId))).returning();
  res.json(updated);
});

router.delete("/chat/labels/:labelId", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const labelId = parseInt(String(req.params.labelId), 10);
  if (isNaN(labelId)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.delete(chatLabelsTable).where(and(eq(chatLabelsTable.id, labelId), eq(chatLabelsTable.tenantId, tenantId)));
  res.json({ ok: true });
});

// ─── List users available for participant assignment ──────────────────────
router.get("/chat/users", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const users = await db
    .select({ id: usersTable.id, name: usersTable.name, role: usersTable.role, sectorId: usersTable.sectorId })
    .from(usersTable)
    .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.isActive, true)));
  res.json(users);
});

// ─── Conversation participants ─────────────────────────────────────────────
router.post("/chat/conversations/:id/participants", requireAuth, requireChatAccess(), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const convId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const { userId } = req.body as { userId?: number };
  if (!userId) { res.status(400).json({ error: "userId obrigatório" }); return; }

  const [conv] = await db.select().from(conversationsTable).where(and(eq(conversationsTable.id, convId), eq(conversationsTable.tenantId, tenantId)));
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada" }); return; }
  if (!(await canAccessConversation(conv, req))) { res.status(403).json({ error: "Acesso negado" }); return; }

  // Fail closed: o participante precisa ser da mesma loja.
  const [memberUser] = await db.select({ id: usersTable.id, role: usersTable.role, allowedSessionKeys: usersTable.allowedSessionKeys })
    .from(usersTable).where(and(eq(usersTable.id, userId), eq(usersTable.tenantId, tenantId))).limit(1);
  if (!memberUser) { res.status(400).json({ error: "Usuário inválido" }); return; }

  // Vendedor com linha de WhatsApp restrita não pode ser participante de uma
  // conversa de outra linha: senão ele fica "preso" na lista de destinatários
  // (restrictedTo) mas o fan-out de SSE some pra ele — mensagem chega pra
  // outros vinculados e não pra ele, silenciosamente. Bloqueia aqui em vez de
  // furar a restrição de linha no broadcast.
  if (memberUser.allowedSessionKeys != null && !memberUser.allowedSessionKeys.includes(conv.sessionKey)) {
    res.status(403).json({ error: "Este usuário só recebe conversas de uma linha específica de WhatsApp e não pode ser adicionado a esta conversa." });
    return;
  }

  await db.insert(conversationParticipantsTable).values({ tenantId, conversationId: convId, userId }).onConflictDoNothing();

  // When a vendedor is added to a conversation, route it into the "Pendentes"
  // queue so they can review and approve/assume the attendance ("Iniciar
  // atendimento"). Only do this when nobody is actively handling it yet and it
  // isn't already queued or finished, so an active or resolved conversation is
  // never knocked back into the queue.
  const shouldQueue =
    memberUser.role === "vendedor" &&
    conv.assigneeId == null &&
    conv.status !== "pending" &&
    conv.status !== "resolved" &&
    conv.status !== "archived";

  if (shouldQueue) {
    // wasPotential must be read from the PRE-update state so the SSE fan-out
    // scoping stays correct (potenciais are cross-sector visible).
    const wasPotential = isPotentialConversation(conv);
    const [updated] = await db
      .update(conversationsTable)
      .set({ status: "pending", updatedAt: new Date() })
      .where(and(eq(conversationsTable.id, convId), eq(conversationsTable.tenantId, tenantId)))
      .returning();
    broadcast("conversation_updated", updated, { tenantId: updated.tenantId, sectorId: updated.sectorId, sessionKey: updated.sessionKey, isPotential: wasPotential });
    broadcast("participants_updated", { conversationId: convId }, { tenantId: updated.tenantId, sectorId: updated.sectorId, sessionKey: updated.sessionKey, isPotential: false });
    res.status(201).json({ ok: true, conversation: updated });
    return;
  }

  broadcast("participants_updated", { conversationId: convId }, { tenantId: conv.tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv) });
  res.status(201).json({ ok: true });
});

router.delete("/chat/conversations/:id/participants/:userId", requireAuth, requireChatAccess(), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const convId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = parseInt(Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId, 10);

  const [conv] = await db.select().from(conversationsTable).where(and(eq(conversationsTable.id, convId), eq(conversationsTable.tenantId, tenantId)));
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada" }); return; }
  if (!(await canAccessConversation(conv, req))) { res.status(403).json({ error: "Acesso negado" }); return; }

  await db.delete(conversationParticipantsTable)
    .where(and(
      eq(conversationParticipantsTable.conversationId, convId),
      eq(conversationParticipantsTable.userId, userId),
    ));
  // O participante removido também precisa receber o evento (para tirar a
  // conversa da tela dele), então entra na lista junto dos que permanecem.
  const removeRecipients = await restrictedRecipients(conv);
  broadcast("participants_updated", { conversationId: convId }, { tenantId: conv.tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: isPotentialConversation(conv), restrictedTo: removeRecipients ? [...new Set([...removeRecipients, userId])] : null });
  if (removeRecipients != null) {
    broadcast("conversation_hidden", { id: convId, keepFor: removeRecipients, sectorId: conv.sectorId }, { tenantId: conv.tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: false, restrictedTo: [...new Set([...removeRecipients, userId])] });
  }
  res.json({ ok: true });
});

// ─── Transcrever áudio (Whisper) ───────────────────────────────────────────
router.post("/chat/messages/:id/transcribe", requireAuth, requireChatAccess(), async (req: Request, res: Response): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const msgId = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(msgId)) { res.status(400).json({ error: "ID inválido" }); return; }

  const [msg] = await db.select().from(messagesTable)
    .where(and(eq(messagesTable.id, msgId), eq(messagesTable.tenantId, tenantId))).limit(1);
  if (!msg) { res.status(404).json({ error: "Mensagem não encontrada" }); return; }
  const [conv] = await db.select().from(conversationsTable)
    .where(and(eq(conversationsTable.id, msg.conversationId), eq(conversationsTable.tenantId, tenantId))).limit(1);
  if (!conv || !(await canAccessConversation(conv, req))) { res.status(403).json({ error: "Acesso negado" }); return; }

  try {
    const { transcribeMessage } = await import("../lib/transcribe");
    const transcript = await transcribeMessage(msgId);
    broadcast("message_updated", { conversationId: conv.id, message: { ...msg, transcript } }, { tenantId: conv.tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv) });
    res.json({ transcript });
  } catch (err) {
    res.status(422).json({ error: err instanceof Error ? err.message : "Falha ao transcrever" });
  }
});

// ─── Serve saved media files ───────────────────────────────────────────────
router.get("/chat/media/:filename", requireAuth, requireChatAccess(), async (req: Request, res: Response): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const filename = path.basename(req.params.filename as string);
  const filepath = path.join(MEDIA_DIR, filename);
  if (!existsSync(filepath)) {
    res.status(404).json({ error: "Mídia não encontrada" });
    return;
  }

  // Resolve the media file to its owning conversation and enforce sector access.
  const mediaUrl = `/api/chat/media/${filename}`;
  const [owningMsg] = await db
    .select({ conversationId: messagesTable.conversationId, metadata: messagesTable.metadata })
    .from(messagesTable)
    .where(eq(messagesTable.mediaUrl, mediaUrl))
    .limit(1);

  if (!owningMsg) {
    // File exists on disk but has no owning message — deny access to be safe.
    res.status(403).json({ error: "Acesso negado" });
    return;
  }

  const [conv] = await db
    .select()
    .from(conversationsTable)
    .where(and(eq(conversationsTable.id, owningMsg.conversationId), eq(conversationsTable.tenantId, tenantId)))
    .limit(1);

  if (!conv || !(await canAccessConversation(conv, req))) {
    res.status(403).json({ error: "Acesso negado" });
    return;
  }

  const ext = path.extname(filename).slice(1).toLowerCase();
  const mimeMap: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    gif: "image/gif", webp: "image/webp",
    ogg: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", weba: "audio/webm",
    aac: "audio/aac", amr: "audio/amr", wav: "audio/wav",
    // "webm" sem prefixo é vídeo; áudio webm usa a extensão "weba"
    mp4: "video/mp4", "3gp": "video/3gpp", webm: "video/webm", mov: "video/quicktime",
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  const contentType = mimeMap[ext] ?? "application/octet-stream";
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "private, max-age=86400");

  // ?download=1: força "salvar como" em vez de abrir inline — usado pelo
  // botão de baixar de vídeo/áudio/doc na Central (sem isso, o navegador
  // abre o arquivo na própria aba/visualizador nativo em vez de baixar).
  if (req.query["download"] === "1") {
    const downloadName = owningMsg.metadata?.fileName ?? filename;
    res.setHeader("Content-Disposition", `attachment; filename="${downloadName.replace(/"/g, "")}"`);
  }

  // Suporte a Range (leitura por partes): obrigatório para <video>/<audio>
  // em Safari/iOS e permite pular para o meio do vídeo em qualquer navegador.
  const { size } = statSync(filepath);
  res.setHeader("Accept-Ranges", "bytes");
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
      if (start >= size || start > end) {
        res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
        return;
      }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      res.setHeader("Content-Length", String(end - start + 1));
      createReadStream(filepath, { start, end }).pipe(res);
      return;
    }
  }
  res.setHeader("Content-Length", String(size));
  createReadStream(filepath).pipe(res);
});

// ─── WhatsApp Webhook — Meta Cloud API ────────────────────────────────────

// GET — Meta hub challenge verification
router.get("/chat/webhook/whatsapp", (req: Request, res: Response): void => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const verifyToken =
    process.env["META_WHATSAPP_WEBHOOK_VERIFY_TOKEN"] ?? "sheikcell-verify";

  if (mode === "subscribe" && token === verifyToken) {
    req.log.info("Meta webhook verification challenge accepted");
    res.status(200).send(challenge);
    return;
  }

  req.log.warn({ mode, token }, "Meta webhook verification failed");
  res.status(403).json({ error: "Forbidden" });
});

function verifyMetaSignature(rawBody: Buffer | undefined, sigHeader: string | undefined, secret: string): boolean {
  if (!rawBody || typeof sigHeader !== "string") return false;
  if (!sigHeader.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

function verifyLegacyBridgeSecret(req: Request): boolean {
  const provided = req.headers["x-bridge-secret"];
  if (typeof provided !== "string") return false;
  const expected = createHmac(
    "sha256",
    process.env["SESSION_SECRET"] ?? "sheikcell-dev-only-secret",
  ).update("whatsapp-bridge-v1").digest("hex");
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

// POST — receive inbound messages
router.post("/chat/webhook/whatsapp", async (req: Request, res: Response): Promise<void> => {
  const metaSecret = process.env["META_WHATSAPP_WEBHOOK_SECRET"];

  if (metaSecret) {
    // Meta Cloud API: verify X-Hub-Signature-256
    const sig = req.headers["x-hub-signature-256"] as string | undefined;
    if (!verifyMetaSignature(req.rawBody, sig, metaSecret)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  } else {
    // Baileys bridge path: accept HMAC-verified bridge secret (timing-safe).
    // SESSION_SECRET is always present in production, so this remains a strong
    // authenticated channel — it is not an open/fail-open webhook.
    if (!verifyLegacyBridgeSecret(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  try {
    if ((req.body as { object?: string }).object === "whatsapp_business_account") {
      await processMetaInboundWA(req.body as MetaInboundWAPayload);
    } else {
      await processInboundWA(req.body as InboundWAPayload);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Erro ao processar mensagem" });
  }
});

// ─── AI reply suggestion ──────────────────────────────────────────────────
// Generates a Portuguese reply suggestion for the attendant to review before
// sending. Context = linked CRM contact info + the last messages of the
// conversation. Human always reviews/edits; nothing is sent automatically.
// Fails clearly (503) when the AI provider is unavailable so the rest of the
// attendance keeps working.
router.post("/chat/conversations/:id/suggest-reply", requireAuth, requireChatAccess(), requirePerm("usar_ia"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);

  const [conv] = await db.select().from(conversationsTable).where(and(eq(conversationsTable.id, id), eq(conversationsTable.tenantId, tenantId))).limit(1);
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada" }); return; }
  if (!(await canAccessConversation(conv, req))) { res.status(403).json({ error: "Acesso negado" }); return; }

  // Resolve the linked CRM contact (find by normalized phone, scoped to the
  // conversation's sector — same rule used by the CRM sync helpers).
  const suggestPhoneVariants = phoneVariants(conv.phone);
  let contact: typeof crmContactsTable.$inferSelect | undefined;
  if (suggestPhoneVariants.length > 0 && !(conv.phone ?? "").includes("@g.us")) {
    const sectorCondition = conv.sectorId != null
      ? eq(crmContactsTable.sectorId, conv.sectorId)
      : isNull(crmContactsTable.sectorId);
    [contact] = await db.select().from(crmContactsTable)
      .where(and(eq(crmContactsTable.tenantId, tenantId), eq(crmContactsTable.isArchived, false), inArray(crmContactsTable.phone, suggestPhoneVariants), sectorCondition))
      .limit(1);
  }

  // Build the customer info block from the contact + custom-field labels.
  const infoLines: string[] = [`Nome: ${conv.name}`];
  if (contact) {
    if (contact.city) infoLines.push(`Cidade: ${contact.city}`);
    if (contact.serviceStore) infoLines.push(`Loja de atendimento: ${contact.serviceStore}`);
    if (contact.attendanceSource) infoLines.push(`Origem: ${contact.attendanceSource}`);
    if (contact.profile) infoLines.push(`Perfil: ${contact.profile}`);
    if (contact.notes) infoLines.push(`Observações: ${contact.notes}`);
    const cf = contact.customFields ?? {};
    if (Object.keys(cf).length > 0) {
      const defs = await db.select().from(crmCustomFieldsTable).where(eq(crmCustomFieldsTable.tenantId, tenantId));
      const defMap = Object.fromEntries(defs.map((d) => [String(d.id), d.name]));
      for (const [key, value] of Object.entries(cf)) {
        if (value == null || value === "") continue;
        infoLines.push(`${defMap[key] ?? key}: ${value}`);
      }
    }
  }
  if (conv.sectorId != null) {
    const [sector] = await db.select({ name: sectorsTable.name }).from(sectorsTable)
      .where(and(eq(sectorsTable.id, conv.sectorId), eq(sectorsTable.tenantId, tenantId))).limit(1);
    if (sector?.name) infoLines.push(`Setor: ${sector.name}`);
  }

  // Last messages of the conversation (chronological).
  const recent = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, id))
    .orderBy(desc(messagesTable.createdAt))
    .limit(15);
  const history = recent
    .reverse()
    .map((m) => {
      // Áudio já transcrito entra como texto — a IA entende o que foi falado.
      const body = m.type === "audio" && m.transcript ? `🎵 Áudio (transcrição): ${m.transcript}` : m.content;
      return `${m.direction === "inbound" ? "Cliente" : "Atendente"}: ${body}`;
    })
    .join("\n");

  if (!history.trim()) {
    res.status(422).json({ error: "Não há mensagens suficientes para gerar uma sugestão" });
    return;
  }

  const systemPrompt = [
    "Você é um assistente de atendimento ao cliente da Sheikcell, uma loja de celulares e assistência técnica.",
    "Escreva SEMPRE em português do Brasil, em tom cordial, profissional e objetivo.",
    "Gere apenas UMA sugestão de resposta que o atendente possa enviar ao cliente pelo WhatsApp.",
    "Use as informações do cliente e o histórico da conversa para personalizar a resposta.",
    "Não invente dados que você não tem (preços, prazos, disponibilidade). Se faltar informação, peça educadamente ao cliente ou ofereça verificar.",
    "Responda apenas com o texto da mensagem sugerida, sem aspas, sem rótulos e sem explicações.",
  ].join(" ");

  const userPrompt = `Informações do cliente:\n${infoLines.join("\n")}\n\nHistórico recente da conversa:\n${history}\n\nSugira a próxima resposta do atendente ao cliente.`;

  try {
    const { getOpenAiClientForTenant } = await import("../lib/aiClient");
    const openai = await getOpenAiClientForTenant(tenantId);
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 8192,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    const suggestion = completion.choices[0]?.message?.content?.trim() ?? "";
    if (!suggestion) {
      res.status(502).json({ error: "A IA não retornou uma sugestão. Tente novamente." });
      return;
    }
    res.json({ suggestion });
  } catch (err) {
    req.log.error({ err }, "AI reply suggestion failed");
    res.status(503).json({ error: "A IA está indisponível no momento. Tente novamente em instantes." });
  }
});

// ── AI text correction ───────────────────────────────────────────────────
// Corrects spelling/grammar of a drafted message without changing its meaning.
router.post("/chat/correct-text", requireAuth, requireChatAccess(), requirePerm("usar_ia"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) { res.status(400).json({ error: "Texto vazio" }); return; }
  if (text.length > 4000) { res.status(400).json({ error: "Texto muito longo" }); return; }

  const systemPrompt = [
    "Você é um corretor ortográfico e gramatical de português do Brasil.",
    "Corrija APENAS erros de ortografia, acentuação, pontuação e gramática do texto enviado.",
    "NÃO mude o sentido, o tom, as gírias intencionais nem os emojis.",
    "NÃO adicione nem remova informações.",
    "Se o texto já estiver correto, devolva-o exatamente igual.",
    "Responda somente com o texto corrigido, sem aspas, rótulos ou explicações.",
  ].join(" ");

  try {
    const { getOpenAiClientForTenant } = await import("../lib/aiClient");
    const openai = await getOpenAiClientForTenant(tenantId);
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 4096,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
    });
    const corrected = completion.choices[0]?.message?.content?.trim() ?? "";
    if (!corrected) {
      res.status(502).json({ error: "A IA não retornou a correção. Tente novamente." });
      return;
    }
    res.json({ corrected });
  } catch (err) {
    req.log.error({ err }, "AI text correction failed");
    res.status(503).json({ error: "A correção está indisponível no momento. Tente novamente em instantes." });
  }
});

export default router;
