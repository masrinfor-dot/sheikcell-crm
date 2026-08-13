import { Router, type IRouter, type Request, type Response } from "express";
import { db, internalConversationsTable, internalConversationMembersTable, internalMessagesTable, usersTable, tenantsTable } from "@workspace/db";
import { eq, and, asc, inArray, sql, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { requireAuth, requireAdmin, requireTenant, isTenantSuspended, requireModule } from "../middlewares/auth";
import {
  sseEmitter,
  broadcastInternal,
  bufferedInternalEventsSince,
  reconnectInternalStrategy,
  type BufferedInternalEvent,
} from "../lib/sseEmitter";
import { createReadStream, existsSync, statSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { randomUUID } from "crypto";
import path from "path";
import { MEDIA_DIR } from "../lib/whatsappInbound";

const router: IRouter = Router();

// Módulo "equipe" (Chat Interno) contratado pela loja.
router.use("/internal-chat", requireModule("equipe"));

const GENERAL_ROOM_NAME = "Equipe (Geral)";

// Ensure the single general/team room DA LOJA (tenant) exists and return its id.
// O índice único parcial é (tenant_id, kind) para kind='general', logo cada
// loja tem exatamente uma sala geral.
// null = a loja excluiu a sala geral de propósito (tenants.internal_chat_general_disabled) — não recria.
async function ensureGeneralRoom(tenantId: number): Promise<number | null> {
  const [existing] = await db
    .select({ id: internalConversationsTable.id })
    .from(internalConversationsTable)
    .where(and(eq(internalConversationsTable.tenantId, tenantId), eq(internalConversationsTable.kind, "general")))
    .limit(1);
  if (existing) return existing.id;

  const [tenant] = await db.select({ disabled: tenantsTable.internalChatGeneralDisabled })
    .from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1);
  if (tenant?.disabled) return null;

  // Conflict-safe: a partial unique index on (tenant_id, kind='general')
  // guarantees a single row per tenant, so concurrent first accesses converge.
  await db
    .insert(internalConversationsTable)
    .values({ tenantId, kind: "general", name: GENERAL_ROOM_NAME })
    .onConflictDoNothing();
  const [row] = await db
    .select({ id: internalConversationsTable.id })
    .from(internalConversationsTable)
    .where(and(eq(internalConversationsTable.tenantId, tenantId), eq(internalConversationsTable.kind, "general")))
    .limit(1);
  return row!.id;
}

async function ensureMembership(conversationId: number, userId: number, tenantId: number): Promise<void> {
  await db
    .insert(internalConversationMembersTable)
    .values({ tenantId, conversationId, userId })
    .onConflictDoNothing();
}

// Returns the user ids that should receive real-time events for a conversation:
// every member for a direct chat, and `null` (everyone) for the general room.
async function recipientsFor(conv: { id: number; kind: string }): Promise<number[] | null> {
  if (conv.kind === "general") return null;
  const members = await db
    .select({ userId: internalConversationMembersTable.userId })
    .from(internalConversationMembersTable)
    .where(eq(internalConversationMembersTable.conversationId, conv.id));
  return members.map((m) => m.userId);
}

// ─── SSE real-time stream for internal chat ────────────────────────────────
router.get("/internal-chat/events", requireAuth, (req: Request, res: Response): void => {
  // Fail closed: sessão sem loja (superadmin / sessão antiga) não recebe eventos.
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const userId = req.session.userId!;

  // An event reaches this user when it belongs to the SAME loja (tenant) AND
  // targets everyone in it (recipientIds == null) or explicitly includes them.
  const allowed = (ev: { tenantId: number; recipientIds: number[] | null }): boolean =>
    ev.tenantId === tenantId && (ev.recipientIds == null || ev.recipientIds.includes(userId));

  const writeEvent = (ev: { id?: number; event: string; data: unknown }) => {
    if (ev.id != null) res.write(`id: ${ev.id}\n`);
    res.write(`event: ${ev.event}\n`);
    res.write(`data: ${JSON.stringify(ev.data)}\n\n`);
  };

  // sseEmitter.emit() chama TODOS os streams internos abertos no processo (de
  // qualquer conversa, qualquer loja — o filtro por loja/destinatário roda
  // dentro de allowed()), na mesma call stack de quem disparou o evento (ex.:
  // o POST /messages de OUTRO usuário enviando em OUTRA conversa). Se este
  // stream em particular estiver numa conexão morta/travada, res.write() pode
  // lançar; sem o try/catch isso derruba o emit inteiro, e o erro sobe até o
  // handler alheio que chamou broadcastInternal — como não há middleware de
  // erro nem express-async-errors, o Express 5 responde 500 pra ELE, mesmo a
  // mensagem dele já tendo sido salva no banco. Quanto mais gente conectada
  // (grupos grandes = mais participantes = mais streams simultâneos), maior a
  // chance de UM estar nesse estado numa hora aleatória. Isolando aqui: uma
  // conexão ruim só se remove a si mesma, nunca derruba o envio de outro.
  const send = (payload: BufferedInternalEvent) => {
    if (!allowed(payload)) return;
    try {
      writeEvent(payload);
    } catch {
      sseEmitter.off("internal", send);
      res.destroy();
    }
  };

  // ── Reconnect recovery ──
  // EventSource resends the id of the last event it received in the
  // `Last-Event-ID` header. Replay everything missed during the disconnection
  // (still applying the recipient filter, so no one receives events for
  // conversations they don't participate in). If too much was missed (evicted
  // from the buffer) or the server restarted, ask the client to refetch.
  const rawLastId = req.headers["last-event-id"];
  const sinceRaw = Array.isArray(rawLastId) ? rawLastId[0] : rawLastId;
  const sinceId = sinceRaw != null ? Number.parseInt(sinceRaw, 10) : NaN;
  if (Number.isFinite(sinceId)) {
    const strategy = reconnectInternalStrategy(sinceId);
    if (strategy === "resync") {
      writeEvent({ event: "resync", data: { reason: "gap" } });
    } else if (strategy === "replay") {
      for (const ev of bufferedInternalEventsSince(sinceId)) {
        if (allowed(ev)) writeEvent(ev);
      }
      // The client bumps per-conversation unread counters by +1 for each
      // replayed message, which is only approximate. Emit an ordered sentinel
      // AFTER all replayed events so the client reconciles its counters against
      // the authoritative server counts. No `id` field, so this does not disturb
      // the client's Last-Event-ID (a subsequent reconnect still resumes from
      // the last real event).
      writeEvent({ event: "internal_reconnect", data: { reason: "replay" } });
    }
  }

  // Loja suspensa: derruba streams já abertos periodicamente (a suspensão não
  // pode esperar o usuário reconectar — na reconexão o requireAuth barra).
  const suspensionCheck = setInterval(() => {
    isTenantSuspended(tenantId).then((s) => { if (s) res.end(); }).catch(() => {});
  }, 30_000);

  sseEmitter.on("internal", send);
  req.on("close", () => {
    clearInterval(suspensionCheck);
    sseEmitter.off("internal", send);
  });
});

// ─── List my conversations (general room + direct chats) ───────────────────
router.get("/internal-chat/conversations", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const userId = req.session.userId!;

  const generalId = await ensureGeneralRoom(tenantId);
  if (generalId != null) await ensureMembership(generalId, userId, tenantId);

  const memberships = await db
    .select({
      conversationId: internalConversationMembersTable.conversationId,
      lastReadAt: internalConversationMembersTable.lastReadAt,
      kind: internalConversationsTable.kind,
      name: internalConversationsTable.name,
      lastMessage: internalConversationsTable.lastMessage,
      lastMessageAt: internalConversationsTable.lastMessageAt,
      createdAt: internalConversationsTable.createdAt,
    })
    .from(internalConversationMembersTable)
    .innerJoin(internalConversationsTable, eq(internalConversationMembersTable.conversationId, internalConversationsTable.id))
    .where(and(
      eq(internalConversationMembersTable.userId, userId),
      eq(internalConversationsTable.tenantId, tenantId),
    ));

  const convIds = memberships.map((m) => m.conversationId);

  // Other members (to name/identify direct chats).
  const others = convIds.length > 0
    ? await db
        .select({
          conversationId: internalConversationMembersTable.conversationId,
          id: usersTable.id,
          name: usersTable.name,
          role: usersTable.role,
        })
        .from(internalConversationMembersTable)
        .innerJoin(usersTable, eq(internalConversationMembersTable.userId, usersTable.id))
        .where(and(
          inArray(internalConversationMembersTable.conversationId, convIds),
          ne(internalConversationMembersTable.userId, userId),
        ))
    : [];
  const otherMap: Record<number, { id: number; name: string; role: string }> = {};
  const memberNamesMap: Record<number, string[]> = {};
  for (const o of others) {
    otherMap[o.conversationId] = { id: o.id, name: o.name, role: o.role };
    (memberNamesMap[o.conversationId] ??= []).push(o.name);
  }

  // Unread counts: messages newer than my lastReadAt, not sent by me.
  const unreadRows = convIds.length > 0
    ? await db
        .select({
          conversationId: internalMessagesTable.conversationId,
          count: sql<number>`count(*)::int`,
        })
        .from(internalMessagesTable)
        .innerJoin(internalConversationMembersTable, and(
          eq(internalConversationMembersTable.conversationId, internalMessagesTable.conversationId),
          eq(internalConversationMembersTable.userId, userId),
        ))
        .where(and(
          inArray(internalMessagesTable.conversationId, convIds),
          ne(internalMessagesTable.senderId, userId),
          sql`(${internalConversationMembersTable.lastReadAt} IS NULL OR ${internalMessagesTable.createdAt} > ${internalConversationMembersTable.lastReadAt})`,
        ))
        .groupBy(internalMessagesTable.conversationId)
    : [];
  const unreadMap: Record<number, number> = {};
  for (const u of unreadRows) unreadMap[u.conversationId] = u.count;

  const result = memberships.map((m) => {
    const other = otherMap[m.conversationId] ?? null;
    return {
      id: m.conversationId,
      kind: m.kind as "direct" | "general" | "group",
      name: m.kind === "general" ? (m.name ?? GENERAL_ROOM_NAME)
        : m.kind === "group" ? (m.name ?? "Grupo")
        : (other?.name ?? "Conversa"),
      otherUser: m.kind === "direct" ? other : null,
      memberNames: m.kind === "group" ? (memberNamesMap[m.conversationId] ?? []) : undefined,
      lastMessage: m.lastMessage,
      lastMessageAt: m.lastMessageAt,
      unreadCount: unreadMap[m.conversationId] ?? 0,
    };
  });

  // General room pinned first, then by most recent activity.
  result.sort((a, b) => {
    if (a.kind === "general") return -1;
    if (b.kind === "general") return 1;
    const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
    return bt - at;
  });

  res.json(result);
});

