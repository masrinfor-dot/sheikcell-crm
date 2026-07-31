import { Router, type IRouter, type Request, type Response } from "express";
import { db, internalConversationsTable, internalConversationMembersTable, internalMessagesTable, usersTable } from "@workspace/db";
import { eq, and, asc, inArray, sql, ne } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import {
  sseEmitter,
  broadcastInternal,
  bufferedInternalEventsSince,
  reconnectInternalStrategy,
  type BufferedInternalEvent,
} from "../lib/sseEmitter";

const router: IRouter = Router();

const GENERAL_ROOM_NAME = "Equipe (Geral)";

// Ensure the single general/team room exists and return its id.
async function ensureGeneralRoom(): Promise<number> {
  const [existing] = await db
    .select({ id: internalConversationsTable.id })
    .from(internalConversationsTable)
    .where(eq(internalConversationsTable.kind, "general"))
    .limit(1);
  if (existing) return existing.id;
  // Conflict-safe: a partial unique index on kind='general' guarantees a single
  // row, so concurrent first accesses converge on the same conversation.
  await db
    .insert(internalConversationsTable)
    .values({ kind: "general", name: GENERAL_ROOM_NAME })
    .onConflictDoNothing();
  const [row] = await db
    .select({ id: internalConversationsTable.id })
    .from(internalConversationsTable)
    .where(eq(internalConversationsTable.kind, "general"))
    .limit(1);
  return row!.id;
}

async function ensureMembership(conversationId: number, userId: number): Promise<void> {
  await db
    .insert(internalConversationMembersTable)
    .values({ conversationId, userId })
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
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const userId = req.session.userId!;

  // An event reaches this user when it targets everyone (recipientIds == null)
  // or explicitly includes their id.
  const allowed = (ev: { recipientIds: number[] | null }): boolean =>
    ev.recipientIds == null || ev.recipientIds.includes(userId);

  const writeEvent = (ev: { id?: number; event: string; data: unknown }) => {
    if (ev.id != null) res.write(`id: ${ev.id}\n`);
    res.write(`event: ${ev.event}\n`);
    res.write(`data: ${JSON.stringify(ev.data)}\n\n`);
  };

  const send = (payload: BufferedInternalEvent) => {
    if (!allowed(payload)) return;
    writeEvent(payload);
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

  sseEmitter.on("internal", send);
  req.on("close", () => sseEmitter.off("internal", send));
});

// ─── List my conversations (general room + direct chats) ───────────────────
router.get("/internal-chat/conversations", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;

  const generalId = await ensureGeneralRoom();
  await ensureMembership(generalId, userId);

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
    .where(eq(internalConversationMembersTable.userId, userId));

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
router.post("/internal-chat/conversations/group", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const { name, memberIds } = req.body as { name?: string; memberIds?: number[] };
  const cleanName = (name ?? "").trim().slice(0, 80);
  if (!cleanName) { res.status(400).json({ error: "Dê um nome ao grupo" }); return; }
  const ids = Array.isArray(memberIds) ? [...new Set(memberIds.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== userId))] : [];
  if (ids.length === 0) { res.status(400).json({ error: "Escolha pelo menos um participante" }); return; }

  // Só usuários ativos existentes entram no grupo.
  const valid = await db.select({ id: usersTable.id }).from(usersTable).where(inArray(usersTable.id, ids));
  if (valid.length === 0) { res.status(400).json({ error: "Nenhum participante válido" }); return; }

  const [created] = await db
    .insert(internalConversationsTable)
    .values({ kind: "group", name: cleanName })
    .returning();
  await db.insert(internalConversationMembersTable).values([
    { conversationId: created!.id, userId },
    ...valid.map((v) => ({ conversationId: created!.id, userId: v.id })),
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
  broadcastInternal("internal_conversation_new", conv, [userId, ...valid.map((v) => v.id)]);
  res.status(201).json(conv);
});

// ─── Start (or fetch) a direct 1:1 conversation ────────────────────────────
router.post("/internal-chat/conversations/direct", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const { userId: targetIdRaw } = req.body as { userId?: number };
  const targetId = Number(targetIdRaw);
  if (!targetId || Number.isNaN(targetId)) { res.status(400).json({ error: "Usuário inválido" }); return; }
  if (targetId === userId) { res.status(400).json({ error: "Não é possível conversar consigo mesmo" }); return; }

  const [target] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, targetId)).limit(1);
  if (!target) { res.status(404).json({ error: "Usuário não encontrado" }); return; }

  // Find an existing direct conversation shared by both users.
  const myDirect = await db
    .select({ conversationId: internalConversationMembersTable.conversationId })
    .from(internalConversationMembersTable)
    .innerJoin(internalConversationsTable, eq(internalConversationMembersTable.conversationId, internalConversationsTable.id))
    .where(and(
      eq(internalConversationMembersTable.userId, userId),
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
      .values({ kind: "direct" })
      .returning({ id: internalConversationsTable.id });
    convId = created!.id;
    await db.insert(internalConversationMembersTable).values([
      { conversationId: convId, userId },
      { conversationId: convId, userId: targetId },
    ]).onConflictDoNothing();
  }

  const [other] = await db
    .select({ id: usersTable.id, name: usersTable.name, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, targetId))
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

// Verify the current user may access a conversation; returns the conv or null.
async function getAccessibleConversation(convId: number, userId: number) {
  const [conv] = await db.select().from(internalConversationsTable).where(eq(internalConversationsTable.id, convId)).limit(1);
  if (!conv) return null;
  if (conv.kind === "general") {
    await ensureMembership(conv.id, userId);
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
  const userId = req.session.userId!;
  const convId = parseInt(Array.isArray(req.params.id) ? req.params.id[0]! : req.params.id!, 10);
  if (Number.isNaN(convId)) { res.status(400).json({ error: "Conversa inválida" }); return; }

  const conv = await getAccessibleConversation(convId, userId);
  if (!conv) { res.status(403).json({ error: "Acesso negado" }); return; }

  const rows = await db
    .select({
      id: internalMessagesTable.id,
      conversationId: internalMessagesTable.conversationId,
      senderId: internalMessagesTable.senderId,
      senderName: usersTable.name,
      content: internalMessagesTable.content,
      createdAt: internalMessagesTable.createdAt,
    })
    .from(internalMessagesTable)
    .innerJoin(usersTable, eq(internalMessagesTable.senderId, usersTable.id))
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

  res.json(rows);
});

// ─── Send a message ────────────────────────────────────────────────────────
router.post("/internal-chat/conversations/:id/messages", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const convId = parseInt(Array.isArray(req.params.id) ? req.params.id[0]! : req.params.id!, 10);
  if (Number.isNaN(convId)) { res.status(400).json({ error: "Conversa inválida" }); return; }

  const { content } = req.body as { content?: string };
  const text = (content ?? "").trim();
  if (!text) { res.status(400).json({ error: "Mensagem vazia" }); return; }

  const conv = await getAccessibleConversation(convId, userId);
  if (!conv) { res.status(403).json({ error: "Acesso negado" }); return; }

  const [inserted] = await db
    .insert(internalMessagesTable)
    .values({ conversationId: convId, senderId: userId, content: text })
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
    createdAt: inserted!.createdAt,
  };

  const recipients = await recipientsFor(conv);
  broadcastInternal("internal_message", { conversationId: convId, kind: conv.kind, message }, recipients);

  res.json(message);
});

