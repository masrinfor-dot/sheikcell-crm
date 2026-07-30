import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { db, usersTable, sectorsTable, attendanceLogsTable, conversationsTable, tasksTable, scheduledMessagesTable, crmContactsTable, crmInternalNotesTable } from "@workspace/db";
import { eq, sql, desc, and, gte, isNull, isNotNull, notInArray, or, ilike } from "drizzle-orm";
import { requireAdmin, requireAdminOrSupervisor } from "../middlewares/auth";
import { sanitizePermissions } from "../lib/permissions";
import { syncCrmAttendant } from "../lib/crmSync";

const router: IRouter = Router();

// Dashboard summary
router.get("/admin/summary", requireAdminOrSupervisor, async (_req, res): Promise<void> => {
  const sectors = await db.select().from(sectorsTable).where(eq(sectorsTable.isActive, true));

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  // A Visão Geral espelha a Central de Atendimento (tabela conversations):
  // "aguardando"  = conversas sem responsável ainda abertas (potenciais + pendentes);
  // "em atendimento" = conversas com responsável e não finalizadas;
  // "finalizados hoje" segue vindo do histórico (attendance_logs).
  const notFinished = and(
    eq(conversationsTable.isArchived, false),
    notInArray(conversationsTable.status, ["resolved", "archived"]),
  )!;

  const summary = await Promise.all(
    sectors.map(async (sector) => {
      const [waiting] = await db
        .select({ count: sql<number>`count(*)` })
        .from(conversationsTable)
        .where(and(eq(conversationsTable.sectorId, sector.id), isNull(conversationsTable.assigneeId), notFinished));

      const [inProgress] = await db
        .select({ count: sql<number>`count(*)` })
        .from(conversationsTable)
        .where(and(eq(conversationsTable.sectorId, sector.id), isNotNull(conversationsTable.assigneeId), notFinished));

      const [completedToday] = await db
        .select({ count: sql<number>`count(*)` })
        .from(attendanceLogsTable)
        .where(and(eq(attendanceLogsTable.sectorId, sector.id), gte(attendanceLogsTable.createdAt, startOfDay)));

      // Attendants assigned to this sector (active users)
      const [activeAttendants] = await db
        .select({ count: sql<number>`count(*)` })
        .from(usersTable)
        .where(and(eq(usersTable.sectorId, sector.id), eq(usersTable.isActive, true)));

      // Vendedores atualmente atendendo (responsáveis por conversa em andamento)
      const busyAttendants = await db
        .selectDistinct({ attendantId: conversationsTable.assigneeId })
        .from(conversationsTable)
        .where(and(eq(conversationsTable.sectorId, sector.id), isNotNull(conversationsTable.assigneeId), notFinished));

      return {
        sector,
        waiting: Number(waiting?.count ?? 0),
        inProgress: Number(inProgress?.count ?? 0),
        completedToday: Number(completedToday?.count ?? 0),
        totalAttendants: Number(activeAttendants?.count ?? 0),
        busyAttendants: busyAttendants.filter((a) => a.attendantId !== null).length,
      };
    })
  );

  res.json(summary);
});

// Recent attendance logs
router.get("/admin/logs", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 500);
  const sectorId = req.query.sectorId ? parseInt(String(req.query.sectorId), 10) : null;
  const attendantId = req.query.attendantId ? parseInt(String(req.query.attendantId), 10) : null;
  const days = req.query.days ? parseInt(String(req.query.days), 10) : null;
  const outcome = req.query.outcome ? String(req.query.outcome) : null;
  const reason = req.query.reason ? String(req.query.reason) : null;
  const search = req.query.search ? String(req.query.search).trim() : null;

  const conds = [];
  if (sectorId) conds.push(eq(attendanceLogsTable.sectorId, sectorId));
  if (attendantId) conds.push(eq(attendanceLogsTable.attendantId, attendantId));
  if (days && days > 0) conds.push(gte(attendanceLogsTable.createdAt, new Date(Date.now() - days * 86400000)));
  if (outcome) conds.push(eq(attendanceLogsTable.outcome, outcome));
  if (reason) conds.push(eq(attendanceLogsTable.resolutionReason, reason));
  if (search) {
    conds.push(or(
      ilike(attendanceLogsTable.clientName, `%${search}%`),
      ilike(attendanceLogsTable.clientContact, `%${search}%`),
    )!);
  }

  const logs = await db
    .select()
    .from(attendanceLogsTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(attendanceLogsTable.createdAt))
    .limit(limit);

  res.json(logs);
});

