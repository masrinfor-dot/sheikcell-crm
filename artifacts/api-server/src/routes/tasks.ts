import { Router, type IRouter } from "express";
import { db, tasksTable, sectorsTable, usersTable, taskCommentsTable, taskSubtasksTable } from "@workspace/db";
import { eq, and, desc, asc, inArray, sql } from "drizzle-orm";
import { requireAuth, isGlobalRole, requireTenant } from "../middlewares/auth";
import { requirePerm } from "../lib/permissions";
import type { Request } from "express";

const router: IRouter = Router();

// Permissão individual "tarefas": vendedor sem ela não acessa o quadro.
router.use("/tasks", requirePerm("tarefas"));

const STATUSES = ["todo", "doing", "done"];
const PRIORITIES = ["baixa", "media", "alta"];

async function enrichTask(t: typeof tasksTable.$inferSelect) {
  const tenantId = t.tenantId;
  const sectors = await db.select().from(sectorsTable).where(eq(sectorsTable.tenantId, tenantId));
  const users = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(eq(usersTable.tenantId, tenantId));
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
  tenantId: number,
  session: Request["session"],
  res: Parameters<Parameters<typeof router.get>[1]>[1],
): Promise<typeof tasksTable.$inferSelect | null> {
  const [t] = await db.select().from(tasksTable)
    .where(and(eq(tasksTable.id, id), eq(tasksTable.tenantId, tenantId)));
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
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const userRole = req.session.userRole!;

  const all = await db
    .select()
    .from(tasksTable)
    .where(and(eq(tasksTable.tenantId, tenantId), eq(tasksTable.isArchived, false)))
    .orderBy(asc(tasksTable.position), desc(tasksTable.updatedAt));

  const visible = isGlobalRole(userRole)
    ? all
    : all.filter((t) => callerCanAccessTask(req.session, t));

  const sectors = await db.select().from(sectorsTable).where(eq(sectorsTable.tenantId, tenantId));
  const users = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(eq(usersTable.tenantId, tenantId));
  const sectorMap = Object.fromEntries(sectors.map((s) => [s.id, s]));
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

  // Contadores de subtarefas e comentários para exibir nos cartões.
  const ids = visible.map((t) => t.id);
  const subCounts = ids.length > 0
    ? await db.select({
        taskId: taskSubtasksTable.taskId,
        total: sql<number>`count(*)::int`,
        done: sql<number>`count(*) filter (where ${taskSubtasksTable.isDone})::int`,
      }).from(taskSubtasksTable).where(inArray(taskSubtasksTable.taskId, ids)).groupBy(taskSubtasksTable.taskId)
    : [];
  const comCounts = ids.length > 0
    ? await db.select({
        taskId: taskCommentsTable.taskId,
        total: sql<number>`count(*)::int`,
      }).from(taskCommentsTable).where(inArray(taskCommentsTable.taskId, ids)).groupBy(taskCommentsTable.taskId)
    : [];
  const subMap = Object.fromEntries(subCounts.map((s) => [s.taskId, s]));
  const comMap = Object.fromEntries(comCounts.map((c) => [c.taskId, c.total]));

  res.json(visible.map((t) => ({
    ...t,
    sector: t.sectorId ? (sectorMap[t.sectorId] ?? null) : null,
    assignee: t.assigneeId ? (userMap[t.assigneeId] ?? null) : null,
    createdBy: t.createdById ? (userMap[t.createdById] ?? null) : null,
    subtaskTotal: subMap[t.id]?.total ?? 0,
    subtaskDone: subMap[t.id]?.done ?? 0,
    commentCount: comMap[t.id] ?? 0,
  })));
});

// ─── Relatório de tarefas por setor e por vendedor ──────────────────────────
router.get("/tasks/report", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const all = await db.select().from(tasksTable)
    .where(and(eq(tasksTable.tenantId, tenantId), eq(tasksTable.isArchived, false)));
  const visible = isGlobalRole(req.session.userRole)
    ? all
    : all.filter((t) => callerCanAccessTask(req.session, t));

  const sectors = await db.select().from(sectorsTable).where(eq(sectorsTable.tenantId, tenantId));
  const users = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(eq(usersTable.tenantId, tenantId));
  const sectorName = Object.fromEntries(sectors.map((s) => [s.id, s.name]));
  const userName = Object.fromEntries(users.map((u) => [u.id, u.name]));

  const now = new Date();
  type Bucket = { name: string; total: number; todo: number; doing: number; done: number; overdue: number };
  const mk = (name: string): Bucket => ({ name, total: 0, todo: 0, doing: 0, done: 0, overdue: 0 });
  const bySector: Record<string, Bucket> = {};
  const byUser: Record<string, Bucket> = {};
  for (const t of visible) {
    const sKey = t.sectorId != null ? String(t.sectorId) : "none";
    const uKey = t.assigneeId != null ? String(t.assigneeId) : "none";
    bySector[sKey] ??= mk(t.sectorId != null ? (sectorName[t.sectorId] ?? "Setor") : "Sem setor");
    byUser[uKey] ??= mk(t.assigneeId != null ? (userName[t.assigneeId] ?? "Usuário") : "Sem responsável");
    for (const b of [bySector[sKey], byUser[uKey]]) {
      b.total++;
      if (t.status === "todo") b.todo++;
      else if (t.status === "doing") b.doing++;
      else if (t.status === "done") b.done++;
      if (t.status !== "done" && t.dueDate && new Date(t.dueDate) < now) b.overdue++;
    }
  }
  const sort = (r: Record<string, Bucket>) => Object.values(r).sort((a, b) => b.total - a.total);
  res.json({ bySector: sort(bySector), byUser: sort(byUser) });
});