// ─── Create a group conversation (grupo do chat interno) ───────────────────
// Any staff user may create a group, naming it and escolhendo os participantes.
// O criador sempre entra como membro. Grupos usam o mesmo escopo dos diretos:
// só membros veem, recebem eventos e podem enviar mensagens.
// Só admin cria grupos (conversas diretas continuam liberadas para todos).
router.post("/internal-chat/conversations/group", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const userId = req.session.userId!;
  const { name, memberIds } = req.body as { name?: string; memberIds?: number[] };
  const cleanName = (name ?? "").trim().slice(0, 80);
  if (!cleanName) { res.status(400).json({ error: "Dê um nome ao grupo" }); return; }
  const ids = Array.isArray(memberIds) ? [...new Set(memberIds.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== userId))] : [];
  if (ids.length === 0) { res.status(400).json({ error: "Escolha pelo menos um participante" }); return; }

  // Só usuários da MESMA loja (tenant) entram no grupo.
  const valid = await db.select({ id: usersTable.id }).from(usersTable)
    .where(and(eq(usersTable.tenantId, tenantId), inArray(usersTable.id, ids)));
  if (valid.length === 0) { res.status(400).json({ error: "Nenhum participante válido" }); return; }

  const [created] = await db
    .insert(internalConversationsTable)
    .values({ tenantId, kind: "group", name: cleanName })
    .returning();
  await db.insert(internalConversationMembersTable).values([
    { tenantId, conversationId: created!.id, userId },
    ...valid.map((v) => ({ tenantId, conversationId: created!.id, userId: v.id })),
  ]).onConflictDoNothing();

  const conv = {
    id: created!.id,
    kind: "group" as const,
    name: cleanName,
    otherUser: null,
    lastMessage: null,
    lastMessageAt: null,
    unreadCount: 0,
  };
  // Avisa os participantes em tempo real para o grupo aparecer na lista deles.
  broadcastInternal("internal_conversation_new", conv, tenantId, [userId, ...valid.map((v) => v.id)]);
  res.status(201).json(conv);
});

