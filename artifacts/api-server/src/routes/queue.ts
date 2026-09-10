import { Router, type IRouter } from "express";
import { db, queueEntriesTable, usersTable, sectorsTable, attendanceLogsTable } from "@workspace/db";
import { eq, and, asc, sql, desc } from "drizzle-orm";
import { requireAuth, requireTenant } from "../middlewares/auth";

const router: IRouter = Router();

/** Returns true if the user has global role (admin/supervisor) OR the entry belongs to their sector */
function canActOnEntry(userRole: string, userSectorId: number | null, entrySectorId: number): boolean {
  if (userRole === "admin" || userRole === "supervisor") return true;
  return userSectorId === entrySectorId;
}

/** Quem pode direcionar uma entrada da fila pra um vendedor específico
 * (pedido 10/09): admin, supervisor, ou o novo papel vendedor_chefe. */
function canRouteAttendances(userRole: string): boolean {
  return userRole === "admin" || userRole === "supervisor" || userRole === "vendedor_chefe";
}

router.get("/queue", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const sectorIdParam = req.query.sectorId;
  const statusParam = req.query.status as string | undefined;

  const userRole = req.session.userRole!;
  const userSectorId = req.session.userSectorId ?? null;

  // Vendedor com fila restrita (pedido 10/09): só vê o que foi direcionado
  // especificamente pra ele — nunca o pool geral do setor. Ver coluna
  // queueRestrictToAssigned em users.
  const [me] = await db.select({ queueRestrictToAssigned: usersTable.queueRestrictToAssigned })
    .from(usersTable).where(eq(usersTable.id, req.session.userId!)).limit(1);
  const isRestricted = !!me?.queueRestrictToAssigned;

  // Attendants can only query their own sector; admins can query any sector
  let effectiveSectorId: number | null = null;
  if (sectorIdParam) {
    const parsed = parseInt(String(sectorIdParam), 10);
    if (isNaN(parsed)) {
      res.status(400).json({ error: "sectorId inválido" });
      return;
    }
    if (userRole !== "admin" && userRole !== "supervisor" && parsed !== userSectorId && !isRestricted) {
      res.status(403).json({ error: "Acesso negado a este setor" });
      return;
    }
    effectiveSectorId = isRestricted ? null : parsed;
  } else if (userRole === "admin" || userRole === "supervisor") {
    // Admins and supervisors can see all sectors when no sectorId param given
    effectiveSectorId = null;
  } else if (isRestricted) {
    // Fila restrita: ignora setor, o filtro real é por targetUserId abaixo.
    effectiveSectorId = null;
  } else {
    // Non-admin/supervisor users must have a valid sector assignment
    if (!userSectorId) {
      res.status(403).json({ error: "Conta sem setor atribuído válido" });
      return;
    }
    effectiveSectorId = userSectorId;
  }

  // Fila sempre restrita à loja (tenant) do usuário.
  const conditions = [eq(queueEntriesTable.tenantId, tenantId)];

  if (effectiveSectorId !== null) {
    conditions.push(eq(queueEntriesTable.sectorId, effectiveSectorId));
  }

  if (isRestricted) {
    conditions.push(eq(queueEntriesTable.targetUserId, req.session.userId!));
  }

  if (statusParam) {
    const statuses = statusParam.split(",");
    if (statuses.length === 1) {
      conditions.push(eq(queueEntriesTable.status, statuses[0]!));
    }
  } else {
    conditions.push(sql`${queueEntriesTable.status} IN ('waiting', 'in_progress')`);
  }

  let entries = await db
    .select()
    .from(queueEntriesTable)
    .where(and(...conditions))
    .orderBy(asc(queueEntriesTable.position), asc(queueEntriesTable.createdAt));

  // Fila restrita + em ordem, um por vez: se já tem uma "in_progress" com
  // este vendedor, só ela aparece (foco total); senão, só a próxima
  // "waiting" na ordem de fila — o resto fica escondido até essa ser
  // concluída, mesmo que já tenha sido direcionado.
  if (isRestricted) {
    const active = entries.find((e) => e.status === "in_progress" && e.attendantId === req.session.userId);
    if (active) {
      entries = [active];
    } else {
      const nextWaiting = entries.find((e) => e.status === "waiting");
      entries = nextWaiting ? [nextWaiting] : [];
    }
  }

  res.json(entries);
});

