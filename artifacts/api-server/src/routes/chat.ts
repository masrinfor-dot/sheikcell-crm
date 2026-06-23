import { Router, type IRouter, type Request, type Response } from "express";
import { db, conversationsTable, messagesTable, sectorsTable, usersTable } from "@workspace/db";
import { eq, desc, and, or, ilike, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { broadcast, sseEmitter } from "../lib/sseEmitter";
import { classifyText } from "../lib/autoRouter";

const router: IRouter = Router();

// ─── SSE real-time stream ──────────────────────────────────────────────────
router.get("/chat/events", requireAuth, (req: Request, res: Response): void => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (payload: { event: string; data: unknown }) => {
    res.write(`event: ${payload.event}\n`);
    res.write(`data: ${JSON.stringify(payload.data)}\n\n`);
  };

  sseEmitter.on("broadcast", send);
  req.on("close", () => sseEmitter.off("broadcast", send));
});

// ─── Helpers ──────────────────────────────────────────────────────────────
async function enrichConversation(conv: typeof conversationsTable.$inferSelect) {
  const [sector] = conv.sectorId
    ? await db.select().from(sectorsTable).where(eq(sectorsTable.id, conv.sectorId))
    : [];
  const [assignee] = conv.assigneeId
    ? await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(eq(usersTable.id, conv.assigneeId))
    : [];
  return { ...conv, sector: sector ?? null, assignee: assignee ?? null };
}

// ─── List conversations ────────────────────────────────────────────────────
router.get("/chat/conversations", requireAuth, async (req, res): Promise<void> => {
  const { search, label, status, sectorId } = req.query as Record<string, string | undefined>;

  const userRole = req.session.userRole!;
  const userSectorId = req.session.userSectorId;

  let query = db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.isArchived, false))
    .orderBy(desc(conversationsTable.lastMessageAt))
    .$dynamic();

  const conditions = [eq(conversationsTable.isArchived, false)];

  if (userRole !== "admin" && userSectorId) {
    conditions.push(eq(conversationsTable.sectorId, userSectorId));
  } else if (sectorId) {
    conditions.push(eq(conversationsTable.sectorId, Number(sectorId)));
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

  const enriched = rows.map((c) => ({
    ...c,
    sector: c.sectorId ? (sectorMap[c.sectorId] ?? null) : null,
    assignee: c.assigneeId ? (userMap[c.assigneeId] ?? null) : null,
  }));

  res.json(enriched);
});

// ─── Get single conversation ───────────────────────────────────────────────
router.get("/chat/conversations/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, id));
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada" }); return; }
  res.json(await enrichConversation(conv));
});

// ─── Get messages ──────────────────────────────────────────────────────────
router.get("/chat/conversations/:id/messages", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);

  // Mark as read
  await db.update(conversationsTable).set({ unreadCount: 0 }).where(eq(conversationsTable.id, id));

  const msgs = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, id))
    .orderBy(messagesTable.createdAt)
    .limit(200);

  res.json(msgs);
});

// ─── Send message ──────────────────────────────────────────────────────────
router.post("/chat/conversations/:id/messages", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const { content } = req.body as { content?: string };
  if (!content?.trim()) { res.status(400).json({ error: "Mensagem vazia" }); return; }

  const senderName = req.session.userName ?? "Atendente";

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

  broadcast("message", { conversationId: id, message: msg });
  res.status(201).json(msg);
});

// ─── Update conversation ───────────────────────────────────────────────────
router.patch("/chat/conversations/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const { status, labels, sectorId, assigneeId, name, isArchived } = req.body as {
    status?: string; labels?: string; sectorId?: number;
    assigneeId?: number; name?: string; isArchived?: boolean;
  };

  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (status !== undefined) update.status = status;
  if (labels !== undefined) update.labels = labels;
  if (sectorId !== undefined) update.sectorId = sectorId;
  if (assigneeId !== undefined) update.assigneeId = assigneeId;
  if (name !== undefined) update.name = name;
  if (isArchived !== undefined) update.isArchived = isArchived;

  const [updated] = await db.update(conversationsTable).set(update)
    .where(eq(conversationsTable.id, id)).returning();

  broadcast("conversation_updated", updated);
  res.json(updated);
});

