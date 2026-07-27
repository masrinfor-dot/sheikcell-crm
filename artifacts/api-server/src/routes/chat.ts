import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { createReadStream, existsSync, statSync } from "fs";
import path from "path";
import { db, conversationsTable, messagesTable, sectorsTable, usersTable, conversationParticipantsTable, attendanceLogsTable, crmContactsTable, crmCustomFieldsTable, chatLabelsTable, whatsappSessionsTable } from "@workspace/db";
import { eq, desc, and, or, ilike, sql, inArray, notInArray, isNull, asc } from "drizzle-orm";
import { requireAuth, requireAdmin, requireAdminOrSupervisor } from "../middlewares/auth";
import {
  broadcast,
  sseEmitter,
  bufferedEventsSince,
  reconnectStrategy,
  type BufferedEvent,
} from "../lib/sseEmitter";
import { isPotentialConversation, isRestrictedConversation, restrictedRecipients, POTENTIAL_EXCLUDED_STATUSES } from "../lib/conversationScope";
import { ensureCrmContactForConversation } from "../lib/crmSync";
import {
  processInboundWA,
  processMetaInboundWA,
  type InboundWAPayload,
  type MetaInboundWAPayload,
  MEDIA_DIR,
} from "../lib/whatsappInbound";

const router: IRouter = Router();

