import { Router, type IRouter } from "express";
import { db, queueEntriesTable, usersTable, sectorsTable, attendanceLogsTable } from "@workspace/db";
import { eq, and, asc, sql, desc } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/queue", requireAuth, async (req, res): Promise<void> => {
  const sectorIdParam = req.query.sectorId;
  const statusParam = req.query.status as string | undefined;

  let query = db.select().from(queueEntriesTable).orderBy(asc(queueEntriesTable.position), asc(queueEntriesTable.createdAt));

  const conditions = [];

  if (sectorIdParam) {
    const sectorId = parseInt(String(sectorIdParam), 10);
    if (!isNaN(sectorId)) {
      conditions.push(eq(queueEntriesTable.sectorId, sectorId));
    }
  }

  if (statusParam) {
    const statuses = statusParam.split(",");
    if (statuses.length === 1) {
      conditions.push(eq(queueEntriesTable.status, statuses[0]!));
    }
  } else {
    conditions.push(
      sql`${queueEntriesTable.status} IN ('waiting', 'in_progress')`
    );
  }

  const entries = conditions.length
    ? await db
        .select()
        .from(queueEntriesTable)
        .where(and(...conditions))
        .orderBy(asc(queueEntriesTable.position), asc(queueEntriesTable.createdAt))
    : await db
        .select()
        .from(queueEntriesTable)
        .where(sql`${queueEntriesTable.status} IN ('waiting', 'in_progress')`)
        .orderBy(asc(queueEntriesTable.position), asc(queueEntriesTable.createdAt));

  res.json(entries);
});

router.post("/queue", requireAuth, async (req, res): Promise<void> => {
  const { clientName, clientContact, sectorId, channel, notes } = req.body as {
    clientName?: string;
    clientContact?: string;
    sectorId?: number;
    channel?: string;
    notes?: string;
  };

  if (!clientName || !sectorId) {
    res.status(400).json({ error: "Nome do cliente e setor são obrigatórios" });
    return;
  }

  const [lastInQueue] = await db
    .select({ position: queueEntriesTable.position })
    .from(queueEntriesTable)
    .where(and(eq(queueEntriesTable.sectorId, sectorId), sql`${queueEntriesTable.status} IN ('waiting', 'in_progress')`))
    .orderBy(desc(queueEntriesTable.position))
    .limit(1);

  const nextPosition = (lastInQueue?.position ?? 0) + 1;

  const [entry] = await db
    .insert(queueEntriesTable)
    .values({
      clientName,
      clientContact,
      sectorId,
      channel: channel ?? "manual",
      status: "waiting",
      notes,
      position: nextPosition,
    })
    .returning();

  res.status(201).json(entry);
});

router.patch("/queue/:id/call", requireAuth, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  const [entry] = await db
    .update(queueEntriesTable)
    .set({ status: "in_progress", attendantId: req.session.userId, calledAt: new Date() })
    .where(and(eq(queueEntriesTable.id, id), eq(queueEntriesTable.status, "waiting")))
    .returning();

  if (!entry) { res.status(404).json({ error: "Entrada não encontrada ou já em atendimento" }); return; }
  res.json(entry);
});

router.patch("/queue/:id/start", requireAuth, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  const [entry] = await db
    .update(queueEntriesTable)
    .set({ startedAt: new Date() })
    .where(eq(queueEntriesTable.id, id))
    .returning();

  if (!entry) { res.status(404).json({ error: "Entrada não encontrada" }); return; }
  res.json(entry);
});

router.patch("/queue/:id/complete", requireAuth, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  const [entry] = await db
    .update(queueEntriesTable)
    .set({ status: "completed", completedAt: new Date() })
    .where(eq(queueEntriesTable.id, id))
    .returning();

  if (!entry) { res.status(404).json({ error: "Entrada não encontrada" }); return; }

  // Create attendance log
  const [attendant] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  const [sector] = await db.select().from(sectorsTable).where(eq(sectorsTable.id, entry.sectorId));

  const now = new Date();
  const waitSeconds = entry.calledAt
    ? Math.round((entry.calledAt.getTime() - entry.createdAt.getTime()) / 1000)
    : null;
  const serviceSeconds = entry.calledAt
    ? Math.round((now.getTime() - entry.calledAt.getTime()) / 1000)
    : null;

  await db.insert(attendanceLogsTable).values({
    queueEntryId: entry.id,
    clientName: entry.clientName,
    clientContact: entry.clientContact,
    sectorId: entry.sectorId,
    sectorName: sector?.name ?? "Desconhecido",
    attendantId: entry.attendantId,
    attendantName: attendant?.name ?? null,
    channel: entry.channel,
    outcome: "completed",
    notes: entry.notes,
    waitTimeSeconds: waitSeconds,
    serviceTimeSeconds: serviceSeconds,
  });

  res.json(entry);
});

router.patch("/queue/:id/transfer", requireAuth, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  const { targetSectorId } = req.body as { targetSectorId?: number };
  if (!targetSectorId) { res.status(400).json({ error: "Setor de destino é obrigatório" }); return; }

  const [existingEntry] = await db.select().from(queueEntriesTable).where(eq(queueEntriesTable.id, id));
  if (!existingEntry) { res.status(404).json({ error: "Entrada não encontrada" }); return; }

  const [lastInTarget] = await db
    .select({ position: queueEntriesTable.position })
    .from(queueEntriesTable)
    .where(and(eq(queueEntriesTable.sectorId, targetSectorId), sql`${queueEntriesTable.status} IN ('waiting', 'in_progress')`))
    .orderBy(desc(queueEntriesTable.position))
    .limit(1);

  const nextPosition = (lastInTarget?.position ?? 0) + 1;

  const [entry] = await db
    .update(queueEntriesTable)
    .set({ sectorId: targetSectorId, status: "waiting", attendantId: null, position: nextPosition, calledAt: null })
    .where(eq(queueEntriesTable.id, id))
    .returning();

  const [sector] = await db.select().from(sectorsTable).where(eq(sectorsTable.id, existingEntry.sectorId));
  const [attendant] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));

  await db.insert(attendanceLogsTable).values({
    queueEntryId: existingEntry.id,
    clientName: existingEntry.clientName,
    clientContact: existingEntry.clientContact,
    sectorId: existingEntry.sectorId,
    sectorName: sector?.name ?? "Desconhecido",
    attendantId: existingEntry.attendantId,
    attendantName: attendant?.name ?? null,
    channel: existingEntry.channel,
    outcome: "transferred",
    notes: existingEntry.notes,
  });

  res.json(entry);
});

router.delete("/queue/:id", requireAuth, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  await db.update(queueEntriesTable).set({ status: "completed", completedAt: new Date() }).where(eq(queueEntriesTable.id, id));
  res.json({ ok: true });
});

export default router;
