import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { createReadStream, existsSync } from "fs";
import path from "path";
import { db, conversationsTable, messagesTable, sectorsTable, usersTable, conversationParticipantsTable } from "@workspace/db";
import { eq, desc, and, or, ilike, sql, inArray } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { broadcast, sseEmitter } from "../lib/sseEmitter";
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
  const participants = await db
    .select({ id: usersTable.id, name: usersTable.name })
    .from(conversationParticipantsTable)
    .innerJoin(usersTable, eq(conversationParticipantsTable.userId, usersTable.id))
    .where(eq(conversationParticipantsTable.conversationId, conv.id));
  return { ...conv, sector: sector ?? null, assignee: assignee ?? null, participants };
}

// ─── List conversations ────────────────────────────────────────────────────
router.get("/chat/conversations", requireAuth, async (req, res): Promise<void> => {
  const { search, label, status, sectorId } = req.query as Record<string, string | undefined>;

  const userRole = req.session.userRole!;
  const userSectorId = req.session.userSectorId;

  const conditions = [eq(conversationsTable.isArchived, false)];

  if (userRole !== "admin" && userRole !== "supervisor" && userSectorId) {
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
  res.json(await enrichConversation(conv));
});

// ─── Get messages ──────────────────────────────────────────────────────────
router.get("/chat/conversations/:id/messages", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);

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
  const { base64, mimetype, filename } = req.body as {
    base64?: string;
    mimetype?: string;
    filename?: string;
  };

  if (!base64 || !mimetype) {
    res.status(400).json({ error: "base64 e mimetype são obrigatórios" });
    return;
  }

  const ALLOWED_MIMES_OUT = new Set([
    "image/jpeg", "image/png", "image/gif", "image/webp",
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
  const msgType: "image" | "doc" = isImage ? "image" : "doc";
  const waType: "image" | "document" = isImage ? "image" : "document";

  const senderName = req.session.userName ?? "Atendente";

  const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, id)).limit(1);
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada" }); return; }

  // Save file to media directory
  const { writeFile, mkdir } = await import("fs/promises");
  const { randomUUID } = await import("crypto");
  await mkdir(MEDIA_DIR, { recursive: true });

  const mimeToExt: Record<string, string> = {
    "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
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

  const displayName = filename ?? (isImage ? "📷 Foto" : "📄 Documento");
  const content = isImage ? "📷 Foto" : `📄 ${displayName}`;

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

  broadcast("message", { conversationId: id, message: msg });

  // Forward to WhatsApp bridge
  if (conv.channel === "whatsapp" && conv.phone) {
    const bridgeUrl = process.env["WHATSAPP_BRIDGE_URL"] ?? "http://localhost:3002";
    const bridgeSecret = createHmac(
      "sha256",
      process.env["SESSION_SECRET"] ?? "sheikcell-dev-only-secret",
    ).update("whatsapp-bridge-v1").digest("hex");
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
        }),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        req.log.warn(
          { status: r.status, body },
          "WhatsApp bridge media delivery failed — media saved but not delivered",
        );
      }
    } catch (err) {
      req.log.warn({ err }, "WhatsApp bridge unreachable — media saved but not delivered");
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

  // Forward to WhatsApp bridge (now uses Meta Cloud API) if this is a WhatsApp conversation
  if (conv?.channel === "whatsapp" && conv.phone) {
    const bridgeUrl = process.env["WHATSAPP_BRIDGE_URL"] ?? "http://localhost:3002";
    const bridgeSecret = createHmac(
      "sha256",
      process.env["SESSION_SECRET"] ?? "sheikcell-dev-only-secret",
    ).update("whatsapp-bridge-v1").digest("hex");
    try {
      const r = await fetch(`${bridgeUrl}/whatsapp/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Bridge-Secret": bridgeSecret,
        },
        body: JSON.stringify({ to: conv.phone, text: content.trim() }),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        req.log.warn(
          { status: r.status, body },
          "WhatsApp bridge delivery failed — message saved but not delivered",
        );
      }
    } catch (err) {
      req.log.warn({ err }, "WhatsApp bridge unreachable — message saved but not delivered");
    }
  }

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

  await db.insert(conversationParticipantsTable).values({ conversationId: convId, userId }).onConflictDoNothing();
  broadcast("participants_updated", { conversationId: convId });
  res.status(201).json({ ok: true });
});

router.delete("/chat/conversations/:id/participants/:userId", requireAuth, async (req, res): Promise<void> => {
  const convId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = parseInt(Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId, 10);

  await db.delete(conversationParticipantsTable)
    .where(and(
      eq(conversationParticipantsTable.conversationId, convId),
      eq(conversationParticipantsTable.userId, userId),
    ));
  broadcast("participants_updated", { conversationId: convId });
  res.json({ ok: true });
});

// ─── Serve saved media files ───────────────────────────────────────────────
router.get("/chat/media/:filename", requireAuth, (req: Request, res: Response): void => {
  const filename = path.basename(req.params.filename as string);
  const filepath = path.join(MEDIA_DIR, filename);
  if (!existsSync(filepath)) {
    res.status(404).json({ error: "Mídia não encontrada" });
    return;
  }
  const ext = path.extname(filename).slice(1).toLowerCase();
  const mimeMap: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    gif: "image/gif", webp: "image/webp",
    ogg: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", webm: "audio/webm",
    pdf: "application/pdf",
  };
  const contentType = mimeMap[ext] ?? "application/octet-stream";
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "private, max-age=86400");
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
  const isProduction = process.env["NODE_ENV"] === "production";

  if (metaSecret) {
    // Meta Cloud API: verify X-Hub-Signature-256
    const sig = req.headers["x-hub-signature-256"] as string | undefined;
    if (!verifyMetaSignature(req.rawBody, sig, metaSecret)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  } else if (isProduction) {
    // In production, META_WHATSAPP_WEBHOOK_SECRET is mandatory — fail closed
    req.log.error("META_WHATSAPP_WEBHOOK_SECRET not set in production — rejecting inbound webhook");
    res.status(503).json({ error: "Webhook not configured" });
    return;
  } else {
    // Development only: accept legacy bridge secret (HMAC-verified)
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

export default router;