// ─── Start (or fetch) a direct 1:1 conversation ────────────────────────────
router.post("/internal-chat/conversations/direct", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const userId = req.session.userId!;
  const { userId: targetIdRaw } = req.body as { userId?: number };
  const targetId = Number(targetIdRaw);
  if (!targetId || Number.isNaN(targetId)) { res.status(400).json({ error: "Usuário inválido" }); return; }
  if (targetId === userId) { res.status(400).json({ error: "Não é possível conversar consigo mesmo" }); return; }

  // Só é possível iniciar DM com alguém da MESMA loja (tenant).
  const [target] = await db.select({ id: usersTable.id }).from(usersTable)
    .where(and(eq(usersTable.id, targetId), eq(usersTable.tenantId, tenantId))).limit(1);
  if (!target) { res.status(404).json({ error: "Usuário não encontrado" }); return; }

  // Find an existing direct conversation shared by both users (na mesma loja).
  const myDirect = await db
    .select({ conversationId: internalConversationMembersTable.conversationId })
    .from(internalConversationMembersTable)
    .innerJoin(internalConversationsTable, eq(internalConversationMembersTable.conversationId, internalConversationsTable.id))
    .where(and(
      eq(internalConversationMembersTable.userId, userId),
      eq(internalConversationsTable.tenantId, tenantId),
      eq(internalConversationsTable.kind, "direct"),
    ));
  const myDirectIds = myDirect.map((r) => r.conversationId);

  let convId: number | null = null;
  if (myDirectIds.length > 0) {
    const [shared] = await db
      .select({ conversationId: internalConversationMembersTable.conversationId })
      .from(internalConversationMembersTable)
      .where(and(
        eq(internalConversationMembersTable.userId, targetId),
        inArray(internalConversationMembersTable.conversationId, myDirectIds),
      ))
      .limit(1);
    if (shared) convId = shared.conversationId;
  }

  if (convId == null) {
    const [created] = await db
      .insert(internalConversationsTable)
      .values({ tenantId, kind: "direct" })
      .returning({ id: internalConversationsTable.id });
    convId = created!.id;
    await db.insert(internalConversationMembersTable).values([
      { tenantId, conversationId: convId, userId },
      { tenantId, conversationId: convId, userId: targetId },
    ]).onConflictDoNothing();
  }

  const [other] = await db
    .select({ id: usersTable.id, name: usersTable.name, role: usersTable.role })
    .from(usersTable)
    .where(and(eq(usersTable.id, targetId), eq(usersTable.tenantId, tenantId)))
    .limit(1);

  res.json({
    id: convId,
    kind: "direct" as const,
    name: other?.name ?? "Conversa",
    otherUser: other ?? null,
    lastMessage: null,
    lastMessageAt: null,
    unreadCount: 0,
  });
});

