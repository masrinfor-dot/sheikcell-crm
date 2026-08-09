import { Router, type IRouter, type Request, type Response } from "express";
import { db, saasTicketsTable, saasTicketMessagesTable, usersTable } from "@workspace/db";
import { eq, and, asc, desc } from "drizzle-orm";
import { requireAuth, requireTenant } from "../middlewares/auth";
import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { randomUUID } from "crypto";
import path from "path";
import { MEDIA_DIR } from "../lib/whatsappInbound";

// Chamados de suporte técnico — lado da loja: abrir, ver os próprios
// chamados e conversar com quem está atendendo (superadmin/técnico).
// Timeline própria (saas_ticket_messages), não se mistura com WhatsApp/chat
// interno. O lado superadmin (triagem cross-tenant) fica em superadminSaas.ts.
const router: IRouter = Router();

const VALID_CATEGORIES = ["bug", "duvida", "melhoria"];
const VALID_PRIORITIES = ["baixa", "normal", "alta", "urgente"];

// Mesmo padrão sem multer do chat interno/WhatsApp: front manda o arquivo
// já lido como base64.
const MEDIA_MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
  "application/pdf": "pdf",
};
const MEDIA_MAX_BYTES = 20 * 1024 * 1024;

async function saveAttachment(base64: string, rawMimetype: string): Promise<{ mediaUrl: string; mediaType: string } | { error: string }> {
  const mimetype = rawMimetype.split(";")[0]!.trim().toLowerCase();
  const ext = MEDIA_MIME_TO_EXT[mimetype];
  if (!ext) return { error: "Tipo de arquivo não suportado" };
  const buf = Buffer.from(base64, "base64");
  if (buf.byteLength === 0 || buf.byteLength > MEDIA_MAX_BYTES) {
    return { error: "Arquivo inválido ou muito grande (máximo 20 MB)" };
  }
  await mkdir(MEDIA_DIR, { recursive: true });
  const savedFilename = `${randomUUID()}.${ext}`;
  await writeFile(path.join(MEDIA_DIR, savedFilename), buf);
  return { mediaUrl: `/api/tickets/media/${savedFilename}`, mediaType: mimetype };
}

// ── Lista os chamados do tenant do usuário logado ──────────────────────────
router.get("/tickets", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await db.select().from(saasTicketsTable)
    .where(eq(saasTicketsTable.tenantId, tenantId))
    .orderBy(desc(saasTicketsTable.createdAt));
  res.json({ tickets: rows });
});

// ── Abre um novo chamado (com mensagem inicial + anexo opcional) ──────────
router.post("/tickets", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const userId = req.session.userId!;
  const { title, description, category, priority, attachment } = req.body as {
    title?: string; description?: string; category?: string; priority?: string;
    attachment?: { base64: string; mimetype: string };
  };
  if (!title?.trim()) { res.status(400).json({ error: "Informe um título curto pro chamado" }); return; }
  const cat = category && VALID_CATEGORIES.includes(category) ? category : "duvida";
  const pri = priority && VALID_PRIORITIES.includes(priority) ? priority : "normal";

  const [user] = await db.select({ name: usersTable.name, storeName: usersTable.storeName })
    .from(usersTable).where(eq(usersTable.id, userId)).limit(1);

  let mediaUrl: string | null = null;
  let mediaType: string | null = null;
  if (attachment?.base64 && attachment.mimetype) {
    const saved = await saveAttachment(attachment.base64, attachment.mimetype);
    if ("error" in saved) { res.status(400).json({ error: saved.error }); return; }
    mediaUrl = saved.mediaUrl; mediaType = saved.mediaType;
  }

  const [ticket] = await db.insert(saasTicketsTable).values({
    tenantId, title: title.trim(), description: description?.trim() || null,
    category: cat, priority: pri,
    openedByUserId: userId, storeName: user?.storeName ?? null,
  }).returning();

  // Mensagem inicial: a descrição (ou só o anexo) já entra na timeline pra
  // não ter chamado "vazio" quando o técnico abrir pra responder.
  if (description?.trim() || mediaUrl) {
    await db.insert(saasTicketMessagesTable).values({
      ticketId: ticket!.id, authorType: "tenant", authorUserId: userId,
      authorName: user?.name ?? "Loja", content: description?.trim() || null,
      mediaUrl, mediaType,
    });
  }

  res.status(201).json({ ticket });
});

async function loadOwnTicket(id: number, tenantId: number) {
  const [ticket] = await db.select().from(saasTicketsTable)
    .where(and(eq(saasTicketsTable.id, id), eq(saasTicketsTable.tenantId, tenantId))).limit(1);
  return ticket ?? null;
}

// ── Timeline de mensagens do chamado ───────────────────────────────────────
router.get("/tickets/:id/messages", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Chamado inválido" }); return; }
  const ticket = await loadOwnTicket(id, tenantId);
  if (!ticket) { res.status(404).json({ error: "Chamado não encontrado" }); return; }
  const rows = await db.select().from(saasTicketMessagesTable)
    .where(eq(saasTicketMessagesTable.ticketId, id)).orderBy(asc(saasTicketMessagesTable.createdAt));
  res.json({ ticket, messages: rows });
});

// ── Responde no chamado ─────────────────────────────────────────────────────
router.post("/tickets/:id/messages", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const userId = req.session.userId!;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Chamado inválido" }); return; }
  const ticket = await loadOwnTicket(id, tenantId);
  if (!ticket) { res.status(404).json({ error: "Chamado não encontrado" }); return; }

  const { content, attachment } = req.body as { content?: string; attachment?: { base64: string; mimetype: string } };
  let mediaUrl: string | null = null;
  let mediaType: string | null = null;
  if (attachment?.base64 && attachment.mimetype) {
    const saved = await saveAttachment(attachment.base64, attachment.mimetype);
    if ("error" in saved) { res.status(400).json({ error: saved.error }); return; }
    mediaUrl = saved.mediaUrl; mediaType = saved.mediaType;
  }
  if (!content?.trim() && !mediaUrl) { res.status(400).json({ error: "Escreva uma mensagem ou anexe um arquivo" }); return; }

  const [user] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  const [message] = await db.insert(saasTicketMessagesTable).values({
    ticketId: id, authorType: "tenant", authorUserId: userId,
    authorName: user?.name ?? "Loja", content: content?.trim() || null, mediaUrl, mediaType,
  }).returning();

  res.status(201).json({ message });
});

// ── Serve anexo (imagem/vídeo/pdf) do chamado ──────────────────────────────
router.get("/tickets/media/:filename", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const filename = path.basename(req.params.filename as string);
  const filepath = path.join(MEDIA_DIR, filename);
  if (!existsSync(filepath)) { res.status(404).json({ error: "Arquivo não encontrado" }); return; }

  const mediaUrl = `/api/tickets/media/${filename}`;
  const [owningMsg] = await db.select({ ticketId: saasTicketMessagesTable.ticketId })
    .from(saasTicketMessagesTable).where(eq(saasTicketMessagesTable.mediaUrl, mediaUrl)).limit(1);
  if (!owningMsg) { res.status(403).json({ error: "Acesso negado" }); return; }
  const ticket = await loadOwnTicket(owningMsg.ticketId, tenantId);
  if (!ticket) { res.status(403).json({ error: "Acesso negado" }); return; }

  res.sendFile(filepath);
});

export default router;