// ─── SSE real-time stream ──────────────────────────────────────────────────
router.get("/chat/events", requireAuth, (req: Request, res: Response): void => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const userRole = req.session.userRole!;
  const userSectorId = req.session.userSectorId;
  const userId = req.session.userId!;

  // Mirror canAccessConversation exactly.
  // - Eventos de conversas RESTRITAS (com responsável ou finalizadas) trazem
  //   `restrictedTo` (responsável + participantes): admin recebe sempre;
  //   supervisor só se o setor bater (supervisor sem setor = global);
  //   vendedor só se estiver na lista.
  // - Demais eventos: potenciais chegam a todos; o resto é escopado por setor.
  const allowed = (ev: { sectorId: number | null; isPotential?: boolean; restrictedTo?: number[] | null }): boolean => {
    if (userRole === "admin") return true;
    if (userRole === "supervisor") {
      // Supervisor com setor: só eventos do próprio setor + potenciais.
      if (userSectorId == null || ev.sectorId === userSectorId) return true;
      return ev.restrictedTo == null && ev.isPotential === true;
    }
    if (ev.restrictedTo != null) return ev.restrictedTo.includes(userId);
    if (ev.isPotential) return true;
    return ev.sectorId != null && ev.sectorId === userSectorId;
  };

  const writeEvent = (ev: { id?: number; event: string; data: unknown }) => {
    if (ev.id != null) res.write(`id: ${ev.id}\n`);
    res.write(`event: ${ev.event}\n`);
    res.write(`data: ${JSON.stringify(ev.data)}\n\n`);
  };

  const send = (payload: BufferedEvent) => {
    if (!allowed(payload)) return;
    writeEvent(payload);
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

  req.on("close", () => {
    clearInterval(heartbeat);
    sseEmitter.off("broadcast", send);
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
  conv: Pick<typeof conversationsTable.$inferSelect, "id" | "sectorId" | "assigneeId" | "status" | "isArchived">,
  req: Request,
): Promise<boolean> {
  const userRole = req.session.userRole!;
  if (userRole === "admin") return true;
  const userId = req.session.userId!;
  const userSectorId = req.session.userSectorId;
  if (userRole === "supervisor") {
    // Supervisor com setor: acesso apenas ao próprio setor + potenciais.
    if (userSectorId == null || conv.sectorId === userSectorId) return true;
    return isPotentialConversation(conv);
  }
  if (isRestrictedConversation(conv)) {
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
  if (conv.sectorId != null && conv.sectorId === userSectorId) return true;
  return isPotentialConversation(conv);
}

// ─── List conversations ────────────────────────────────────────────────────
router.get("/chat/conversations", requireAuth, async (req, res): Promise<void> => {
  const { search, label, status, sectorId } = req.query as Record<string, string | undefined>;

  const userRole = req.session.userRole!;
  const userSectorId = req.session.userSectorId;

  const conditions = [eq(conversationsTable.isArchived, false)];

  // Conversas RESTRITAS (com responsável ou finalizadas) têm visibilidade
  // reduzida: só o responsável/participantes (vendedor), o admin e o
  // supervisor do MESMO setor as veem.
  const restricted = or(
    sql`${conversationsTable.assigneeId} IS NOT NULL`,
    inArray(conversationsTable.status, ["resolved", "archived"]),
  )!;

  if (userRole === "admin") {
    if (sectorId) conditions.push(eq(conversationsTable.sectorId, Number(sectorId)));
  } else if (userRole === "supervisor") {
    // Supervisor com setor: só vê o próprio setor (pendentes, ativas e
    // resolvidas), além dos potenciais (leads novos, cross-sector).
    // Supervisor sem setor definido permanece global (não há como escopar).
    if (userSectorId) {
      const potencialSup = and(
        isNull(conversationsTable.assigneeId),
        notInArray(conversationsTable.status, [...POTENTIAL_EXCLUDED_STATUSES]),
      )!;
      conditions.push(or(
        eq(conversationsTable.sectorId, userSectorId),
        potencialSup,
      )!);
    }
    if (sectorId) conditions.push(eq(conversationsTable.sectorId, Number(sectorId)));
  } else {
    // Vendedores are ALWAYS sector-scoped and must never see every conversation.
    // - potenciais (leads novos sem dono): visíveis a todos;
    // - conversas do próprio setor NÃO restritas (ex.: pendentes);
    // - conversas restritas apenas quando é o responsável ou participante.
    const userId = req.session.userId!;
    const potencial = and(
      isNull(conversationsTable.assigneeId),
      notInArray(conversationsTable.status, [...POTENTIAL_EXCLUDED_STATUSES]),
    )!;
    const mine = or(
      eq(conversationsTable.assigneeId, userId),
      sql`EXISTS (SELECT 1 FROM ${conversationParticipantsTable} WHERE ${conversationParticipantsTable.conversationId} = ${conversationsTable.id} AND ${conversationParticipantsTable.userId} = ${userId})`,
    )!;
    const sectorUnrestricted = userSectorId
      ? and(eq(conversationsTable.sectorId, userSectorId), sql`NOT (${restricted})`)!
      : sql`FALSE`;
    conditions.push(or(potencial, mine, sectorUnrestricted)!);
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

  const sectors = await db.select().from(sectorsTable);
  const users = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable);
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

  const enriched = rows.map((c) => ({
    ...c,
    sector: c.sectorId ? (sectorMap[c.sectorId] ?? null) : null,
    assignee: c.assigneeId ? (userMap[c.assigneeId] ?? null) : null,
    participants: participantsMap[c.id] ?? [],
  }));

  res.json(enriched);
});

// ─── Get single conversation ───────────────────────────────────────────────
router.get("/chat/conversations/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, id));
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada" }); return; }
  if (!(await canAccessConversation(conv, req))) { res.status(403).json({ error: "Acesso negado" }); return; }
  res.json(await enrichConversation(conv));
});

// ─── Get messages ──────────────────────────────────────────────────────────
router.get("/chat/conversations/:id/messages", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);

  const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, id)).limit(1);
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada" }); return; }
  if (!(await canAccessConversation(conv, req))) { res.status(403).json({ error: "Acesso negado" }); return; }

  await db.update(conversationsTable).set({ unreadCount: 0 }).where(eq(conversationsTable.id, id));

  const msgs = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, id))
    .orderBy(messagesTable.createdAt)
    .limit(200);

  res.json(msgs);
});

