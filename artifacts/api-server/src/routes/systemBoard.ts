import { Router, type IRouter } from "express";
import { db, systemBoardItemsTable, systemBoardCommentsTable, usersTable } from "@workspace/db";
import { eq, and, desc, asc, inArray, sql } from "drizzle-orm";
import { requireAuth, requireFeature, requireTenant } from "../middlewares/auth";

const router: IRouter = Router();

// Quadro interno de desenvolvimento do sistema — só admin ou quem recebeu a
// função "sistema" liberada no cadastro (adminAccess) acessa.
router.use("/system-board", requireFeature("sistema"));

const TYPES = ["problema", "atualizacao", "implementacao"];
const STATUSES = ["aberto", "andamento", "concluido"];
const PRIORITIES = ["baixa", "media", "alta"];

async function enrichItem(t: typeof systemBoardItemsTable.$inferSelect) {
  const users = await db.select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable).where(eq(usersTable.tenantId, t.tenantId));
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));
  return {
    ...t,
    responsible: t.responsibleId ? (userMap[t.responsibleId] ?? null) : null,
    createdBy: t.createdById ? (userMap[t.createdById] ?? null) : null,
  };
}

async function loadItem(
  id: number,
  tenantId: number,
  res: Parameters<Parameters<typeof router.get>[1]>[1],
): Promise<typeof systemBoardItemsTable.$inferSelect | null> {
  const [t] = await db.select().from(systemBoardItemsTable)
    .where(and(eq(systemBoardItemsTable.id, id), eq(systemBoardItemsTable.tenantId, tenantId)));
  if (!t || t.isArchived) {
    res.status(404).json({ error: "Item não encontrado" });
    return null;
  }
  return t;
}

// ─── List ────────────────────────────────────────────────────────────────────
router.get("/system-board", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;

  const all = await db.select().from(systemBoardItemsTable)
    .where(and(eq(systemBoardItemsTable.tenantId, tenantId), eq(systemBoardItemsTable.isArchived, false)))
    .orderBy(asc(systemBoardItemsTable.position), desc(systemBoardItemsTable.updatedAt));

  const users = await db.select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable).where(eq(usersTable.tenantId, tenantId));
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

  const ids = all.map((t) => t.id);
  const comCounts = ids.length > 0
    ? await db.select({
        itemId: systemBoardCommentsTable.itemId,
        total: sql<number>`count(*)::int`,
      }).from(systemBoardCommentsTable).where(inArray(systemBoardCommentsTable.itemId, ids)).groupBy(systemBoardCommentsTable.itemId)
    : [];
  const comMap = Object.fromEntries(comCounts.map((c) => [c.itemId, c.total]));

  res.json(all.map((t) => ({
    ...t,
    responsible: t.responsibleId ? (userMap[t.responsibleId] ?? null) : null,
    createdBy: t.createdById ? (userMap[t.createdById] ?? null) : null,
    commentCount: comMap[t.id] ?? 0,
  })));
});

// ─── Comentários ─────────────────────────────────────────────────────────────
router.get("/system-board/:id/comments", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const existing = await loadItem(id, tenantId, res);
  if (!existing) return;
  const rows = await db
    .select({
      id: systemBoardCommentsTable.id,
      itemId: systemBoardCommentsTable.itemId,
      authorId: systemBoardCommentsTable.authorId,
      authorName: usersTable.name,
      content: systemBoardCommentsTable.content,
      createdAt: systemBoardCommentsTable.createdAt,
    })
    .from(systemBoardCommentsTable)
    .leftJoin(usersTable, eq(systemBoardCommentsTable.authorId, usersTable.id))
    .where(eq(systemBoardCommentsTable.itemId, id))
    .orderBy(asc(systemBoardCommentsTable.createdAt));
  res.json(rows);
});