// ─── Comentários da tarefa (chat p/ dúvidas e complementos) ────────────────
router.get("/tasks/:id/comments", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const existing = await loadTaskWithAccess(id, tenantId, req.session, res);
  if (!existing) return;
  const rows = await db
    .select({
      id: taskCommentsTable.id,
      taskId: taskCommentsTable.taskId,
      authorId: taskCommentsTable.authorId,
      authorName: usersTable.name,
      content: taskCommentsTable.content,
      createdAt: taskCommentsTable.createdAt,
    })
    .from(taskCommentsTable)
    .leftJoin(usersTable, eq(taskCommentsTable.authorId, usersTable.id))
    .where(eq(taskCommentsTable.taskId, id))
    .orderBy(asc(taskCommentsTable.createdAt));
  res.json(rows);
});

router.post("/tasks/:id/comments", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const existing = await loadTaskWithAccess(id, tenantId, req.session, res);
  if (!existing) return;
  const { content } = req.body as { content?: string };
  const text = (content ?? "").trim();
  if (!text) { res.status(400).json({ error: "Comentário vazio" }); return; }
  const [inserted] = await db.insert(taskCommentsTable)
    .values({ tenantId, taskId: id, authorId: req.session.userId ?? null, content: text.slice(0, 2000) })
    .returning();
  const [author] = await db.select({ name: usersTable.name }).from(usersTable)
    .where(eq(usersTable.id, req.session.userId!)).limit(1);
  res.status(201).json({ ...inserted, authorName: author?.name ?? null });
});

// ─── Subtarefas (checklist) ─────────────────────────────────────────────────
router.get("/tasks/:id/subtasks", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const existing = await loadTaskWithAccess(id, tenantId, req.session, res);
  if (!existing) return;
  const rows = await db.select().from(taskSubtasksTable)
    .where(eq(taskSubtasksTable.taskId, id))
    .orderBy(asc(taskSubtasksTable.position), asc(taskSubtasksTable.id));
  res.json(rows);
});

router.post("/tasks/:id/subtasks", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const existing = await loadTaskWithAccess(id, tenantId, req.session, res);
  if (!existing) return;
  const { title } = req.body as { title?: string };
  const text = (title ?? "").trim();
  if (!text) { res.status(400).json({ error: "Título é obrigatório" }); return; }
  const [maxRow] = await db.select({ max: sql<number>`coalesce(max(${taskSubtasksTable.position}), 0)::int` })
    .from(taskSubtasksTable).where(eq(taskSubtasksTable.taskId, id));
  const [inserted] = await db.insert(taskSubtasksTable)
    .values({ tenantId, taskId: id, title: text.slice(0, 300), position: (maxRow?.max ?? 0) + 1 })
    .returning();
  res.status(201).json(inserted);
});

router.patch("/tasks/:id/subtasks/:subId", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  const subId = parseInt(String(req.params.subId), 10);
  if (isNaN(id) || isNaN(subId)) { res.status(400).json({ error: "ID inválido" }); return; }
  const existing = await loadTaskWithAccess(id, tenantId, req.session, res);
  if (!existing) return;
  const { isDone, title } = req.body as { isDone?: boolean; title?: string };
  const update: Record<string, unknown> = {};
  if (isDone !== undefined) update.isDone = isDone;
  if (title !== undefined && title.trim()) update.title = title.trim().slice(0, 300);
  if (Object.keys(update).length === 0) { res.status(400).json({ error: "Nada para atualizar" }); return; }
  const [updated] = await db.update(taskSubtasksTable).set(update)
    .where(sql`${taskSubtasksTable.id} = ${subId} AND ${taskSubtasksTable.taskId} = ${id}`)
    .returning();
  if (!updated) { res.status(404).json({ error: "Subtarefa não encontrada" }); return; }
  res.json(updated);
});

