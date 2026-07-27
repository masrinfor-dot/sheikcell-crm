import { Router, type IRouter } from "express";
import { db, tasksTable, sectorsTable, usersTable } from "@workspace/db";
import { eq, desc, asc } from "drizzle-orm";
import { requireAuth, isGlobalRole } from "../middlewares/auth";
import { requirePerm } from "../lib/permissions";
import type { Request } from "express";

const router: IRouter = Router();

// Permissão individual "tarefas": vendedor sem ela não acessa o quadro.
router.use("/tasks", requirePerm("tarefas"));

const STATUSES = ["todo", "doing", "done"];
const PRIORITIES = ["baixa", "media", "alta"];

async function enrichTask(t: typeof tasksTable.$inferSelect) {
  const sectors = await db.select().from(sectorsTable);
  const users = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable);
  const sectorMap = Object.fromEntries(sectors.map((s) => [s.id, s]));
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));
  return {
    ...t,
    sector: t.sectorId ? (sectorMap[t.sectorId] ?? null) : null,
    assignee: t.assigneeId ? (userMap[t.assigneeId] ?? null) : null,
    createdBy: t.createdById ? (userMap[t.createdById] ?? null) : null,
  };
}

/**
 * Returns true if the caller can access a task. Admins/supervisors see all;
 * vendedores see tasks in their own sector, assigned to them, or created by them.
 */
function callerCanAccessTask(session: Request["session"], t: typeof tasksTable.$inferSelect): boolean {
  if (isGlobalRole(session.userRole)) return true;
  const uid = session.userId ?? null;
  const sid = session.userSectorId ?? null;
  // Fail closed: a null caller sector must never match null-sector tasks.
  const sameSector = sid != null && t.sectorId === sid;
  const isAssignee = uid != null && t.assigneeId === uid;
  const isCreator = uid != null && t.createdById === uid;
  return sameSector || isAssignee || isCreator;
}

async function loadTaskWithAccess(
  id: number,
  session: Request["session"],
  res: Parameters<Parameters<typeof router.get>[1]>[1],
): Promise<typeof tasksTable.$inferSelect | null> {
  const [t] = await db.select().from(tasksTable).where(eq(tasksTable.id, id));
  if (!t || t.isArchived) {
    res.status(404).json({ error: "Tarefa não encontrada" });
    return null;
  }
  if (!callerCanAccessTask(session, t)) {
    res.status(403).json({ error: "Acesso negado" });
    return null;
  }
  return t;
}

// ─── List tasks ─────────────────────────────────────────────────────────────
router.get("/tasks", requireAuth, async (req, res): Promise<void> => {
  const userRole = req.session.userRole!;

  const all = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.isArchived, false))
    .orderBy(asc(tasksTable.position), desc(tasksTable.updatedAt));

  const visible = isGlobalRole(userRole)
    ? all
    : all.filter((t) => callerCanAccessTask(req.session, t));

  const sectors = await db.select().from(sectorsTable);
  const users = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable);
  const sectorMap = Object.fromEntries(sectors.map((s) => [s.id, s]));
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

  res.json(visible.map((t) => ({
    ...t,
    sector: t.sectorId ? (sectorMap[t.sectorId] ?? null) : null,
    assignee: t.assigneeId ? (userMap[t.assigneeId] ?? null) : null,
    createdBy: t.createdById ? (userMap[t.createdById] ?? null) : null,
  })));
});

// ─── Create task ─────────────────────────────────────────────────────────────
router.post("/tasks", requireAuth, async (req, res): Promise<void> => {
  const { title, description, status, priority, assigneeId, sectorId, dueDate } = req.body as {
    title?: string; description?: string; status?: string; priority?: string;
    assigneeId?: number | null; sectorId?: number | null; dueDate?: string | null;
  };
  if (!title || !title.trim()) { res.status(400).json({ error: "Título é obrigatório" }); return; }
  const userRole = req.session.userRole!;
  const userSectorId = req.session.userSectorId ?? null;
  // Sector-scoped roles are pinned to their own sector; caller-supplied sectorId is ignored.
  const effectiveSectorId = isGlobalRole(userRole) ? (sectorId ?? null) : userSectorId;
  const [created] = await db.insert(tasksTable).values({
    title: title.trim(),
    description: description || null,
    status: STATUSES.includes(status ?? "") ? status! : "todo",
    priority: PRIORITIES.includes(priority ?? "") ? priority! : "media",
    assigneeId: assigneeId ?? null,
    createdById: req.session.userId ?? null,
    sectorId: effectiveSectorId,
    dueDate: dueDate ? new Date(dueDate) : null,
  }).returning();
  res.status(201).json(await enrichTask(created));
});

// ─── Update task ─────────────────────────────────────────────────────────────
router.patch("/tasks/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const existing = await loadTaskWithAccess(id, req.session, res);
  if (!existing) return;
  const userRole = req.session.userRole!;
  const { title, description, status, priority, assigneeId, sectorId, dueDate, position, isArchived } = req.body as {
    title?: string; description?: string; status?: string; priority?: string;
    assigneeId?: number | null; sectorId?: number | null; dueDate?: string | null;
    position?: number; isArchived?: boolean;
  };
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (title !== undefined) update.title = title.trim();
  if (description !== undefined) update.description = description || null;
  if (status !== undefined && STATUSES.includes(status)) update.status = status;
  if (priority !== undefined && PRIORITIES.includes(priority)) update.priority = priority;
  if (assigneeId !== undefined) update.assigneeId = assigneeId ?? null;
  // Only admins/supervisors may move a task to a different sector.
  if (sectorId !== undefined && isGlobalRole(userRole)) update.sectorId = sectorId ?? null;
  if (dueDate !== undefined) update.dueDate = dueDate ? new Date(dueDate) : null;
  if (position !== undefined) update.position = position;
  if (isArchived !== undefined) update.isArchived = isArchived;
  const [updated] = await db.update(tasksTable).set(update).where(eq(tasksTable.id, id)).returning();
  res.json(await enrichTask(updated));
});

// ─── Delete (archive) ────────────────────────────────────────────────────────
router.delete("/tasks/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const existing = await loadTaskWithAccess(id, req.session, res);
  if (!existing) return;
  await db.update(tasksTable).set({ isArchived: true }).where(eq(tasksTable.id, id));
  res.json({ ok: true });
});

export default router;