// ─── Send media ────────────────────────────────────────────────────────────
router.post("/chat/conversations/:id/media", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const { base64, mimetype: rawMimetype, filename, caption, ptt } = req.body as {
    base64?: string;
    mimetype?: string;
    filename?: string;
    caption?: string;
    ptt?: boolean; // nota de voz (gravação do microfone)
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

  const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, id)).limit(1);
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

  const [msg] = await db.insert(messagesTable).values({
    conversationId: id,
    content,
    direction: "outbound",
    type: msgType,
    status: "sent",
    senderName,
    mediaUrl,
  }).returning();

  await db.update(conversationsTable).set({
    lastMessage: content,
    lastMessageAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(conversationsTable.id, id));

  broadcast("message", { conversationId: id, message: msg }, conv.sectorId, isPotentialConversation(conv), await restrictedRecipients(conv));

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
          caption,
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
      const [failedMsg] = await db.update(messagesTable)
        .set({ status: "failed" })
        .where(eq(messagesTable.id, msg.id))
        .returning();
      if (failedMsg) {
        broadcast("message_updated", { conversationId: id, message: failedMsg }, conv.sectorId, isPotentialConversation(conv), await restrictedRecipients(conv));
        res.status(201).json(failedMsg);
        return;
      }
    }
  }

  res.status(201).json(msg);
});

// ─── Send message ──────────────────────────────────────────────────────────
router.post("/chat/conversations/:id/messages", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const { content } = req.body as { content?: string };
  if (!content?.trim()) { res.status(400).json({ error: "Mensagem vazia" }); return; }

  const senderName = req.session.userName ?? "Atendente";

  const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, id)).limit(1);
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada" }); return; }
  if (!(await canAccessConversation(conv, req))) { res.status(403).json({ error: "Acesso negado" }); return; }
  if (conv.assigneeId == null) {
    res.status(409).json({ error: "Inicie o atendimento antes de enviar mensagens" });
    return;
  }

  const [msg] = await db.insert(messagesTable).values({
    conversationId: id,
    content: content.trim(),
    direction: "outbound",
    type: "text",
    status: "sent",
    senderName,
  }).returning();

  await db.update(conversationsTable).set({
    lastMessage: content.trim(),
    lastMessageAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(conversationsTable.id, id));

  broadcast("message", { conversationId: id, message: msg }, conv.sectorId, isPotentialConversation(conv), await restrictedRecipients(conv));

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
        body: JSON.stringify({ to: conv.phone, text: content.trim(), session: conv.sessionKey }),
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
      const [failedMsg] = await db.update(messagesTable)
        .set({ status: "failed" })
        .where(eq(messagesTable.id, msg.id))
        .returning();
      if (failedMsg) {
        broadcast("message_updated", { conversationId: id, message: failedMsg }, conv.sectorId, isPotentialConversation(conv), await restrictedRecipients(conv));
        res.status(201).json(failedMsg);
        return;
      }
    }
  }

  res.status(201).json(msg);
});

// ─── Sync a finalized conversation into Visão Geral + CRM ───────────────────
// When a chat attendance is resolved we record it as an attendance log (so the
// dashboard "Finalizados"/recent feed counts it the same way as queue
// attendances) and ensure the customer exists in the CRM (find-or-create by
// normalized phone), keeping the three modules in sync.
async function syncResolvedConversation(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  conv: typeof conversationsTable.$inferSelect,
  resolutionReason?: string | null,
): Promise<void> {
  const [attendant] = conv.assigneeId
    ? await tx.select().from(usersTable).where(eq(usersTable.id, conv.assigneeId)).limit(1)
    : [];
  // Attribute the attendance to the conversation's sector, falling back to the
  // assignee's sector so a conversation without an explicit sector still counts
  // on the dashboard when it was handled by a sectorized attendant.
  const effectiveSectorId = conv.sectorId ?? attendant?.sectorId ?? null;
  const [sector] = effectiveSectorId != null
    ? await tx.select().from(sectorsTable).where(eq(sectorsTable.id, effectiveSectorId)).limit(1)
    : [];

  // 1) Attendance log — feeds the Visão Geral dashboard and CRM service history.
  //    sectorId is required (NOT NULL); skip the log only when the attendance
  //    cannot be attributed to any sector.
  if (effectiveSectorId != null) {
    const serviceSeconds = Math.round((Date.now() - conv.createdAt.getTime()) / 1000);
    await tx.insert(attendanceLogsTable).values({
      queueEntryId: 0, // chat attendances have no queue entry
      clientName: conv.name,
      clientContact: conv.phone,
      sectorId: effectiveSectorId,
      sectorName: sector?.name ?? "Desconhecido",
      attendantId: conv.assigneeId,
      attendantName: attendant?.name ?? null,
      channel: conv.channel,
      outcome: "completed",
      resolutionReason: resolutionReason?.trim() || null,
      serviceTimeSeconds: serviceSeconds >= 0 ? serviceSeconds : null,
    });
  }

  // 2) CRM contact — link the conversation to a CRM record (find-or-create by
  //    phone). The lookup is scoped to the conversation's effective sector so we
  //    never read or mutate a same-phone contact that belongs to another sector.
  const normalizedPhone = (conv.phone ?? "").replace(/\D/g, "");
  // Grupos/comunidades não entram no CRM (não são um cliente com telefone).
  if (normalizedPhone && !(conv.phone ?? "").includes("@g.us")) {
    const sectorCondition = effectiveSectorId != null
      ? eq(crmContactsTable.sectorId, effectiveSectorId)
      : isNull(crmContactsTable.sectorId);
    const [existing] = await tx.select().from(crmContactsTable)
      .where(and(eq(crmContactsTable.isArchived, false), eq(crmContactsTable.phone, normalizedPhone), sectorCondition))
      .limit(1);
    if (existing) {
      await tx.update(crmContactsTable)
        .set({ updatedAt: new Date() })
        .where(eq(crmContactsTable.id, existing.id));
    } else {
      await tx.insert(crmContactsTable).values({
        name: conv.name,
        contact: conv.phone,
        phone: normalizedPhone,
        sectorId: effectiveSectorId,
        attendantId: conv.assigneeId ?? null,
        status: "active",
        profile: "Novo",
      });
    }
  }
}

