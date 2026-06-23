import { Router, type IRouter } from "express";
import { db, crmContactsTable, sectorsTable, usersTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/crm", requireAuth, async (req, res): Promise<void> => {
  const userRole = req.session.userRole!;
  const userSectorId = req.session.userSectorId ?? null;

  const allContacts = await db
    .select()
    .from(crmContactsTable)
    .where(eq(crmContactsTable.isArchived, false))
    .orderBy(desc(crmContactsTable.updatedAt));

  // Attendants see only their sector; admins see all
  const contacts = userRole === "admin"
    ? allContacts
    : allContacts.filter((c) => c.sectorId === userSectorId);

  // Attach sector and attendant names
  const sectors = await db.select().from(sectorsTable);
  const users = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable);
  const sectorMap = Object.fromEntries(sectors.map((s) => [s.id, s]));
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

  const enriched = contacts.map((c) => ({
    ...c,
    sector: c.sectorId ? (sectorMap[c.sectorId] ?? null) : null,
    attendant: c.attendantId ? (userMap[c.attendantId] ?? null) : null,
  }));

  res.json(enriched);
});

router.post("/crm", requireAuth, async (req, res): Promise<void> => {
  const { name, contact, sectorId, attendantId, status, notes, tags } = req.body as {
    name?: string;
    contact?: string;
    sectorId?: number;
    attendantId?: number;
    status?: string;
    notes?: string;
    tags?: string;
  };

  if (!name) { res.status(400).json({ error: "Nome é obrigatório" }); return; }

  const userRole = req.session.userRole!;
  const userSectorId = req.session.userSectorId ?? null;
  const effectiveSectorId = sectorId ?? (userRole !== "admin" ? userSectorId ?? undefined : undefined);

  const [contact_] = await db
    .insert(crmContactsTable)
    .values({
      name,
      contact,
      sectorId: effectiveSectorId ?? null,
      attendantId: attendantId ?? null,
      status: status ?? "potential",
      notes,
      tags,
    })
    .returning();

  res.status(201).json(contact_);
});

router.patch("/crm/:id", requireAuth, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  const [existing] = await db.select().from(crmContactsTable).where(eq(crmContactsTable.id, id));
  if (!existing) { res.status(404).json({ error: "Contato não encontrado" }); return; }

  const userRole = req.session.userRole!;
  const userSectorId = req.session.userSectorId ?? null;
  if (userRole !== "admin" && existing.sectorId !== userSectorId) {
    res.status(403).json({ error: "Acesso negado" }); return;
  }

  const { name, contact, sectorId, attendantId, status, notes, tags, isArchived } = req.body as {
    name?: string; contact?: string; sectorId?: number; attendantId?: number;
    status?: string; notes?: string; tags?: string; isArchived?: boolean;
  };

  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (name !== undefined) update.name = name;
  if (contact !== undefined) update.contact = contact;
  if (sectorId !== undefined) update.sectorId = sectorId;
  if (attendantId !== undefined) update.attendantId = attendantId;
  if (status !== undefined) update.status = status;
  if (notes !== undefined) update.notes = notes;
  if (tags !== undefined) update.tags = tags;
  if (isArchived !== undefined) update.isArchived = isArchived;

  const [updated] = await db
    .update(crmContactsTable)
    .set(update)
    .where(and(eq(crmContactsTable.id, id)))
    .returning();

  res.json(updated);
});

router.delete("/crm/:id", requireAuth, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  const [existing] = await db.select().from(crmContactsTable).where(eq(crmContactsTable.id, id));
  if (!existing) { res.status(404).json({ error: "Contato não encontrado" }); return; }

  const userRole = req.session.userRole!;
  const userSectorId = req.session.userSectorId ?? null;
  if (userRole !== "admin" && existing.sectorId !== userSectorId) {
    res.status(403).json({ error: "Acesso negado" }); return;
  }

  await db.update(crmContactsTable).set({ isArchived: true }).where(eq(crmContactsTable.id, id));
  res.json({ ok: true });
});

export default router;