// Resolve o preview de "responder mensagem": só aceita citar uma mensagem da
// MESMA conversa (evita vazar conteúdo de outra conversa/loja via replyToId
// arbitrário) — se o id não existir ali, a resposta segue sem citação.
async function resolveReplyTo(
  replyToId: number | undefined,
  convId: number,
  tenantId: number,
): Promise<{ replyToId: number | null; replyTo: { id: number; senderName: string; content: string; type: string } | null }> {
  if (replyToId == null) return { replyToId: null, replyTo: null };
  const [row] = await db
    .select({ id: internalMessagesTable.id, senderName: usersTable.name, content: internalMessagesTable.content, type: internalMessagesTable.type })
    .from(internalMessagesTable)
    .innerJoin(usersTable, eq(internalMessagesTable.senderId, usersTable.id))
    .where(and(
      eq(internalMessagesTable.id, replyToId),
      eq(internalMessagesTable.conversationId, convId),
      eq(internalMessagesTable.tenantId, tenantId),
    ))
    .limit(1);
  if (!row) return { replyToId: null, replyTo: null };
  return { replyToId: row.id, replyTo: row };
}

// Verify the current user may access a conversation; returns the conv or null.
// Sempre restrito à loja (tenant): conversas de outra loja retornam null.
async function getAccessibleConversation(convId: number, userId: number, tenantId: number) {
  const [conv] = await db.select().from(internalConversationsTable)
    .where(and(eq(internalConversationsTable.id, convId), eq(internalConversationsTable.tenantId, tenantId))).limit(1);
  if (!conv) return null;
  if (conv.kind === "general") {
    await ensureMembership(conv.id, userId, tenantId);
    return conv;
  }
  const [member] = await db
    .select({ userId: internalConversationMembersTable.userId })
    .from(internalConversationMembersTable)
    .where(and(
      eq(internalConversationMembersTable.conversationId, convId),
      eq(internalConversationMembersTable.userId, userId),
    ))
    .limit(1);
  return member ? conv : null;
}

// ─── List messages of a conversation (and mark as read) ────────────────────
router.get("/internal-chat/conversations/:id/messages", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const userId = req.session.userId!;
  const convId = parseInt(Array.isArray(req.params.id) ? req.params.id[0]! : req.params.id!, 10);
  if (Number.isNaN(convId)) { res.status(400).json({ error: "Conversa inválida" }); return; }

  const conv = await getAccessibleConversation(convId, userId, tenantId);
  if (!conv) { res.status(403).json({ error: "Acesso negado" }); return; }

  const repliedMsg = alias(internalMessagesTable, "repliedMsg");
  const repliedSender = alias(usersTable, "repliedSender");

  const rows = await db
    .select({
      id: internalMessagesTable.id,
      conversationId: internalMessagesTable.conversationId,
      senderId: internalMessagesTable.senderId,
      senderName: usersTable.name,
      content: internalMessagesTable.content,
      type: internalMessagesTable.type,
      mediaUrl: internalMessagesTable.mediaUrl,
      transcript: internalMessagesTable.transcript,
      forwarded: internalMessagesTable.forwarded,
      createdAt: internalMessagesTable.createdAt,
      replyToId: internalMessagesTable.replyToId,
      replyToSenderName: repliedSender.name,
      replyToContent: repliedMsg.content,
      replyToType: repliedMsg.type,
    })
    .from(internalMessagesTable)
    .innerJoin(usersTable, eq(internalMessagesTable.senderId, usersTable.id))
    .leftJoin(repliedMsg, eq(internalMessagesTable.replyToId, repliedMsg.id))
    .leftJoin(repliedSender, eq(repliedMsg.senderId, repliedSender.id))
    .where(eq(internalMessagesTable.conversationId, convId))
    .orderBy(asc(internalMessagesTable.createdAt))
    .limit(500);

  // Mark as read.
  await db
    .update(internalConversationMembersTable)
    .set({ lastReadAt: new Date() })
    .where(and(
      eq(internalConversationMembersTable.conversationId, convId),
      eq(internalConversationMembersTable.userId, userId),
    ));

  res.json(rows.map(({ replyToSenderName, replyToContent, replyToType, ...m }) => ({
    ...m,
    replyTo: m.replyToId != null ? { id: m.replyToId, senderName: replyToSenderName, content: replyToContent, type: replyToType } : null,
  })));
});