// ─── Update conversation ───────────────────────────────────────────────────
router.patch("/chat/conversations/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const { status, labels, sectorId, assigneeId, name, isArchived, resolutionReason } = req.body as {
    status?: string; labels?: string; sectorId?: number;
    assigneeId?: number; name?: string; isArchived?: boolean;
    resolutionReason?: string;
  };

  const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, id)).limit(1);
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada" }); return; }
  if (!(await canAccessConversation(conv, req))) { res.status(403).json({ error: "Acesso negado" }); return; }

  const userRole = req.session.userRole!;
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (status !== undefined) update.status = status;
  if (labels !== undefined) update.labels = labels;
  if (name !== undefined) update.name = name;
  if (isArchived !== undefined) update.isArchived = isArchived;
  // Only admins and supervisors may reassign to a different sector or assignee
  let isSectorTransfer = false;
  if (userRole === "admin" || userRole === "supervisor") {
    if (sectorId !== undefined) update.sectorId = sectorId;
    if (assigneeId !== undefined) update.assigneeId = assigneeId;
    // Transferring a conversation to a DIFFERENT sector hands it off to another
    // team of vendedores. Route it into that sector's "Pendentes" queue by
    // clearing the assignee and setting status "pending", so a vendedor there
    // reviews and assumes it ("Iniciar atendimento") instead of it silently
    // staying under the previous vendedor. Skipped when the caller explicitly
    // sets a status/assignee in the same request or the conversation is
    // already finished.
    isSectorTransfer =
      sectorId !== undefined &&
      sectorId !== conv.sectorId &&
      assigneeId === undefined &&
      status === undefined &&
      conv.status !== "resolved" &&
      conv.status !== "archived";
    if (isSectorTransfer) {
      update.assigneeId = null;
      update.status = "pending";
    }
  }

  // Run the update and the dashboard/CRM sync atomically. A locked read of the
  // pre-update status guarantees the sync fires exactly once per transition into
  // "resolved" even under concurrent PATCH requests, and rolls back the status
  // change if the sync fails.
  const updated = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(conversationsTable)
      .where(eq(conversationsTable.id, id)).for("update").limit(1);
    const wasResolved = locked?.status === "resolved";

    const [row] = await tx.update(conversationsTable).set(update)
      .where(eq(conversationsTable.id, id)).returning();

    if (status === "resolved" && !wasResolved) {
      // Sanitize untrusted client input: only accept a string motive, capped.
      const cleanReason = typeof resolutionReason === "string" ? resolutionReason.slice(0, 500) : null;
      await syncResolvedConversation(tx, row, cleanReason);
    }
    return row;
  });

  // Deliver to everyone who could see it BEFORE the change (potenciais are
  // cross-sector visible, so read wasPotential from the pre-update row) as well
  // as everyone who can see it now.
  const wasPotential = isPotentialConversation(conv);
  const recipients = await restrictedRecipients(updated);
  broadcast("conversation_updated", updated, updated.sectorId, wasPotential || isPotentialConversation(updated), recipients);
  // Transição para RESTRITA (ganhou responsável ou foi finalizada): quem via a
  // conversa antes (setor/potencial) e não está na lista de autorizados precisa
  // removê-la da tela. O evento leva só o id + quem pode mantê-la (sem conteúdo).
  if (recipients != null && !isRestrictedConversation(conv)) {
    broadcast("conversation_hidden", { id: updated.id, keepFor: recipients, sectorId: updated.sectorId }, conv.sectorId, wasPotential);
  }
  // On a sector transfer the broadcast above targets the NEW sector, so the
  // ORIGIN sector's vendedores would otherwise never learn the conversation
  // left. Notify them explicitly so they drop it from their list.
  if (isSectorTransfer && conv.sectorId != null && conv.sectorId !== updated.sectorId) {
    broadcast("conversation_updated", updated, conv.sectorId, false);
  }
  res.json(updated);
});