// ─── Excluir grupo ──────────────────────────────────────────────────────────
// Só grupos podem ser excluídos (nunca a sala geral nem conversas diretas).
// Quem pode: admin (qualquer grupo) ou supervisor que seja membro do grupo.
router.delete("/internal-chat/conversations/:id", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const userRole = req.session.userRole!;
  const convId = parseInt(Array.isArray(req.params.id) ? req.params.id[0]! : req.params.id!, 10);
  if (Number.isNaN(convId)) { res.status(400).json({ error: "Conversa inválida" }); return; }

  const [conv] = await db.select().from(internalConversationsTable).where(eq(internalConversationsTable.id, convId)).limit(1);
  if (!conv) { res.status(404).json({ error: "Grupo não encontrado" }); return; }
  if (conv.kind !== "group") { res.status(400).json({ error: "Só grupos podem ser excluídos" }); return; }

  if (userRole !== "admin") {
    if (userRole !== "supervisor") { res.status(403).json({ error: "Só admin ou supervisor pode excluir grupos" }); return; }
    const [member] = await db
      .select({ userId: internalConversationMembersTable.userId })
      .from(internalConversationMembersTable)
      .where(and(
        eq(internalConversationMembersTable.conversationId, convId),
        eq(internalConversationMembersTable.userId, userId),
      ))
      .limit(1);
    if (!member) { res.status(403).json({ error: "Você não participa desse grupo" }); return; }
  }

  // Captura os membros ANTES de apagar (depois não dá mais para saber quem eram)
  // e só avisa se ESTA requisição realmente apagou o grupo (evita evento falso
  // quando duas exclusões simultâneas disputam o mesmo grupo).
  const recipients = await recipientsFor(conv);
  const deleted = await db
    .delete(internalConversationsTable)
    .where(and(eq(internalConversationsTable.id, convId), eq(internalConversationsTable.kind, "group")))
    .returning({ id: internalConversationsTable.id }); // cascade apaga membros e mensagens
  if (deleted.length === 0) { res.status(404).json({ error: "Grupo não encontrado" }); return; }
  broadcastInternal("internal_conversation_removed", { id: convId }, recipients);
  res.json({ ok: true });
});

// ─── Mark a conversation as read ───────────────────────────────────────────
router.post("/internal-chat/conversations/:id/read", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const convId = parseInt(Array.isArray(req.params.id) ? req.params.id[0]! : req.params.id!, 10);
  if (Number.isNaN(convId)) { res.status(400).json({ error: "Conversa inválida" }); return; }

  const conv = await getAccessibleConversation(convId, userId);
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
