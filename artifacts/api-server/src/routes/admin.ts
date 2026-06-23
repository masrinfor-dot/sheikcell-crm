import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { db, usersTable, queueEntriesTable, sectorsTable, attendanceLogsTable } from "@workspace/db";
import { eq, sql, desc, and, gte } from "drizzle-orm";
import { requireAdmin, requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

// Dashboard summary
router.get("/admin/summary", requireAdmin, async (_req, res): Promise<void> => {
  const sectors = await db.select().from(sectorsTable).where(eq(sectorsTable.isActive, true));

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const summary = await Promise.all(
    sectors.map(async (sector) => {
      const [waiting] = await db
        .select({ count: sql<number>`count(*)` })
        .from(queueEntriesTable)
        .where(and(eq(queueEntriesTable.sectorId, sector.id), eq(queueEntriesTable.status, "waiting")));

      const [inProgress] = await db
        .select({ count: sql<number>`count(*)` })
        .from(queueEntriesTable)
        .where(and(eq(queueEntriesTable.sectorId, sector.id), eq(queueEntriesTable.status, "in_progress")));

      const [completedToday] = await db
        .select({ count: sql<number>`count(*)` })
        .from(attendanceLogsTable)
        .where(and(eq(attendanceLogsTable.sectorId, sector.id), gte(attendanceLogsTable.createdAt, startOfDay)));

      // Attendants assigned to this sector (active users)
      const [activeAttendants] = await db
        .select({ count: sql<number>`count(*)` })
        .from(usersTable)
        .where(and(eq(usersTable.sectorId, sector.id), eq(usersTable.isActive, true)));

      // Attendants currently serving a client (have an in_progress entry assigned to them)
      const busyAttendants = await db
        .selectDistinct({ attendantId: queueEntriesTable.attendantId })
        .from(queueEntriesTable)
        .where(and(eq(queueEntriesTable.sectorId, sector.id), eq(queueEntriesTable.status, "in_progress")));

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
router.get("/admin/logs", requireAdmin, async (req, res): Promise<void> => {
  const limit = parseInt(String(req.query.limit ?? "50"), 10);
  const sectorId = req.query.sectorId ? parseInt(String(req.query.sectorId), 10) : null;

  const logs = sectorId
    ? await db
        .select()
        .from(attendanceLogsTable)
        .where(eq(attendanceLogsTable.sectorId, sectorId))
        .orderBy(desc(attendanceLogsTable.createdAt))
        .limit(limit)
    : await db
        .select()
        .from(attendanceLogsTable)
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
      isActive: usersTable.isActive,
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

router.post("/admin/users", requireAdmin, async (req, res): Promise<void> => {
  const { name, email, password, role, sectorId } = req.body as {
    name?: string;
    email?: string;
    password?: string;
    role?: string;
    sectorId?: number;
  };

  if (!name || !email || !password) {
    res.status(400).json({ error: "Nome, email e senha são obrigatórios" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const [user] = await db
    .insert(usersTable)
    .values({ name, email: email.toLowerCase(), passwordHash, role: role ?? "attendant", sectorId: sectorId ?? 0 })
    .returning();

  const { passwordHash: _ph, ...safeUser } = user;
  res.status(201).json(safeUser);
});

router.patch("/admin/users/:id", requireAdmin, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  const { name, email, password, role, sectorId, isActive } = req.body as {
    name?: string;
    email?: string;
    password?: string;
    role?: string;
    sectorId?: number;
    isActive?: boolean;
  };

  const updateData: Record<string, unknown> = {};
  if (name) updateData.name = name;
  if (email) updateData.email = email.toLowerCase();
  if (role) updateData.role = role;
  if (sectorId !== undefined) updateData.sectorId = sectorId;
  if (isActive !== undefined) updateData.isActive = isActive;
  if (password) updateData.passwordHash = await bcrypt.hash(password, 10);

  const [user] = await db.update(usersTable).set(updateData).where(eq(usersTable.id, id)).returning();
  if (!user) { res.status(404).json({ error: "Usuário não encontrado" }); return; }

  const { passwordHash: _ph, ...safeUser } = user;
  res.json(safeUser);
});

export default router;