// ─── Claim conversation (self-assign / take from queue) ────────────────────
// Any authenticated user may take a conversation they can access and assign it
// to themselves, moving it from "Pendentes" (queue) to "Ativos". This is a
// sector-scoped self-assignment, so it is safe for vendedores who cannot
// otherwise change assigneeId via the PATCH route.
router.post("/chat/conversations/:id/claim", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);

  const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, id)).limit(1);
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada" }); return; }
  if (!(await canAccessConversation(conv, req))) { res.status(403).json({ error: "Acesso negado" }); return; }
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
  const claimSet: Partial<typeof conversationsTable.$inferInsert> = {
    assigneeId: req.session.userId,
    status: "pending",
    updatedAt: new Date(),
  };
  if (userRole !== "admin" && userRole !== "supervisor" && userSectorId && conv.sectorId !== userSectorId) {
    claimSet.sectorId = userSectorId;
  }

  // If the conversation was a potencial BEFORE the claim, every vendedor could
  // see it, so the transition must reach them all (they'll drop it from their
  // "Potenciais" list). A normal same-sector claim stays sector-scoped and must
  // NOT be broadcast cross-sector.
  const wasPotential = isPotentialConversation(conv);

  const [updated] = await db.update(conversationsTable)
    .set(claimSet)
    .where(eq(conversationsTable.id, id)).returning();

  const claimRecipients = await restrictedRecipients(updated);
  broadcast("conversation_updated", updated, updated.sectorId, wasPotential, claimRecipients);
  // A conversa ficou restrita ao vendedor que assumiu: avisa quem a via antes
  // (potencial cross-sector ou fila do setor) para removê-la da lista.
  if (claimRecipients != null) {
    broadcast("conversation_hidden", { id: updated.id, keepFor: claimRecipients, sectorId: updated.sectorId }, conv.sectorId, wasPotential);
  }
  res.json(updated);
});

// ─── WhatsApp connections (read-only, for labeling) ────────────────────────
// Lista leve das conexões de WhatsApp (número de atendimento) para que o
// frontend identifique por qual conexão cada conversa chega. Diferente de
// /whatsapp/sessions (admin), aqui qualquer usuário logado pode ler — só
// nome/numero, sem QR nem status detalhado.
router.get("/chat/wa-sessions", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      sessionKey: whatsappSessionsTable.sessionKey,
      displayName: whatsappSessionsTable.displayName,
      phoneNumber: whatsappSessionsTable.phoneNumber,
    })
    .from(whatsappSessionsTable)
    .orderBy(whatsappSessionsTable.id);
  res.json(rows);
});