router.post("/system-board/:id/comments", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const existing = await loadItem(id, tenantId, res);
  if (!existing) return;
  const { content } = req.body as { content?: string };
  const text = (content ?? "").trim();
  if (!text) { res.status(400).json({ error: "Comentário vazio" }); return; }
  const [inserted] = await db.insert(systemBoardCommentsTable)
    .values({ tenantId, itemId: id, authorId: req.session.userId ?? null, content: text.slice(0, 2000) })
    .returning();
  const [author] = await db.select({ name: usersTable.name }).from(usersTable)
    .where(eq(usersTable.id, req.session.userId!)).limit(1);
  res.status(201).json({ ...inserted, authorName: author?.name ?? null });
});

// ─── Create ──────────────────────────────────────────────────────────────────
router.post("/system-board", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { type, title, description, status, priority, responsibleId, dueDate } = req.body as {
    type?: string; title?: string; description?: string; status?: string; priority?: string;
    responsibleId?: number | null; dueDate?: string | null;
  };
  if (!title || !title.trim()) { res.status(400).json({ error: "Título é obrigatório" }); return; }
  let effectiveResponsibleId: number | null = null;
  if (responsibleId != null) {
    const [resp] = await db.select({ id: usersTable.id }).from(usersTable)
      .where(and(eq(usersTable.id, responsibleId), eq(usersTable.tenantId, tenantId)));
    if (!resp) { res.status(400).json({ error: "Responsável inválido" }); return; }
    effectiveResponsibleId = resp.id;
  }
  const [created] = await db.insert(systemBoardItemsTable).values({
    tenantId,
    type: TYPES.includes(type ?? "") ? type! : "implementacao",
    title: title.trim(),
    description: description || null,
    status: STATUSES.includes(status ?? "") ? status! : "aberto",
    priority: PRIORITIES.includes(priority ?? "") ? priority! : "media",
    responsibleId: effectiveResponsibleId,
    createdById: req.session.userId ?? null,
    dueDate: dueDate ? new Date(dueDate) : null,
  }).returning();
  res.status(201).json(await enrichItem(created));
});

// ─── Update ──────────────────────────────────────────────────────────────────
router.patch("/system-board/:id", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const existing = await loadItem(id, tenantId, res);
  if (!existing) return;
  const { type, title, description, status, priority, responsibleId, dueDate, position, isArchived } = req.body as {
    type?: string; title?: string; description?: string; status?: string; priority?: string;
    responsibleId?: number | null; dueDate?: string | null; position?: number; isArchived?: boolean;
  };
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (type !== undefined && TYPES.includes(type)) update.type = type;
  if (title !== undefined) update.title = title.trim();
  if (description !== undefined) update.description = description || null;
  if (status !== undefined && STATUSES.includes(status)) update.status = status;
  if (priority !== undefined && PRIORITIES.includes(priority)) update.priority = priority;
  if (responsibleId !== undefined) {
    if (responsibleId == null) {
      update.responsibleId = null;
    } else {
      const [resp] = await db.select({ id: usersTable.id }).from(usersTable)
        .where(and(eq(usersTable.id, responsibleId), eq(usersTable.tenantId, tenantId)));
      if (!resp) { res.status(400).json({ error: "Responsável inválido" }); return; }
      update.responsibleId = resp.id;
    }
  }
  if (dueDate !== undefined) update.dueDate = dueDate ? new Date(dueDate) : null;
  if (position !== undefined) update.position = position;
  if (isArchived !== undefined) update.isArchived = isArchived;
  const [updated] = await db.update(systemBoardItemsTable).set(update)
    .where(and(eq(systemBoardItemsTable.id, id), eq(systemBoardItemsTable.tenantId, tenantId))).returning();
  res.json(await enrichItem(updated));
});

// ─── Delete (archive) ────────────────────────────────────────────────────────
router.delete("/system-board/:id", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const existing = await loadItem(id, tenantId, res);
  if (!existing) return;
  await db.update(systemBoardItemsTable).set({ isArchived: true })
    .where(and(eq(systemBoardItemsTable.id, id), eq(systemBoardItemsTable.tenantId, tenantId)));
  res.json({ ok: true });
});

export default router;
