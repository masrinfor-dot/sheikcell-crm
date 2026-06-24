import { Router, type IRouter } from "express";
import { db, crmContactsTable, crmPurchasesTable, crmInternalNotesTable, crmCustomFieldsTable, sectorsTable, usersTable, attendanceLogsTable } from "@workspace/db";
import { eq, and, desc, asc, ilike, or } from "drizzle-orm";
import { requireAuth, requireAdminOrSupervisor } from "../middlewares/auth";
import type { Request } from "express";

const router: IRouter = Router();

// ─── helpers ──────────────────────────────────────────────────────────────
async function enrichContact(c: typeof crmContactsTable.$inferSelect) {
  const sectors = await db.select().from(sectorsTable);
  const users = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable);
  const sectorMap = Object.fromEntries(sectors.map((s) => [s.id, s]));
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));
  return {
    ...c,
    sector: c.sectorId ? (sectorMap[c.sectorId] ?? null) : null,
    attendant: c.attendantId ? (userMap[c.attendantId] ?? null) : null,
  };
}

/**
 * Normalizes a client-supplied customFields payload into a flat
 * Record<string, string>. Non-object input becomes {}, and each value is
 * coerced to a string (objects/arrays are dropped) so the stored jsonb always
 * matches the typed shape and never crashes string-based rendering downstream.
 */
function sanitizeCustomFields(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value == null) continue;
    if (typeof value === "string") out[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") out[key] = String(value);
    // objects/arrays/functions are intentionally skipped
  }
  return out;
}

/**
 * Returns true if the caller is allowed to access a contact that belongs to
 * the given sectorId. Admins have global access; all other roles are pinned
 * to their own sector.
 */
function isGlobalRole(role: string | undefined): boolean {
  // Admins and supervisors have global visibility; vendedores are sector-scoped.
  // Kept consistent with the chat module so a supervisor can open the CRM record
  // of any conversation they can see.
  return role === "admin" || role === "supervisor";
}

function callerCanAccessSector(session: Request["session"], contactSectorId: number | null): boolean {
  if (isGlobalRole(session.userRole)) return true;
  return contactSectorId === (session.userSectorId ?? null);
}

/**
 * Fetches a contact by id, checks that it is not archived, and verifies that
 * the caller is allowed to access its sector. Returns the contact on success
 * or sends the appropriate error response and returns null.
 */
async function loadContactWithAccess(
  id: number,
  session: Request["session"],
  res: Parameters<Parameters<typeof router.get>[1]>[1],
): Promise<typeof crmContactsTable.$inferSelect | null> {
  const [c] = await db.select().from(crmContactsTable).where(eq(crmContactsTable.id, id));
  if (!c || c.isArchived) {
    res.status(404).json({ error: "Contato não encontrado" });
    return null;
  }
  if (!callerCanAccessSector(session, c.sectorId)) {
    res.status(403).json({ error: "Acesso negado" });
    return null;
  }
  return c;
}

// ─── SPECIFIC routes FIRST (before /:id) ──────────────────────────────────

// Auto-register from queue / chat (POST /crm/auto-register before POST /crm/:id)
router.post("/crm/auto-register", requireAuth, async (req, res): Promise<void> => {
  const { name, phone, contact, sectorId } = req.body as {
    name?: string; phone?: string; contact?: string; sectorId?: number;
  };
  if (!name) { res.status(400).json({ error: "Nome é obrigatório" }); return; }

  const userRole = req.session.userRole!;
  const userSectorId = req.session.userSectorId ?? null;
  // Sector-scoped roles are pinned to their own sector; they cannot specify a different one.
  const effectiveSectorId = isGlobalRole(userRole) ? (sectorId ?? null) : userSectorId;

  const normalizedPhone = (phone ?? contact ?? "").replace(/\D/g, "");
  let existing: typeof crmContactsTable.$inferSelect | undefined;
  if (normalizedPhone) {
    // Scope the lookup to the caller's sector for sector-scoped roles so they
    // cannot probe for contacts in other sectors via phone number.
    const phoneConditions = isGlobalRole(userRole)
      ? and(eq(crmContactsTable.isArchived, false), eq(crmContactsTable.phone, normalizedPhone))
      : and(eq(crmContactsTable.isArchived, false), eq(crmContactsTable.phone, normalizedPhone), eq(crmContactsTable.sectorId, effectiveSectorId!));
    const rows = await db.select().from(crmContactsTable).where(phoneConditions);
    existing = rows[0];
  }
  if (existing) {
    // Sector gate: deny if caller cannot access the matched contact's sector.
    if (!callerCanAccessSector(req.session, existing.sectorId)) {
      res.status(403).json({ error: "Acesso negado" }); return;
    }
    res.json({ ...await enrichContact(existing), created: false }); return;
  }
  const [created] = await db.insert(crmContactsTable).values({
    name, contact: contact ?? phone, phone: normalizedPhone || null,
    sectorId: effectiveSectorId, status: "potential", profile: "Novo",
  }).returning();
  res.status(201).json({ ...await enrichContact(created), created: true });
});