// Users management
router.get("/admin/users", requireAdmin, async (_req, res): Promise<void> => {
  const users = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: usersTable.role,
      sectorId: usersTable.sectorId,
      storeName: usersTable.storeName,
      adminAccess: usersTable.adminAccess,
      isActive: usersTable.isActive,
      permissions: usersTable.permissions,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .orderBy(usersTable.name);

  // Get sectors for each user
  const sectors = await db.select().from(sectorsTable);
  const sectorMap = Object.fromEntries(sectors.map((s) => [s.id, s]));

  const usersWithSector = users.map((u) => ({
    ...u,
    sector: u.sectorId ? (sectorMap[u.sectorId] ?? null) : null,
  }));

  res.json(usersWithSector);
});

// Funções de admin que podem ser liberadas para não-admins
const GRANTABLE_FEATURES = ["financeiro", "sorteios", "robo", "rh", "questionarios", "whatsapp"];

function sanitizeAdminAccess(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.map((x) => String(x)).filter((x) => GRANTABLE_FEATURES.includes(x));
  return out.length ? [...new Set(out)] : null;
}

router.post("/admin/users", requireAdmin, async (req, res): Promise<void> => {
  const { name, email, password, role, sectorId, storeName, adminAccess } = req.body as {
    name?: string;
    email?: string;
    password?: string;
    role?: string;
    sectorId?: number;
    storeName?: string;
    adminAccess?: unknown;
  };

  if (!name || !email || !password) {
    res.status(400).json({ error: "Nome, email e senha são obrigatórios" });
    return;
  }

  const resolvedRole = role ?? "vendedor";

  // Vendedores must be assigned to a real sector
  if (resolvedRole === "vendedor" && !sectorId) {
    res.status(400).json({ error: "Vendedor precisa de um setor atribuído" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const [user] = await db
    .insert(usersTable)
    .values({
      name, email: email.toLowerCase(), passwordHash, role: resolvedRole,
      sectorId: sectorId ?? undefined,
      storeName: typeof storeName === "string" && storeName.trim() ? storeName.trim().slice(0, 120) : null,
      mustChangePassword: true, // primeiro acesso: obriga trocar a senha
      adminAccess: sanitizeAdminAccess(adminAccess),
    })
    .returning();

  const { passwordHash: _ph, ...safeUser } = user;
  res.status(201).json(safeUser);
});

router.patch("/admin/users/:id", requireAdmin, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  const { name, email, password, role, sectorId, isActive, permissions, storeName, adminAccess } = req.body as {
    adminAccess?: unknown;
    name?: string;
    email?: string;
    password?: string;
    role?: string;
    sectorId?: number;
    isActive?: boolean;
    permissions?: unknown;
    storeName?: string | null;
  };

  const updateData: Record<string, unknown> = {};
  if (name) updateData.name = name;
  if (email) updateData.email = email.toLowerCase();
  if (role) updateData.role = role;
  if (sectorId !== undefined) updateData.sectorId = sectorId;
  if (adminAccess !== undefined) updateData.adminAccess = sanitizeAdminAccess(adminAccess);
  if (storeName !== undefined) {
    updateData.storeName = typeof storeName === "string" && storeName.trim() ? storeName.trim().slice(0, 120) : null;
  }
  if (isActive !== undefined) updateData.isActive = isActive;
  if (permissions !== undefined) updateData.permissions = sanitizePermissions(permissions);
  if (password) {
    updateData.passwordHash = await bcrypt.hash(password, 10);
    // Senha resetada pelo admin (recuperação): usuário troca no próximo login
    updateData.mustChangePassword = true;
  }

  const [user] = await db.update(usersTable).set(updateData).where(eq(usersTable.id, id)).returning();
  if (!user) { res.status(404).json({ error: "Usuário não encontrado" }); return; }

  // Usuário desativado perde as sessões ativas na hora (não só no próximo login).
  if (isActive === false) {
    await db.execute(sql`DELETE FROM "session" WHERE (sess::json->>'userId')::int = ${id}`);
  }

  const { passwordHash: _ph, ...safeUser } = user;
  res.json(safeUser);
});

// ─── Excluir usuário (transferindo os atendimentos dele) ────────────────────
// transferToId: para quem vão as conversas/tarefas/clientes do usuário excluído.
// Sem transferToId, as conversas em andamento voltam para a fila (sem responsável)
// e as demais referências ficam "sem responsável".
router.delete("/admin/users/:id", requireAdmin, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  if (id === req.session.userId) { res.status(400).json({ error: "Você não pode excluir a si mesmo" }); return; }

  const { transferToId: rawTransfer } = req.body as { transferToId?: number | null };
  const transferToId = rawTransfer != null ? Number(rawTransfer) : null;
  if (transferToId != null && (Number.isNaN(transferToId) || transferToId === id)) {
    res.status(400).json({ error: "Destinatário da transferência inválido" });
    return;
  }

  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
  if (!target) { res.status(404).json({ error: "Usuário não encontrado" }); return; }

  if (transferToId != null) {
    const [dest] = await db.select({ id: usersTable.id, isActive: usersTable.isActive })
      .from(usersTable).where(eq(usersTable.id, transferToId)).limit(1);
    if (!dest || !dest.isActive) { res.status(400).json({ error: "Usuário de destino não encontrado ou inativo" }); return; }
  }

  // Conversas do usuário (para sincronizar CRM/registro após a transação).
  const ownedConvs = await db.select().from(conversationsTable).where(eq(conversationsTable.assigneeId, id));

  await db.transaction(async (tx) => {
    if (transferToId != null) {
      // Transfere todas as conversas para o novo responsável.
      await tx.update(conversationsTable)
        .set({ assigneeId: transferToId, updatedAt: new Date() })
        .where(eq(conversationsTable.assigneeId, id));
    } else {
      // Sem destino: atendimentos em andamento voltam para a fila do setor.
      await tx.update(conversationsTable)
        .set({ assigneeId: null, status: "open", attendanceStartedAt: null, updatedAt: new Date() })
        .where(and(eq(conversationsTable.assigneeId, id), notInArray(conversationsTable.status, ["resolved", "archived"])));
      await tx.update(conversationsTable)
        .set({ assigneeId: null, updatedAt: new Date() })
        .where(eq(conversationsTable.assigneeId, id));
    }
    // Tarefas, agendamentos, clientes do CRM e anotações.
    await tx.update(tasksTable).set({ assigneeId: transferToId }).where(eq(tasksTable.assigneeId, id));
    await tx.update(tasksTable).set({ createdById: transferToId }).where(eq(tasksTable.createdById, id));
    await tx.update(scheduledMessagesTable).set({ createdById: transferToId }).where(eq(scheduledMessagesTable.createdById, id));
    await tx.update(crmContactsTable).set({ attendantId: transferToId, updatedAt: new Date() }).where(eq(crmContactsTable.attendantId, id));
    await tx.update(crmInternalNotesTable).set({ authorId: transferToId }).where(eq(crmInternalNotesTable.authorId, id));
    // Chat interno e participações são removidos em cascata pelo banco.
    await tx.delete(usersTable).where(eq(usersTable.id, id));
    // Derruba as sessões ativas do usuário excluído: sem isso, o cookie dele
    // continuaria autorizando requisições até expirar.
    await tx.execute(sql`DELETE FROM "session" WHERE (sess::json->>'userId')::int = ${id}`);
  });

  // Espelha a transferência no quadro CRM (best-effort, fora da transação).
  for (const conv of ownedConvs) {
    await syncCrmAttendant({
      phone: conv.phone,
      sectorId: conv.sectorId,
      assigneeId: transferToId,
      status: transferToId == null && conv.status !== "resolved" && conv.status !== "archived" ? "open" : conv.status,
      isArchived: conv.isArchived,
    });
  }

  res.json({ ok: true, transferredConversations: ownedConvs.length });
});

export default router;