router.post("/queue", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
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

  // Attendants can only add to their own sector
  if (!canActOnEntry(req.session.userRole!, req.session.userSectorId ?? null, sectorId)) {
    res.status(403).json({ error: "Acesso negado a este setor" });
    return;
  }

  const [lastInQueue] = await db
    .select({ position: queueEntriesTable.position })
    .from(queueEntriesTable)
    .where(and(eq(queueEntriesTable.tenantId, tenantId), eq(queueEntriesTable.sectorId, sectorId), sql`${queueEntriesTable.status} IN ('waiting', 'in_progress')`))
    .orderBy(desc(queueEntriesTable.position))
    .limit(1);

  const nextPosition = (lastInQueue?.position ?? 0) + 1;

  const [entry] = await db
    .insert(queueEntriesTable)
    .values({
      tenantId,
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

// Direcionar uma entrada da fila pra um vendedor específico (pedido 10/09):
// só admin/supervisor/vendedor_chefe podem — o vendedor alvo passa a poder
// chamá-la mesmo fora do próprio setor (ver /call), e se tiver fila
// restrita, só verá esta entrada específica até concluí-la.
router.patch("/queue/:id/route", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  if (!canRouteAttendances(req.session.userRole!)) {
    res.status(403).json({ error: "Só admin, supervisor ou vendedor chefe podem direcionar atendimentos." }); return;
  }

  const { targetUserId } = req.body as { targetUserId?: number | null };

  const [existing] = await db.select().from(queueEntriesTable)
    .where(and(eq(queueEntriesTable.id, id), eq(queueEntriesTable.tenantId, tenantId)));
  if (!existing) { res.status(404).json({ error: "Entrada não encontrada" }); return; }
  if (existing.status !== "waiting") {
    res.status(400).json({ error: "Só é possível direcionar uma entrada que ainda está aguardando." }); return;
  }

  if (targetUserId != null) {
    const [target] = await db.select({ id: usersTable.id, isActive: usersTable.isActive }).from(usersTable)
      .where(and(eq(usersTable.id, targetUserId), eq(usersTable.tenantId, tenantId))).limit(1);
    if (!target || !target.isActive) { res.status(400).json({ error: "Vendedor de destino inválido" }); return; }
  }

  const [entry] = await db
    .update(queueEntriesTable)
    .set({ targetUserId: targetUserId ?? null, routedBy: targetUserId != null ? req.session.userId : null })
    .where(and(eq(queueEntriesTable.id, id), eq(queueEntriesTable.tenantId, tenantId)))
    .returning();

  res.json(entry);
});

router.patch("/queue/:id/call", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  const [existing] = await db.select().from(queueEntriesTable)
    .where(and(eq(queueEntriesTable.id, id), eq(queueEntriesTable.tenantId, tenantId)));
  if (!existing) { res.status(404).json({ error: "Entrada não encontrada" }); return; }

  const userId = req.session.userId!;
  const wasRoutedToMe = existing.targetUserId === userId;
  if (!wasRoutedToMe && !canActOnEntry(req.session.userRole!, req.session.userSectorId ?? null, existing.sectorId)) {
    res.status(403).json({ error: "Acesso negado a este setor" }); return;
  }

  // Fila restrita (pedido 10/09): só chama o que foi direcionado pra ele, e
  // nunca dois atendimentos ao mesmo tempo — precisa concluir o atual antes
  // de chamar o próximo.
  const [me] = await db.select({ queueRestrictToAssigned: usersTable.queueRestrictToAssigned })
    .from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (me?.queueRestrictToAssigned) {
    if (existing.targetUserId !== userId) {
      res.status(403).json({ error: "Este atendimento não foi direcionado a você." }); return;
    }
    const [alreadyActive] = await db.select({ id: queueEntriesTable.id }).from(queueEntriesTable)
      .where(and(eq(queueEntriesTable.tenantId, tenantId), eq(queueEntriesTable.attendantId, userId), eq(queueEntriesTable.status, "in_progress")))
      .limit(1);
    if (alreadyActive && alreadyActive.id !== id) {
      res.status(409).json({ error: "Conclua o atendimento atual antes de chamar o próximo da fila.", code: "QUEUE_SINGLE_TASK_BLOCKED" }); return;
    }
  }

  const [entry] = await db
    .update(queueEntriesTable)
    .set({ status: "in_progress", attendantId: userId, calledAt: new Date() })
    .where(and(eq(queueEntriesTable.id, id), eq(queueEntriesTable.tenantId, tenantId), eq(queueEntriesTable.status, "waiting")))
    .returning();

  if (!entry) { res.status(409).json({ error: "Entrada já em atendimento ou não encontrada" }); return; }
  res.json(entry);
});

router.patch("/queue/:id/start", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  const [existing] = await db.select().from(queueEntriesTable)
    .where(and(eq(queueEntriesTable.id, id), eq(queueEntriesTable.tenantId, tenantId)));
  if (!existing) { res.status(404).json({ error: "Entrada não encontrada" }); return; }

  const canBypassSector = existing.attendantId === req.session.userId || existing.targetUserId === req.session.userId;
  if (!canBypassSector && !canActOnEntry(req.session.userRole!, req.session.userSectorId ?? null, existing.sectorId)) {
    res.status(403).json({ error: "Acesso negado a este setor" }); return;
  }

  const [entry] = await db
    .update(queueEntriesTable)
    .set({ startedAt: new Date() })
    .where(and(eq(queueEntriesTable.id, id), eq(queueEntriesTable.tenantId, tenantId)))
    .returning();

  if (!entry) { res.status(404).json({ error: "Entrada não encontrada" }); return; }
  res.json(entry);
});