// Delete purchase (before /crm/:id)
router.delete("/crm/purchases/:purchaseId", requireAuth, async (req, res): Promise<void> => {
  const purchaseId = parseInt(String(req.params.purchaseId), 10);
  if (isNaN(purchaseId)) { res.status(400).json({ error: "ID inválido" }); return; }
  const [p] = await db.select().from(crmPurchasesTable).where(eq(crmPurchasesTable.id, purchaseId));
  if (!p) { res.status(404).json({ error: "Compra não encontrada" }); return; }
  // Verify caller can access the owning contact's sector before deleting.
  const [contact] = await db.select().from(crmContactsTable).where(eq(crmContactsTable.id, p.contactId));
  if (!contact || !callerCanAccessSector(req.session, contact.sectorId)) {
    res.status(403).json({ error: "Acesso negado" }); return;
  }
  await db.delete(crmPurchasesTable).where(eq(crmPurchasesTable.id, purchaseId));
  const all = await db.select().from(crmPurchasesTable).where(eq(crmPurchasesTable.contactId, p.contactId));
  const total = all.reduce((s, p2) => s + parseFloat(String(p2.amount ?? "0")), 0);
  await db.update(crmContactsTable).set({ totalPurchases: String(total), updatedAt: new Date() }).where(eq(crmContactsTable.id, p.contactId));
  res.json({ ok: true });
});

// Delete note (before /crm/:id)
router.delete("/crm/notes/:noteId", requireAuth, async (req, res): Promise<void> => {
  const noteId = parseInt(String(req.params.noteId), 10);
  if (isNaN(noteId)) { res.status(400).json({ error: "ID inválido" }); return; }
  const [note] = await db.select().from(crmInternalNotesTable).where(eq(crmInternalNotesTable.id, noteId));
  if (!note) { res.status(404).json({ error: "Nota não encontrada" }); return; }
  // Verify caller can access the owning contact's sector before deleting.
  const [contact] = await db.select().from(crmContactsTable).where(eq(crmContactsTable.id, note.contactId));
  if (!contact || !callerCanAccessSector(req.session, contact.sectorId)) {
    res.status(403).json({ error: "Acesso negado" }); return;
  }
  await db.delete(crmInternalNotesTable).where(eq(crmInternalNotesTable.id, noteId));
  res.json({ ok: true });
});

// ─── Custom field definitions (before /crm/:id) ───────────────────────────
// List all field definitions. Authenticated users can read; only admins and
// supervisors can create/update/delete the definitions.
router.get("/crm/custom-fields", requireAuth, async (_req, res): Promise<void> => {
  const fields = await db
    .select()
    .from(crmCustomFieldsTable)
    .orderBy(asc(crmCustomFieldsTable.sortOrder), asc(crmCustomFieldsTable.id));
  res.json(fields);
});

router.post("/crm/custom-fields", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const { name, type, options, sortOrder } = req.body as {
    name?: string; type?: string; options?: string; sortOrder?: number;
  };
  if (!name || !name.trim()) { res.status(400).json({ error: "Nome do campo é obrigatório" }); return; }
  const allowed = ["text", "number", "date", "select", "textarea"];
  const fieldType = allowed.includes(type ?? "") ? type! : "text";
  const [created] = await db.insert(crmCustomFieldsTable).values({
    name: name.trim(),
    type: fieldType,
    options: fieldType === "select" ? (options ?? null) : null,
    sortOrder: sortOrder ?? 0,
  }).returning();
  res.status(201).json(created);
});

router.patch("/crm/custom-fields/:fieldId", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const fieldId = parseInt(String(req.params.fieldId), 10);
  if (isNaN(fieldId)) { res.status(400).json({ error: "ID inválido" }); return; }
  const [existing] = await db.select().from(crmCustomFieldsTable).where(eq(crmCustomFieldsTable.id, fieldId));
  if (!existing) { res.status(404).json({ error: "Campo não encontrado" }); return; }
  const { name, type, options, sortOrder, isActive } = req.body as {
    name?: string; type?: string; options?: string; sortOrder?: number; isActive?: boolean;
  };
  const allowed = ["text", "number", "date", "select", "textarea"];
  const update: Record<string, unknown> = {};
  if (name !== undefined) update.name = name.trim();
  if (type !== undefined && allowed.includes(type)) update.type = type;
  if (options !== undefined) update.options = options || null;
  if (sortOrder !== undefined) update.sortOrder = sortOrder;
  if (isActive !== undefined) update.isActive = isActive;
  const [updated] = await db.update(crmCustomFieldsTable).set(update).where(eq(crmCustomFieldsTable.id, fieldId)).returning();
  res.json(updated);
});