// ─── Excluir atendimento (somente admin) ───────────────────────────────────
// Remove definitivamente a conversa (mensagens e participantes juntos).
// Restrito a POTENCIAIS (lead novo sem dono): conversas já assumidas ou
// finalizadas fazem parte do histórico e não podem ser apagadas por aqui.
router.delete("/chat/conversations/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, id)).limit(1);
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada" }); return; }
  if (!isPotentialConversation(conv)) {
    res.status(409).json({ error: "Só é possível excluir atendimentos em Potenciais (sem responsável e não finalizados)" });
    return;
  }

  await db.transaction(async (tx) => {
    await tx.delete(messagesTable).where(eq(messagesTable.conversationId, id));
    await tx.delete(conversationParticipantsTable).where(eq(conversationParticipantsTable.conversationId, id));
    await tx.delete(conversationsTable).where(eq(conversationsTable.id, id));
  });

  // Potenciais são visíveis a todos — o evento de remoção também precisa ser.
  broadcast("conversation_deleted", { id }, conv.sectorId, true);
  res.json({ ok: true });
});

// ─── Create conversation manually ─────────────────────────────────────────
router.post("/chat/conversations", requireAuth, async (req, res): Promise<void> => {
  const { phone, name, channel, sectorId } = req.body as {
    phone?: string; name?: string; channel?: string; sectorId?: number;
  };
  if (!phone || !name) { res.status(400).json({ error: "Telefone e nome obrigatórios" }); return; }

  const userRole = req.session.userRole!;
  const userSectorId = req.session.userSectorId;

  // Vendedores must create conversations in their own sector only
  const effectiveSectorId = (userRole === "admin" || userRole === "supervisor")
    ? (sectorId ?? userSectorId ?? 1)
    : (userSectorId ?? 1);

  const [conv] = await db.insert(conversationsTable).values({
    phone, name,
    channel: channel ?? "manual",
    sectorId: effectiveSectorId,
    status: "open",
    lastMessageAt: new Date(),
  }).returning();

  broadcast("conversation_new", conv, conv.sectorId, isPotentialConversation(conv), await restrictedRecipients(conv));
  // Keep the CRM in sync with atendimentos: register the customer immediately.
  await ensureCrmContactForConversation(conv);
  res.status(201).json(conv);
});

// ─── Etiquetas (chat labels) management ───────────────────────────────────
router.get("/chat/labels", requireAuth, async (_req, res): Promise<void> => {
  const labels = await db
    .select()
    .from(chatLabelsTable)
    .where(eq(chatLabelsTable.isActive, true))
    .orderBy(asc(chatLabelsTable.sortOrder), asc(chatLabelsTable.id));
  res.json(labels);
});

router.post("/chat/labels", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const { name, color, sortOrder } = req.body as { name?: string; color?: string; sortOrder?: number };
  if (!name || !name.trim()) { res.status(400).json({ error: "Nome da etiqueta é obrigatório" }); return; }
  const hex = /^#[0-9a-fA-F]{6}$/.test(color ?? "") ? color! : "#1a2e6e";
  const [created] = await db.insert(chatLabelsTable).values({
    name: name.trim(),
    color: hex,
    sortOrder: sortOrder ?? 0,
  }).returning();
  res.status(201).json(created);
});

router.patch("/chat/labels/:labelId", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const labelId = parseInt(String(req.params.labelId), 10);
  if (isNaN(labelId)) { res.status(400).json({ error: "ID inválido" }); return; }
  const [existing] = await db.select().from(chatLabelsTable).where(eq(chatLabelsTable.id, labelId)).limit(1);
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
  const [updated] = await db.update(chatLabelsTable).set(update).where(eq(chatLabelsTable.id, labelId)).returning();
  res.json(updated);
});

router.delete("/chat/labels/:labelId", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const labelId = parseInt(String(req.params.labelId), 10);
  if (isNaN(labelId)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.delete(chatLabelsTable).where(eq(chatLabelsTable.id, labelId));
  res.json({ ok: true });
});

// ─── List users available for participant assignment ──────────────────────
router.get("/chat/users", requireAuth, async (_req, res): Promise<void> => {
  const users = await db
    .select({ id: usersTable.id, name: usersTable.name, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.isActive, true));
  res.json(users);
});