// ─── Send a message ────────────────────────────────────────────────────────
router.post("/internal-chat/conversations/:id/messages", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const userId = req.session.userId!;
  const convId = parseInt(Array.isArray(req.params.id) ? req.params.id[0]! : req.params.id!, 10);
  if (Number.isNaN(convId)) { res.status(400).json({ error: "Conversa inválida" }); return; }

  const { content, replyToId: replyToIdRaw } = req.body as { content?: string; replyToId?: number };
  const text = (content ?? "").trim();
  if (!text) { res.status(400).json({ error: "Mensagem vazia" }); return; }

  const conv = await getAccessibleConversation(convId, userId, tenantId);
  if (!conv) { res.status(403).json({ error: "Acesso negado" }); return; }

  const { replyToId, replyTo } = await resolveReplyTo(replyToIdRaw, convId, tenantId);

  const [inserted] = await db
    .insert(internalMessagesTable)
    .values({ tenantId, conversationId: convId, senderId: userId, content: text, replyToId })
    .returning();

  await db
    .update(internalConversationsTable)
    .set({ lastMessage: text, lastMessageAt: inserted!.createdAt })
    .where(eq(internalConversationsTable.id, convId));

  // Sender read up to their own message.
  await db
    .update(internalConversationMembersTable)
    .set({ lastReadAt: inserted!.createdAt })
    .where(and(
      eq(internalConversationMembersTable.conversationId, convId),
      eq(internalConversationMembersTable.userId, userId),
    ));

  const [sender] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  const message = {
    id: inserted!.id,
    conversationId: convId,
    senderId: userId,
    senderName: sender?.name ?? "",
    content: text,
    type: "text" as const,
    mediaUrl: null,
    transcript: null,
    forwarded: false,
    replyToId,
    replyTo,
    createdAt: inserted!.createdAt,
  };

  const recipients = await recipientsFor(conv);
  broadcastInternal("internal_message", { conversationId: convId, kind: conv.kind, message }, tenantId, recipients);

  res.json(message);
});

// ─── Enviar mídia (foto, áudio ou documento) ───────────────────────────────
// Mesmo padrão do chat de clientes (base64 no corpo, validado por assinatura
// do arquivo — ver POST /chat/conversations/:id/media): sem multer, o front
// já manda o arquivo lido como data URL.
const MEDIA_MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a",
  "audio/webm": "weba", "audio/aac": "aac", "audio/wav": "wav",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};
const MEDIA_MAX_BYTES = 20 * 1024 * 1024;

router.post("/internal-chat/conversations/:id/media", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const userId = req.session.userId!;
  const convId = parseInt(Array.isArray(req.params.id) ? req.params.id[0]! : req.params.id!, 10);
  if (Number.isNaN(convId)) { res.status(400).json({ error: "Conversa inválida" }); return; }

  const { base64, mimetype: rawMimetype, filename, caption, replyToId: replyToIdRaw } = req.body as {
    base64?: string; mimetype?: string; filename?: string; caption?: string; replyToId?: number;
  };
  if (!base64 || !rawMimetype) { res.status(400).json({ error: "base64 e mimetype são obrigatórios" }); return; }
  const mimetype = rawMimetype.split(";")[0].trim().toLowerCase();
  const ext = MEDIA_MIME_TO_EXT[mimetype];
  if (!ext) { res.status(400).json({ error: "Tipo de arquivo não suportado" }); return; }

  const conv = await getAccessibleConversation(convId, userId, tenantId);
  if (!conv) { res.status(403).json({ error: "Acesso negado" }); return; }

  const { replyToId, replyTo } = await resolveReplyTo(replyToIdRaw, convId, tenantId);

  const buf = Buffer.from(base64, "base64");
  if (buf.byteLength === 0 || buf.byteLength > MEDIA_MAX_BYTES) {
    res.status(400).json({ error: "Arquivo inválido ou muito grande (máximo 20 MB)" });
    return;
  }

  await mkdir(MEDIA_DIR, { recursive: true });
  const savedFilename = `${randomUUID()}.${ext}`;
  await writeFile(path.join(MEDIA_DIR, savedFilename), buf);
  const mediaUrl = `/api/internal-chat/media/${savedFilename}`;

  const isImage = mimetype.startsWith("image/");
  const isAudio = mimetype.startsWith("audio/");
  const msgType: "image" | "audio" | "doc" = isImage ? "image" : isAudio ? "audio" : "doc";
  const baseContent = isImage ? "📷 Foto" : isAudio ? "🎤 Áudio" : `📄 ${filename ?? "Documento"}`;
  const text = caption ? `${baseContent}\n${caption}` : baseContent;

  const [inserted] = await db
    .insert(internalMessagesTable)
    .values({ tenantId, conversationId: convId, senderId: userId, content: text, type: msgType, mediaUrl, replyToId })
    .returning();

  await db.update(internalConversationsTable)
    .set({ lastMessage: text, lastMessageAt: inserted!.createdAt })
    .where(eq(internalConversationsTable.id, convId));
  await db.update(internalConversationMembersTable)
    .set({ lastReadAt: inserted!.createdAt })
    .where(and(eq(internalConversationMembersTable.conversationId, convId), eq(internalConversationMembersTable.userId, userId)));

  const [sender] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  const message = {
    id: inserted!.id, conversationId: convId, senderId: userId, senderName: sender?.name ?? "",
    content: text, type: msgType, mediaUrl, transcript: null, forwarded: false,
    replyToId, replyTo,
    createdAt: inserted!.createdAt,
  };

  const recipients = await recipientsFor(conv);
  broadcastInternal("internal_message", { conversationId: convId, kind: conv.kind, message }, tenantId, recipients);

  res.json(message);
});