router.delete("/tasks/:id/subtasks/:subId", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  const subId = parseInt(String(req.params.subId), 10);
  if (isNaN(id) || isNaN(subId)) { res.status(400).json({ error: "ID inválido" }); return; }
  const existing = await loadTaskWithAccess(id, tenantId, req.session, res);
  if (!existing) return;
  await db.delete(taskSubtasksTable)
    .where(sql`${taskSubtasksTable.id} = ${subId} AND ${taskSubtasksTable.taskId} = ${id}`);
  res.json({ ok: true });
});

// ─── Create task ─────────────────────────────────────────────────────────────
router.post("/tasks", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { title, description, status, priority, assigneeId, sectorId, dueDate } = req.body as {
    title?: string; description?: string; status?: string; priority?: string;
    assigneeId?: number | null; sectorId?: number | null; dueDate?: string | null;
  };
  if (!title || !title.trim()) { res.status(400).json({ error: "Título é obrigatório" }); return; }
  const userRole = req.session.userRole!;
  const userSectorId = req.session.userSectorId ?? null;
  // Sector-scoped roles are pinned to their own sector; caller-supplied sectorId is ignored.
  const effectiveSectorId = isGlobalRole(userRole) ? (sectorId ?? null) : userSectorId;
  // Responsável só pode ser um usuário da mesma loja (tenant).
  let effectiveAssigneeId: number | null = null;
  if (assigneeId != null) {
    const [assignee] = await db.select({ id: usersTable.id }).from(usersTable)
      .where(and(eq(usersTable.id, assigneeId), eq(usersTable.tenantId, tenantId)));
    if (!assignee) { res.status(400).json({ error: "Responsável inválido" }); return; }
    effectiveAssigneeId = assignee.id;
  }
  const [created] = await db.insert(tasksTable).values({
    tenantId,
    title: title.trim(),
    description: description || null,
    status: STATUSES.includes(status ?? "") ? status! : "todo",
    priority: PRIORITIES.includes(priority ?? "") ? priority! : "media",
    assigneeId: effectiveAssigneeId,
    createdById: req.session.userId ?? null,
    sectorId: effectiveSectorId,
    dueDate: dueDate ? new Date(dueDate) : null,
  }).returning();
  res.status(201).json(await enrichTask(created));
});

// ─── Update task ─────────────────────────────────────────────────────────────
router.patch("/tasks/:id", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const existing = await loadTaskWithAccess(id, tenantId, req.session, res);
  if (!existing) return;
  const userRole = req.session.userRole!;
  const { title, description, status, priority, assigneeId, sectorId, dueDate, position, isArchived } = req.body as {
    title?: string; description?: string; status?: string; priority?: string;
    assigneeId?: number | null; sectorId?: number | null; dueDate?: string | null;
    position?: number; isArchived?: boolean;
  };
  // Somente o responsável pela tarefa pode marcá-la como concluída.
  // (Tarefas sem responsável podem ser concluídas por qualquer pessoa com acesso.)
  if (status === "done" && existing.status !== "done"
      && existing.assigneeId != null && existing.assigneeId !== req.session.userId) {
    res.status(403).json({ error: "Somente o responsável pela tarefa pode concluí-la" });
    return;
  }
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (title !== undefined) update.title = title.trim();
  if (description !== undefined) update.description = description || null;
  if (status !== undefined && STATUSES.includes(status)) update.status = status;
  if (priority !== undefined && PRIORITIES.includes(priority)) update.priority = priority;
  if (assigneeId !== undefined) {
    if (assigneeId == null) {
      update.assigneeId = null;
    } else {
      // Responsável só pode ser um usuário da mesma loja (tenant).
      const [assignee] = await db.select({ id: usersTable.id }).from(usersTable)
        .where(and(eq(usersTable.id, assigneeId), eq(usersTable.tenantId, tenantId)));
      if (!assignee) { res.status(400).json({ error: "Responsável inválido" }); return; }
      update.assigneeId = assignee.id;
    }
  }
  // Only admins/supervisors may move a task to a different sector.
  if (sectorId !== undefined && isGlobalRole(userRole)) update.sectorId = sectorId ?? null;
  if (dueDate !== undefined) update.dueDate = dueDate ? new Date(dueDate) : null;
  if (position !== undefined) update.position = position;
  if (isArchived !== undefined) update.isArchived = isArchived;
  const [updated] = await db.update(tasksTable).set(update)
    .where(and(eq(tasksTable.id, id), eq(tasksTable.tenantId, tenantId))).returning();
  res.json(await enrichTask(updated));
});

// ─── Delete (archive) ────────────────────────────────────────────────────────
router.delete("/tasks/:id", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const existing = await loadTaskWithAccess(id, tenantId, req.session, res);
  if (!existing) return;
  await db.update(tasksTable).set({ isArchived: true })
    .where(and(eq(tasksTable.id, id), eq(tasksTable.tenantId, tenantId)));
  res.json({ ok: true });
});

export default router;