router.delete("/crm/custom-fields/:fieldId", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const fieldId = parseInt(String(req.params.fieldId), 10);
  if (isNaN(fieldId)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.delete(crmCustomFieldsTable).where(eq(crmCustomFieldsTable.id, fieldId));
  res.json({ ok: true });
});

// ─── List contacts ─────────────────────────────────────────────────────────
router.get("/crm", requireAuth, async (req, res): Promise<void> => {
  const userRole = req.session.userRole!;
  const userSectorId = req.session.userSectorId ?? null;
  const { profile, status, search } = req.query as Record<string, string | undefined>;

  const allContacts = await db
    .select()
    .from(crmContactsTable)
    .where(eq(crmContactsTable.isArchived, false))
    .orderBy(desc(crmContactsTable.updatedAt));

  let contacts = isGlobalRole(userRole)
    ? allContacts
    : allContacts.filter((c) => c.sectorId === userSectorId);

  if (profile) contacts = contacts.filter((c) => c.profile === profile);
  if (status) contacts = contacts.filter((c) => c.status === status);
  if (search) {
    const q = search.toLowerCase();
    contacts = contacts.filter((c) =>
      c.name.toLowerCase().includes(q) ||
      (c.contact ?? "").toLowerCase().includes(q) ||
      (c.phone ?? "").includes(q) ||
      (c.email ?? "").toLowerCase().includes(q)
    );
  }

  const sectors = await db.select().from(sectorsTable);
  const users = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable);
  const sectorMap = Object.fromEntries(sectors.map((s) => [s.id, s]));
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

  res.json(contacts.map((c) => ({
    ...c,
    sector: c.sectorId ? (sectorMap[c.sectorId] ?? null) : null,
    attendant: c.attendantId ? (userMap[c.attendantId] ?? null) : null,
  })));
});

// ─── Create contact ────────────────────────────────────────────────────────
router.post("/crm", requireAuth, async (req, res): Promise<void> => {
  const { name, contact, phone, email, sectorId, attendantId, status, profile, notes, tags, customFields } = req.body as {
    name?: string; contact?: string; phone?: string; email?: string;
    sectorId?: number; attendantId?: number; status?: string; profile?: string; notes?: string; tags?: string;
    customFields?: Record<string, string>;
  };
  if (!name) { res.status(400).json({ error: "Nome é obrigatório" }); return; }
  const userRole = req.session.userRole!;
  const userSectorId = req.session.userSectorId ?? null;
  // Sector-scoped roles are pinned to their own sector; the caller-supplied sectorId is ignored.
  const effectiveSectorId = isGlobalRole(userRole) ? (sectorId ?? null) : userSectorId;
  const [created] = await db.insert(crmContactsTable).values({
    name, contact, phone, email,
    sectorId: effectiveSectorId,
    attendantId: attendantId ?? null,
    status: status ?? "potential",
    profile: profile ?? "Novo",
    notes, tags,
    customFields: sanitizeCustomFields(customFields),
  }).returning();
  res.status(201).json(await enrichContact(created));
});

// ─── Get single contact (full detail) ─────────────────────────────────────
router.get("/crm/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const c = await loadContactWithAccess(id, req.session, res);
  if (!c) return;
  res.json(await enrichContact(c));
});

// ─── Update contact ────────────────────────────────────────────────────────
router.patch("/crm/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const existing = await loadContactWithAccess(id, req.session, res);
  if (!existing) return;
  const userRole = req.session.userRole!;
  const { name, contact, phone, email, sectorId, attendantId, status, profile, notes, tags, customFields, isArchived } = req.body as {
    name?: string; contact?: string; phone?: string; email?: string; sectorId?: number;
    attendantId?: number; status?: string; profile?: string; notes?: string; tags?: string;
    customFields?: Record<string, string>; isArchived?: boolean;
  };
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (name !== undefined) update.name = name;
  if (contact !== undefined) update.contact = contact;
  if (phone !== undefined) update.phone = phone;
  if (email !== undefined) update.email = email;
  // Only admins may reassign a contact to a different sector.
  if (sectorId !== undefined && userRole === "admin") update.sectorId = sectorId;
  if (attendantId !== undefined) update.attendantId = attendantId;
  if (status !== undefined) update.status = status;
  if (profile !== undefined) update.profile = profile;
  if (notes !== undefined) update.notes = notes;
  if (tags !== undefined) update.tags = tags;
  if (customFields !== undefined) update.customFields = sanitizeCustomFields(customFields);
  if (isArchived !== undefined) update.isArchived = isArchived;
  const [updated] = await db.update(crmContactsTable).set(update).where(eq(crmContactsTable.id, id)).returning();
  res.json(await enrichContact(updated));
});