// ─── Conversation participants ─────────────────────────────────────────────
router.post("/chat/conversations/:id/participants", requireAuth, async (req, res): Promise<void> => {
  const convId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const { userId } = req.body as { userId?: number };
  if (!userId) { res.status(400).json({ error: "userId obrigatório" }); return; }

  const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, convId));
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada" }); return; }
  if (!(await canAccessConversation(conv, req))) { res.status(403).json({ error: "Acesso negado" }); return; }

  await db.insert(conversationParticipantsTable).values({ conversationId: convId, userId }).onConflictDoNothing();

  // When a vendedor is added to a conversation, route it into the "Pendentes"
  // queue so they can review and approve/assume the attendance ("Iniciar
  // atendimento"). Only do this when nobody is actively handling it yet and it
  // isn't already queued or finished, so an active or resolved conversation is
  // never knocked back into the queue.
  const [addedUser] = await db
    .select({ role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const shouldQueue =
    addedUser?.role === "vendedor" &&
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
      .where(eq(conversationsTable.id, convId))
      .returning();
    broadcast("conversation_updated", updated, updated.sectorId, wasPotential);
    broadcast("participants_updated", { conversationId: convId }, updated.sectorId, false);
    res.status(201).json({ ok: true, conversation: updated });
    return;
  }

  broadcast("participants_updated", { conversationId: convId }, conv.sectorId, isPotentialConversation(conv), await restrictedRecipients(conv));
  res.status(201).json({ ok: true });
});

router.delete("/chat/conversations/:id/participants/:userId", requireAuth, async (req, res): Promise<void> => {
  const convId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = parseInt(Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId, 10);

  const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, convId));
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
  broadcast("participants_updated", { conversationId: convId }, conv.sectorId, isPotentialConversation(conv), removeRecipients ? [...new Set([...removeRecipients, userId])] : null);
  if (removeRecipients != null) {
    broadcast("conversation_hidden", { id: convId, keepFor: removeRecipients, sectorId: conv.sectorId }, conv.sectorId, false, [...new Set([...removeRecipients, userId])]);
  }
  res.json({ ok: true });
});

// ─── Serve saved media files ───────────────────────────────────────────────
router.get("/chat/media/:filename", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const filename = path.basename(req.params.filename as string);
  const filepath = path.join(MEDIA_DIR, filename);
  if (!existsSync(filepath)) {
    res.status(404).json({ error: "Mídia não encontrada" });
    return;
  }

  // Resolve the media file to its owning conversation and enforce sector access.
  const mediaUrl = `/api/chat/media/${filename}`;
  const [owningMsg] = await db
    .select({ conversationId: messagesTable.conversationId })
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
    .where(eq(conversationsTable.id, owningMsg.conversationId))
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
router.post("/chat/conversations/:id/suggest-reply", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);

  const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, id)).limit(1);
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada" }); return; }
  if (!(await canAccessConversation(conv, req))) { res.status(403).json({ error: "Acesso negado" }); return; }

  // Resolve the linked CRM contact (find by normalized phone, scoped to the
  // conversation's sector — same rule used by the CRM sync helpers).
  const normalizedPhone = (conv.phone ?? "").replace(/\D/g, "");
  let contact: typeof crmContactsTable.$inferSelect | undefined;
  if (normalizedPhone && !(conv.phone ?? "").includes("@g.us")) {
    const sectorCondition = conv.sectorId != null
      ? eq(crmContactsTable.sectorId, conv.sectorId)
      : isNull(crmContactsTable.sectorId);
    [contact] = await db.select().from(crmContactsTable)
      .where(and(eq(crmContactsTable.isArchived, false), eq(crmContactsTable.phone, normalizedPhone), sectorCondition))
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
      const defs = await db.select().from(crmCustomFieldsTable);
      const defMap = Object.fromEntries(defs.map((d) => [String(d.id), d.name]));
      for (const [key, value] of Object.entries(cf)) {
        if (value == null || value === "") continue;
        infoLines.push(`${defMap[key] ?? key}: ${value}`);
      }
    }
  }
  if (conv.sectorId != null) {
    const [sector] = await db.select({ name: sectorsTable.name }).from(sectorsTable)
      .where(eq(sectorsTable.id, conv.sectorId)).limit(1);
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
    .map((m) => `${m.direction === "inbound" ? "Cliente" : "Atendente"}: ${m.content}`)
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
    const { openai } = await import("@workspace/integrations-openai-ai");
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
router.post("/chat/correct-text", requireAuth, async (req, res): Promise<void> => {
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
    const { openai } = await import("@workspace/integrations-openai-ai");
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