// ─── Servir mídia salva (com controle de acesso pela conversa dona) ───────
router.get("/internal-chat/media/:filename", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const userId = req.session.userId!;
  const filename = path.basename(req.params.filename as string);
  const filepath = path.join(MEDIA_DIR, filename);
  if (!existsSync(filepath)) { res.status(404).json({ error: "Mídia não encontrada" }); return; }

  const mediaUrl = `/api/internal-chat/media/${filename}`;
  const [owningMsg] = await db.select({ conversationId: internalMessagesTable.conversationId })
    .from(internalMessagesTable).where(eq(internalMessagesTable.mediaUrl, mediaUrl)).limit(1);
  if (!owningMsg) { res.status(403).json({ error: "Acesso negado" }); return; }

  const conv = await getAccessibleConversation(owningMsg.conversationId, userId, tenantId);
  if (!conv) { res.status(403).json({ error: "Acesso negado" }); return; }

  const ext = path.extname(filename).slice(1).toLowerCase();
  const mimeMap: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
    ogg: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", weba: "audio/webm", aac: "audio/aac", wav: "audio/wav",
    pdf: "application/pdf", doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  res.setHeader("Content-Type", mimeMap[ext] ?? "application/octet-stream");
  res.setHeader("Cache-Control", "private, max-age=86400");

  const { size } = statSync(filepath);
  res.setHeader("Accept-Ranges", "bytes");
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
      if (start >= size || start > end) { res.status(416).setHeader("Content-Range", `bytes */${size}`).end(); return; }
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

// ─── Transcrever áudio (Whisper) ───────────────────────────────────────────
router.post("/internal-chat/messages/:id/transcribe", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const userId = req.session.userId!;
  const msgId = parseInt(Array.isArray(req.params.id) ? req.params.id[0]! : req.params.id!, 10);
  if (Number.isNaN(msgId)) { res.status(400).json({ error: "Mensagem inválida" }); return; }

  const [msg] = await db.select().from(internalMessagesTable)
    .where(and(eq(internalMessagesTable.id, msgId), eq(internalMessagesTable.tenantId, tenantId))).limit(1);
  if (!msg) { res.status(404).json({ error: "Mensagem não encontrada" }); return; }
  const conv = await getAccessibleConversation(msg.conversationId, userId, tenantId);
  if (!conv) { res.status(403).json({ error: "Acesso negado" }); return; }

  try {
    // Import dinâmico: o cliente OpenAI lança erro já na carga do módulo se
    // OPENAI_API_KEY não estiver configurada — isso não pode derrubar o
    // servidor inteiro no boot (mesmo padrão de lib/transcribe.ts).
    const { transcribeInternalMessage } = await import("../lib/internalTranscribe");
    const transcript = await transcribeInternalMessage(msgId);
    const recipients = await recipientsFor(conv);
    broadcastInternal("internal_message_updated", { conversationId: conv.id, messageId: msgId, transcript }, tenantId, recipients);
    res.json({ transcript });
  } catch (err) {
    res.status(422).json({ error: err instanceof Error ? err.message : "Falha ao transcrever" });
  }
});

// ─── Encaminhar mensagem para outra(s) conversa(s) ─────────────────────────
// A mensagem encaminhada é uma cópia independente (conteúdo/mídia), então
// continua existindo mesmo que a original seja apagada depois.
router.post("/internal-chat/messages/:id/forward", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const userId = req.session.userId!;
  const msgId = parseInt(Array.isArray(req.params.id) ? req.params.id[0]! : req.params.id!, 10);
  if (Number.isNaN(msgId)) { res.status(400).json({ error: "Mensagem inválida" }); return; }

  const { conversationIds } = req.body as { conversationIds?: number[] };
  const targets = Array.isArray(conversationIds)
    ? [...new Set(conversationIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    : [];
  if (targets.length === 0) { res.status(400).json({ error: "Escolha ao menos uma conversa de destino" }); return; }

  const [source] = await db.select().from(internalMessagesTable)
    .where(and(eq(internalMessagesTable.id, msgId), eq(internalMessagesTable.tenantId, tenantId))).limit(1);
  if (!source) { res.status(404).json({ error: "Mensagem não encontrada" }); return; }
  if (!(await getAccessibleConversation(source.conversationId, userId, tenantId))) {
    res.status(403).json({ error: "Acesso negado" });
    return;
  }

  const [sender] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  const sent: { conversationId: number; message: unknown }[] = [];

  for (const convId of targets) {
    const conv = await getAccessibleConversation(convId, userId, tenantId);
    if (!conv) continue; // ignora destinos sem acesso, silenciosamente

    const [inserted] = await db.insert(internalMessagesTable).values({
      tenantId, conversationId: convId, senderId: userId,
      content: source.content, type: source.type, mediaUrl: source.mediaUrl,
      forwarded: true,
    }).returning();

    await db.update(internalConversationsTable)
      .set({ lastMessage: source.content, lastMessageAt: inserted!.createdAt })
      .where(eq(internalConversationsTable.id, convId));
    await db.update(internalConversationMembersTable)
      .set({ lastReadAt: inserted!.createdAt })
      .where(and(eq(internalConversationMembersTable.conversationId, convId), eq(internalConversationMembersTable.userId, userId)));

    const message = {
      id: inserted!.id, conversationId: convId, senderId: userId, senderName: sender?.name ?? "",
      content: source.content, type: source.type, mediaUrl: source.mediaUrl, transcript: source.transcript,
      forwarded: true, replyToId: null, replyTo: null, createdAt: inserted!.createdAt,
    };
    const recipients = await recipientsFor(conv);
    broadcastInternal("internal_message", { conversationId: convId, kind: conv.kind, message }, tenantId, recipients);
    sent.push({ conversationId: convId, message });
  }

  if (sent.length === 0) { res.status(403).json({ error: "Nenhum destino acessível" }); return; }
  res.json({ ok: true, sent });
});

// ─── Excluir grupo ──────────────────────────────────────────────────────────
// Só grupos podem ser excluídos (nunca a sala geral nem conversas diretas).
// Quem pode: somente admin (qualquer grupo) — sempre da MESMA loja.
router.delete("/internal-chat/conversations/:id", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const convId = parseInt(Array.isArray(req.params.id) ? req.params.id[0]! : req.params.id!, 10);
  if (Number.isNaN(convId)) { res.status(400).json({ error: "Conversa inválida" }); return; }

  const [conv] = await db.select().from(internalConversationsTable)
    .where(and(eq(internalConversationsTable.id, convId), eq(internalConversationsTable.tenantId, tenantId))).limit(1);
  if (!conv) { res.status(404).json({ error: "Grupo não encontrado" }); return; }
  if (conv.kind !== "group") { res.status(400).json({ error: "Só grupos podem ser excluídos" }); return; }

  // Captura os membros ANTES de apagar (depois não dá mais para saber quem eram)
  // e só avisa se ESTA requisição realmente apagou o grupo (evita evento falso
  // quando duas exclusões simultâneas disputam o mesmo grupo).
  const recipients = await recipientsFor(conv);
  const deleted = await db
    .delete(internalConversationsTable)
    .where(and(eq(internalConversationsTable.id, convId), eq(internalConversationsTable.tenantId, tenantId), eq(internalConversationsTable.kind, "group")))
    .returning({ id: internalConversationsTable.id }); // cascade apaga membros e mensagens
  if (deleted.length === 0) { res.status(404).json({ error: "Grupo não encontrado" }); return; }
  broadcastInternal("internal_conversation_removed", { id: convId }, tenantId, recipients);
  res.json({ ok: true });
});