// ─── Create conversation manually ─────────────────────────────────────────
router.post("/chat/conversations", requireAuth, async (req, res): Promise<void> => {
  const { phone, name, channel, sectorId } = req.body as {
    phone?: string; name?: string; channel?: string; sectorId?: number;
  };
  if (!phone || !name) { res.status(400).json({ error: "Telefone e nome obrigatórios" }); return; }

  const userSectorId = req.session.userSectorId ?? sectorId ?? 1;

  const [conv] = await db.insert(conversationsTable).values({
    phone, name,
    channel: channel ?? "manual",
    sectorId: sectorId ?? userSectorId,
    status: "open",
    lastMessageAt: new Date(),
  }).returning();

  broadcast("conversation_new", conv);
  res.status(201).json(conv);
});

// ─── WhatsApp webhook (Evolution API / Z-API compatible) ──────────────────
router.post("/chat/webhook/whatsapp", async (req, res): Promise<void> => {
  const body = req.body as {
    event?: string;
    data?: {
      key?: { remoteJid?: string; fromMe?: boolean; id?: string };
      message?: { conversation?: string; extendedTextMessage?: { text?: string }; imageMessage?: { caption?: string } };
      pushName?: string;
      messageTimestamp?: number;
    };
    // Z-API format
    phone?: string; text?: { message?: string }; senderName?: string; messageId?: string;
    isGroupMsg?: boolean; fromMe?: boolean;
  };

  // Skip outbound and group
  const fromMe = body.data?.key?.fromMe ?? body.fromMe ?? false;
  const isGroup = body.isGroupMsg ?? (body.data?.key?.remoteJid?.includes("@g.us") ?? false);
  if (fromMe || isGroup) { res.json({ ok: true }); return; }

  // Extract content (Evolution API)
  const remoteJid = body.data?.key?.remoteJid ?? (body.phone ? `${body.phone}@s.whatsapp.net` : null);
  const phone = remoteJid?.replace("@s.whatsapp.net", "").replace("@c.us", "") ?? "unknown";
  const pushName = body.data?.pushName ?? body.senderName ?? phone;
  const text =
    body.data?.message?.conversation ??
    body.data?.message?.extendedTextMessage?.text ??
    body.data?.message?.imageMessage?.caption ??
    body.text?.message ??
    "";
  const externalId = body.data?.key?.id ?? body.messageId ?? null;

  // Find or create conversation
  let [conv] = await db.select().from(conversationsTable)
    .where(and(eq(conversationsTable.phone, phone), eq(conversationsTable.isArchived, false)))
    .orderBy(desc(conversationsTable.lastMessageAt))
    .limit(1);

  if (!conv) {
    const classified = text ? await classifyText(text) : null;
    const [first] = await db.select().from(sectorsTable).where(eq(sectorsTable.isActive, true)).limit(1);
    const targetSectorId = classified?.sectorId ?? first?.id ?? 1;
    [conv] = await db.insert(conversationsTable).values({
      phone, name: pushName, channel: "whatsapp",
      sectorId: targetSectorId,
      status: "open",
      lastMessage: text,
      lastMessageAt: new Date(),
      unreadCount: 1,
    }).returning();
    broadcast("conversation_new", conv);
  } else {
    await db.update(conversationsTable).set({
      lastMessage: text,
      lastMessageAt: new Date(),
      unreadCount: sql`${conversationsTable.unreadCount} + 1`,
      updatedAt: new Date(),
    }).where(eq(conversationsTable.id, conv.id));
  }

  const [msg] = await db.insert(messagesTable).values({
    conversationId: conv.id,
    content: text || "(mídia)",
    direction: "inbound",
    type: "text",
    status: "delivered",
    senderName: pushName,
    externalId,
  }).returning();

  broadcast("message", { conversationId: conv.id, message: msg });
  res.json({ ok: true });
});

export default router;