router.patch("/queue/:id/complete", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  const [existing] = await db.select().from(queueEntriesTable)
    .where(and(eq(queueEntriesTable.id, id), eq(queueEntriesTable.tenantId, tenantId)));
  if (!existing) { res.status(404).json({ error: "Entrada não encontrada" }); return; }

  const canBypassSectorComplete = existing.attendantId === req.session.userId || existing.targetUserId === req.session.userId;
  if (!canBypassSectorComplete && !canActOnEntry(req.session.userRole!, req.session.userSectorId ?? null, existing.sectorId)) {
    res.status(403).json({ error: "Acesso negado a este setor" }); return;
  }

  const [entry] = await db
    .update(queueEntriesTable)
    .set({ status: "completed", completedAt: new Date() })
    .where(and(eq(queueEntriesTable.id, id), eq(queueEntriesTable.tenantId, tenantId)))
    .returning();

  if (!entry) { res.status(404).json({ error: "Entrada não encontrada" }); return; }

  // Create attendance log (dentro da loja)
  const [attendant] = await db.select().from(usersTable)
    .where(and(eq(usersTable.id, req.session.userId!), eq(usersTable.tenantId, tenantId)));
  const [sector] = await db.select().from(sectorsTable)
    .where(and(eq(sectorsTable.id, entry.sectorId), eq(sectorsTable.tenantId, tenantId)));

  const now = new Date();
  const waitSeconds = entry.calledAt
    ? Math.round((entry.calledAt.getTime() - entry.createdAt.getTime()) / 1000)
    : null;
  const serviceSeconds = entry.calledAt
    ? Math.round((now.getTime() - entry.calledAt.getTime()) / 1000)
    : null;

  await db.insert(attendanceLogsTable).values({
    tenantId,
    queueEntryId: entry.id,
    clientName: entry.clientName,
    clientContact: entry.clientContact,
    sectorId: entry.sectorId,
    sectorName: sector?.name ?? "Desconhecido",
    attendantId: entry.attendantId,
    attendantName: attendant?.name ?? null,
    storeId: attendant?.storeId ?? null,
    channel: entry.channel,
    outcome: "completed",
    notes: entry.notes,
    waitTimeSeconds: waitSeconds,
    serviceTimeSeconds: serviceSeconds,
  });

  res.json(entry);
});