// ─── Excluir a sala "Equipe (Geral)" ────────────────────────────────────────
// Diferente de um grupo comum: marca a loja como "sala geral desativada"
// ANTES de apagar, senão ensureGeneralRoom() recriaria uma nova (vazia) no
// próximo GET /internal-chat/conversations de qualquer membro da equipe.
// Só admin — perde o histórico de mensagens pra sempre, sem "desfazer".
router.delete("/internal-chat/general", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;

  const [conv] = await db.select().from(internalConversationsTable)
    .where(and(eq(internalConversationsTable.tenantId, tenantId), eq(internalConversationsTable.kind, "general"))).limit(1);
  if (!conv) { res.status(404).json({ error: "Sala geral não encontrada" }); return; }

  await db.update(tenantsTable).set({ internalChatGeneralDisabled: true }).where(eq(tenantsTable.id, tenantId));

  const recipients = await recipientsFor(conv); // null = todo mundo (era a sala geral)
  const deleted = await db
    .delete(internalConversationsTable)
    .where(and(eq(internalConversationsTable.id, conv.id), eq(internalConversationsTable.tenantId, tenantId), eq(internalConversationsTable.kind, "general")))
    .returning({ id: internalConversationsTable.id }); // cascade apaga membros e mensagens
  if (deleted.length === 0) { res.status(404).json({ error: "Sala geral não encontrada" }); return; }
  broadcastInternal("internal_conversation_removed", { id: conv.id }, tenantId, recipients);
  res.json({ ok: true });
});

// ─── Listar membros de um grupo (para o modal de edição) ───────────────────
// Só admin edita, mas qualquer membro pode ver quem participa.
router.get("/internal-chat/conversations/:id/members", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const userId = req.session.userId!;
  const convId = parseInt(Array.isArray(req.params.id) ? req.params.id[0]! : req.params.id!, 10);
  if (Number.isNaN(convId)) { res.status(400).json({ error: "Conversa inválida" }); return; }

  // Membros veem quem participa; admin também (precisa para editar grupos que
  // administra sem virar membro — ver PATCH abaixo: histórico segue restrito).
  let conv = await getAccessibleConversation(convId, userId, tenantId);
  if (!conv && req.session.userRole === "admin") {
    const [adminView] = await db.select().from(internalConversationsTable)
      .where(and(eq(internalConversationsTable.id, convId), eq(internalConversationsTable.tenantId, tenantId), eq(internalConversationsTable.kind, "group")))
      .limit(1);
    conv = adminView ?? null;
  }
  if (!conv) { res.status(403).json({ error: "Acesso negado" }); return; }

  const members = await db
    .select({ id: usersTable.id, name: usersTable.name, role: usersTable.role })
    .from(internalConversationMembersTable)
    .innerJoin(usersTable, eq(internalConversationMembersTable.userId, usersTable.id))
    .where(eq(internalConversationMembersTable.conversationId, convId));
  res.json(members);
});