// ─── Delete (archive) ──────────────────────────────────────────────────────
router.delete("/crm/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const existing = await loadContactWithAccess(id, req.session, res);
  if (!existing) return;
  await db.update(crmContactsTable).set({ isArchived: true }).where(eq(crmContactsTable.id, id));
  res.json({ ok: true });
});

// ─── Purchases ─────────────────────────────────────────────────────────────
router.get("/crm/:id/purchases", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const c = await loadContactWithAccess(id, req.session, res);
  if (!c) return;
  const purchases = await db.select().from(crmPurchasesTable)
    .where(eq(crmPurchasesTable.contactId, id))
    .orderBy(desc(crmPurchasesTable.purchaseDate));
  res.json(purchases);
});

router.post("/crm/:id/purchases", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const c = await loadContactWithAccess(id, req.session, res);
  if (!c) return;
  const { description, amount, purchaseDate, category, notes } = req.body as {
    description?: string; amount?: string | number; purchaseDate?: string; category?: string; notes?: string;
  };
  if (!description) { res.status(400).json({ error: "Descrição é obrigatória" }); return; }
  const [purchase] = await db.insert(crmPurchasesTable).values({
    contactId: id, description,
    amount: String(amount ?? "0"),
    purchaseDate: purchaseDate ? new Date(purchaseDate) : new Date(),
    category, notes,
  }).returning();
  // Recalc total and auto-upgrade profile
  const all = await db.select().from(crmPurchasesTable).where(eq(crmPurchasesTable.contactId, id));
  const total = all.reduce((s, p) => s + parseFloat(String(p.amount ?? "0")), 0);
  const profileUpdate: Record<string, unknown> = { totalPurchases: String(total), updatedAt: new Date() };
  if (total >= 5000) profileUpdate.profile = "VIP";
  else if (total >= 1000) profileUpdate.profile = "Regular";
  await db.update(crmContactsTable).set(profileUpdate).where(eq(crmContactsTable.id, id));
  res.status(201).json(purchase);
});

// ─── Internal Notes ────────────────────────────────────────────────────────
router.get("/crm/:id/notes", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const c = await loadContactWithAccess(id, req.session, res);
  if (!c) return;
  const notes = await db.select().from(crmInternalNotesTable)
    .where(eq(crmInternalNotesTable.contactId, id))
    .orderBy(desc(crmInternalNotesTable.createdAt));
  res.json(notes);
});

router.post("/crm/:id/notes", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const c = await loadContactWithAccess(id, req.session, res);
  if (!c) return;
  const { content } = req.body as { content?: string };
  if (!content) { res.status(400).json({ error: "Conteúdo é obrigatório" }); return; }
  const [note] = await db.insert(crmInternalNotesTable).values({
    contactId: id, content,
    authorId: req.session.userId ?? null,
    authorName: req.session.userName ?? "Desconhecido",
  }).returning();
  await db.update(crmContactsTable).set({ updatedAt: new Date() }).where(eq(crmContactsTable.id, id));
  res.status(201).json(note);
});

// ─── Service History ───────────────────────────────────────────────────────
router.get("/crm/:id/service-history", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const contact = await loadContactWithAccess(id, req.session, res);
  if (!contact) return;
  const phone = contact.phone ?? contact.contact ?? "";
  const userRole = req.session.userRole!;
  const userSectorId = req.session.userSectorId ?? null;

  // Build identity match: logs that belong to this customer by phone or name.
  const identityMatch = phone
    ? or(ilike(attendanceLogsTable.clientContact, `%${phone.slice(-8)}%`), ilike(attendanceLogsTable.clientName, `%${contact.name}%`))
    : ilike(attendanceLogsTable.clientName, `%${contact.name}%`);

  // Non-admins must only see logs from their own sector.
  const whereClause = (userRole !== "admin" && userSectorId !== null)
    ? and(identityMatch, eq(attendanceLogsTable.sectorId, userSectorId))
    : identityMatch;

  const logs = await db.select().from(attendanceLogsTable)
    .where(whereClause)
    .orderBy(desc(attendanceLogsTable.createdAt))
    .limit(50);
  res.json(logs);
});

export default router;