router.patch("/queue/:id/transfer", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  const { targetSectorId } = req.body as { targetSectorId?: number };
  if (!targetSectorId) { res.status(400).json({ error: "Setor de destino é obrigatório" }); return; }

  const [existingEntry] = await db.select().from(queueEntriesTable)
    .where(and(eq(queueEntriesTable.id, id), eq(queueEntriesTable.tenantId, tenantId)));
  if (!existingEntry) { res.status(404).json({ error: "Entrada não encontrada" }); return; }

  if (!canActOnEntry(req.session.userRole!, req.session.userSectorId ?? null, existingEntry.sectorId)) {
    res.status(403).json({ error: "Acesso negado a este setor" }); return;
  }

  // Setor de destino precisa pertencer à mesma loja (tenant).
  const [targetSector] = await db.select({ id: sectorsTable.id }).from(sectorsTable)
    .where(and(eq(sectorsTable.id, targetSectorId), eq(sectorsTable.tenantId, tenantId)));
  if (!targetSector) { res.status(400).json({ error: "Setor de destino inválido" }); return; }

  const [lastInTarget] = await db
    .select({ position: queueEntriesTable.position })
    .from(queueEntriesTable)
    .where(and(eq(queueEntriesTable.tenantId, tenantId), eq(queueEntriesTable.sectorId, targetSectorId), sql`${queueEntriesTable.status} IN ('waiting', 'in_progress')`))
    .orderBy(desc(queueEntriesTable.position))
    .limit(1);

  const nextPosition = (lastInTarget?.position ?? 0) + 1;

  const [entry] = await db
    .update(queueEntriesTable)
    .set({ sectorId: targetSectorId, status: "waiting", attendantId: null, position: nextPosition, calledAt: null })
    .where(and(eq(queueEntriesTable.id, id), eq(queueEntriesTable.tenantId, tenantId)))
    .returning();

  const [sector] = await db.select().from(sectorsTable)
    .where(and(eq(sectorsTable.id, existingEntry.sectorId), eq(sectorsTable.tenantId, tenantId)));
  const [attendant] = await db.select().from(usersTable)
    .where(and(eq(usersTable.id, req.session.userId!), eq(usersTable.tenantId, tenantId)));

  await db.insert(attendanceLogsTable).values({
    tenantId,
    queueEntryId: existingEntry.id,
    clientName: existingEntry.clientName,
    clientContact: existingEntry.clientContact,
    sectorId: existingEntry.sectorId,
    sectorName: sector?.name ?? "Desconhecido",
    attendantId: existingEntry.attendantId,
    attendantName: attendant?.name ?? null,
    storeId: attendant?.storeId ?? null,
    channel: existingEntry.channel,
    outcome: "transferred",
    notes: existingEntry.notes,
  });

  res.json(entry);
});

router.delete("/queue/:id", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  const [existing] = await db.select().from(queueEntriesTable)
    .where(and(eq(queueEntriesTable.id, id), eq(queueEntriesTable.tenantId, tenantId)));
  if (!existing) { res.status(404).json({ error: "Entrada não encontrada" }); return; }

  if (!canActOnEntry(req.session.userRole!, req.session.userSectorId ?? null, existing.sectorId)) {
    res.status(403).json({ error: "Acesso negado a este setor" }); return;
  }

  await db.update(queueEntriesTable).set({ status: "completed", completedAt: new Date() })
    .where(and(eq(queueEntriesTable.id, id), eq(queueEntriesTable.tenantId, tenantId)));
  res.json({ ok: true });
});

export default router;