// ─── Editar grupo (renomear e adicionar/remover participantes) ─────────────
// Somente admin (mesma regra da criação/exclusão). As mensagens ficam intactas:
// só o nome e a lista de membros mudam. memberIds é a lista COMPLETA desejada.
// Eventos: added → internal_conversation_new; removed → internal_conversation_removed;
// quem fica → internal_conversation_updated (nome/membros novos em tempo real).
router.patch("/internal-chat/conversations/:id", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const convId = parseInt(Array.isArray(req.params.id) ? req.params.id[0]! : req.params.id!, 10);
  if (Number.isNaN(convId)) { res.status(400).json({ error: "Conversa inválida" }); return; }

  const [conv] = await db.select().from(internalConversationsTable)
    .where(and(eq(internalConversationsTable.id, convId), eq(internalConversationsTable.tenantId, tenantId))).limit(1);
  if (!conv) { res.status(404).json({ error: "Grupo não encontrado" }); return; }
  if (conv.kind !== "group") { res.status(400).json({ error: "Só grupos podem ser editados" }); return; }

  const { name, memberIds } = req.body as { name?: string; memberIds?: number[] };

  let newName = conv.name;
  if (name !== undefined) {
    const cleanName = (name ?? "").trim().slice(0, 80);
    if (!cleanName) { res.status(400).json({ error: "Dê um nome ao grupo" }); return; }
    newName = cleanName;
  }

  // Membros atuais (antes da mudança) — necessários para saber quem avisar.
  const currentRows = await db
    .select({ userId: internalConversationMembersTable.userId })
    .from(internalConversationMembersTable)
    .where(eq(internalConversationMembersTable.conversationId, convId));
  const currentIds = currentRows.map((r) => r.userId);

  let addedIds: number[] = [];
  let removedIds: number[] = [];
  let finalIds = currentIds;

  if (memberIds !== undefined) {
    const wanted = Array.isArray(memberIds)
      ? [...new Set(memberIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
      : [];
    if (wanted.length === 0) { res.status(400).json({ error: "O grupo precisa de pelo menos um participante" }); return; }
    // Só usuários da MESMA loja (tenant).
    const valid = await db.select({ id: usersTable.id }).from(usersTable)
      .where(and(eq(usersTable.tenantId, tenantId), inArray(usersTable.id, wanted)));
    const validIds = valid.map((v) => v.id);
    if (validIds.length === 0) { res.status(400).json({ error: "Nenhum participante válido" }); return; }

    const currentSet = new Set(currentIds);
    const wantedSet = new Set(validIds);
    addedIds = validIds.filter((id) => !currentSet.has(id));
    removedIds = currentIds.filter((id) => !wantedSet.has(id));
    finalIds = validIds;

    if (addedIds.length > 0) {
      await db.insert(internalConversationMembersTable)
        .values(addedIds.map((uid) => ({ tenantId, conversationId: convId, userId: uid })))
        .onConflictDoNothing();
    }
    if (removedIds.length > 0) {
      await db.delete(internalConversationMembersTable)
        .where(and(
          eq(internalConversationMembersTable.conversationId, convId),
          inArray(internalConversationMembersTable.userId, removedIds),
        ));
    }
  }

  if (newName !== conv.name) {
    await db.update(internalConversationsTable)
      .set({ name: newName })
      .where(eq(internalConversationsTable.id, convId));
  }

  // Nomes dos membros finais (o cliente monta o "Você, Fulano, ..." filtrando a si mesmo).
  const finalMembers = finalIds.length > 0
    ? await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable)
        .where(inArray(usersTable.id, finalIds))
    : [];

  const convPayload = {
    id: convId,
    kind: "group" as const,
    name: newName ?? "Grupo",
    otherUser: null,
    members: finalMembers,
    lastMessage: conv.lastMessage,
    lastMessageAt: conv.lastMessageAt,
    unreadCount: 0,
  };

  // Adicionados: grupo aparece na lista deles na hora.
  if (addedIds.length > 0) broadcastInternal("internal_conversation_new", convPayload, tenantId, addedIds);
  // Removidos: grupo some da lista deles na hora.
  if (removedIds.length > 0) broadcastInternal("internal_conversation_removed", { id: convId }, tenantId, removedIds);
  // Quem fica: vê o nome/participantes atualizados em tempo real.
  const staying = finalIds.filter((id) => !addedIds.includes(id));
  if (staying.length > 0) {
    broadcastInternal("internal_conversation_updated", { id: convId, name: newName ?? "Grupo", members: finalMembers }, tenantId, staying);
  }

  res.json(convPayload);
});

// ─── Mark a conversation as read ───────────────────────────────────────────
router.post("/internal-chat/conversations/:id/read", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const userId = req.session.userId!;
  const convId = parseInt(Array.isArray(req.params.id) ? req.params.id[0]! : req.params.id!, 10);
  if (Number.isNaN(convId)) { res.status(400).json({ error: "Conversa inválida" }); return; }

  const conv = await getAccessibleConversation(convId, userId, tenantId);
  if (!conv) { res.status(403).json({ error: "Acesso negado" }); return; }

  await db
    .update(internalConversationMembersTable)
    .set({ lastReadAt: new Date() })
    .where(and(
      eq(internalConversationMembersTable.conversationId, convId),
      eq(internalConversationMembersTable.userId, userId),
    ));

  res.json({ ok: true });
});

export default router;
