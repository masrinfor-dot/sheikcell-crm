import { Router, type IRouter } from "express";
import { db, tasksTable, sectorsTable, usersTable, taskCommentsTable, taskSubtasksTable, taskNotificationsTable, taskAssigneesTable } from "@workspace/db";
import { eq, and, desc, asc, inArray, sql } from "drizzle-orm";
import { requireAuth, isGlobalRole, requireTenant } from "../middlewares/auth";
import { requireModuleAccess } from "../lib/moduleAccess";
import { MEDIA_DIR } from "../lib/whatsappInbound";
import { writeFile, mkdir } from "fs/promises";
import { randomUUID } from "crypto";
import path from "path";
import type { Request } from "express";

const ALLOWED_COMMENT_MIMES: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

async function saveCommentAttachment(base64: string, rawMimetype: string): Promise<{ mediaUrl: string; mediaType: "image" | "doc" }> {
  const mimetype = rawMimetype.split(";")[0]!.trim().toLowerCase();
  const ext = ALLOWED_COMMENT_MIMES[mimetype];
  if (!ext) throw new Error("Tipo de arquivo não suportado");
  const buf = Buffer.from(base64, "base64");
  if (buf.byteLength > 20 * 1024 * 1024) throw new Error("Arquivo muito grande (máximo 20 MB)");
  await mkdir(MEDIA_DIR, { recursive: true });
  const filename = `${randomUUID()}.${ext}`;
  await writeFile(path.join(MEDIA_DIR, filename), buf);
  return { mediaUrl: `/api/chat/media/${filename}`, mediaType: mimetype.startsWith("image/") ? "image" : "doc" };
}

// Avisa responsáveis e criador (exceto quem comentou) que a tarefa recebeu um
// comentário novo. Sem push em tempo real — vira um badge no quadro, lido
// quando a pessoa abre a tarefa.
async function notifyInvolved(task: typeof tasksTable.$inferSelect, assigneeIds: number[], commentId: number, authorId: number | null): Promise<void> {
  const recipients = new Set([...assigneeIds, task.createdById].filter((id): id is number => id != null && id !== authorId));
  if (recipients.size === 0) return;
  await db.insert(taskNotificationsTable).values(
    [...recipients].map((userId) => ({ tenantId: task.tenantId, taskId: task.id, commentId, userId })),
  );
}

async function getAssigneeIds(taskId: number): Promise<number[]> {
  const rows = await db.select({ userId: taskAssigneesTable.userId }).from(taskAssigneesTable)
    .where(eq(taskAssigneesTable.taskId, taskId));
  return rows.map((r) => r.userId);
}

// Valida que os IDs informados são usuários ativos-existentes da mesma loja
// e devolve a lista sem duplicatas.
async function resolveAssigneeIds(ids: number[] | undefined | null, tenantId: number): Promise<number[] | { error: string }> {
  if (!ids || ids.length === 0) return [];
  const unique = [...new Set(ids)];
  const found = await db.select({ id: usersTable.id }).from(usersTable)
    .where(and(inArray(usersTable.id, unique), eq(usersTable.tenantId, tenantId)));
  if (found.length !== unique.length) return { error: "Responsável inválido" };
  return unique;
}

async function setTaskAssignees(taskId: number, tenantId: number, assigneeIds: number[]): Promise<void> {
  await db.delete(taskAssigneesTable).where(eq(taskAssigneesTable.taskId, taskId));
  if (assigneeIds.length > 0) {
    await db.insert(taskAssigneesTable).values(assigneeIds.map((userId) => ({ tenantId, taskId, userId })));
  }
}

const router: IRouter = Router();

// Módulo "tarefas" contratado pela loja e liberado pro usuário.
router.use("/tasks", requireModuleAccess("tarefas"));

const STATUSES = ["todo", "doing", "done"];
const PRIORITIES = ["baixa", "media", "alta"];

async function enrichTask(t: typeof tasksTable.$inferSelect) {
  const tenantId = t.tenantId;
  const sectors = await db.select().from(sectorsTable).where(eq(sectorsTable.tenantId, tenantId));
  const users = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(eq(usersTable.tenantId, tenantId));
  const sectorMap = Object.fromEntries(sectors.map((s) => [s.id, s]));
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));
  const assigneeIds = await getAssigneeIds(t.id);
  return {
    ...t,
    sector: t.sectorId ? (sectorMap[t.sectorId] ?? null) : null,
    assignees: assigneeIds.map((id) => userMap[id]).filter((u): u is { id: number; name: string } => u != null),
    createdBy: t.createdById ? (userMap[t.createdById] ?? null) : null,
  };
}

/**
 * Returns true if the caller can access a task. Admins/supervisors see all;
 * vendedores see tasks in their own sector, assigned to them, or created by them.
 */
function callerCanAccessTask(session: Request["session"], t: typeof tasksTable.$inferSelect, assigneeIds: number[]): boolean {
  if (isGlobalRole(session.userRole)) return true;
  const uid = session.userId ?? null;
  const sid = session.userSectorId ?? null;
  // Fail closed: a null caller sector must never match null-sector tasks.
  const sameSector = sid != null && t.sectorId === sid;
  const isAssignee = uid != null && assigneeIds.includes(uid);
  const isCreator = uid != null && t.createdById === uid;
  return sameSector || isAssignee || isCreator;
}

async function loadTaskWithAccess(
  id: number,
  tenantId: number,
  session: Request["session"],
  res: Parameters<Parameters<typeof router.get>[1]>[1],
): Promise<(typeof tasksTable.$inferSelect & { assigneeIds: number[] }) | null> {
  const [t] = await db.select().from(tasksTable)
    .where(and(eq(tasksTable.id, id), eq(tasksTable.tenantId, tenantId)));
  if (!t || t.isArchived) {
    res.status(404).json({ error: "Tarefa não encontrada" });
    return null;
  }
  const assigneeIds = await getAssigneeIds(t.id);
  if (!callerCanAccessTask(session, t, assigneeIds)) {
    res.status(403).json({ error: "Acesso negado" });
    return null;
  }
  return { ...t, assigneeIds };
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

  const sectors = await db.select().from(sectorsTable).where(eq(sectorsTable.tenantId, tenantId));
  const users = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(eq(usersTable.tenantId, tenantId));
  const sectorMap = Object.fromEntries(sectors.map((s) => [s.id, s]));
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

  const allIds = all.map((t) => t.id);
  const assigneeRows = allIds.length > 0
    ? await db.select({ taskId: taskAssigneesTable.taskId, userId: taskAssigneesTable.userId })
        .from(taskAssigneesTable).where(inArray(taskAssigneesTable.taskId, allIds))
    : [];
  const assigneeMap = new Map<number, number[]>();
  for (const r of assigneeRows) assigneeMap.set(r.taskId, [...(assigneeMap.get(r.taskId) ?? []), r.userId]);

  const visible = isGlobalRole(userRole)
    ? all
    : all.filter((t) => callerCanAccessTask(req.session, t, assigneeMap.get(t.id) ?? []));

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
    assignees: (assigneeMap.get(t.id) ?? []).map((id) => userMap[id]).filter((u): u is { id: number; name: string } => u != null),
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

  const allIds = all.map((t) => t.id);
  const assigneeRows = allIds.length > 0
    ? await db.select({ taskId: taskAssigneesTable.taskId, userId: taskAssigneesTable.userId })
        .from(taskAssigneesTable).where(inArray(taskAssigneesTable.taskId, allIds))
    : [];
  const assigneeMap = new Map<number, number[]>();
  for (const r of assigneeRows) assigneeMap.set(r.taskId, [...(assigneeMap.get(r.taskId) ?? []), r.userId]);

  const visible = isGlobalRole(req.session.userRole)
    ? all
    : all.filter((t) => callerCanAccessTask(req.session, t, assigneeMap.get(t.id) ?? []));

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
    bySector[sKey] ??= mk(t.sectorId != null ? (sectorName[t.sectorId] ?? "Setor") : "Sem setor");
    const bump = (b: Bucket) => {
      b.total++;
      if (t.status === "todo") b.todo++;
      else if (t.status === "doing") b.doing++;
      else if (t.status === "done") b.done++;
      if (t.status !== "done" && t.dueDate && new Date(t.dueDate) < now) b.overdue++;
    };
    bump(bySector[sKey]!);
    // Tarefa com vários responsáveis conta no relatório de cada um deles.
    const taskAssignees = assigneeMap.get(t.id) ?? [];
    if (taskAssignees.length === 0) {
      byUser.none ??= mk("Sem responsável");
      bump(byUser.none);
    } else {
      for (const uid of taskAssignees) {
        const uKey = String(uid);
        byUser[uKey] ??= mk(userName[uid] ?? "Usuário");
        bump(byUser[uKey]!);
      }
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
      mediaUrl: taskCommentsTable.mediaUrl,
      mediaType: taskCommentsTable.mediaType,
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
  const { content, mediaBase64, mediaMimetype } = req.body as { content?: string; mediaBase64?: string; mediaMimetype?: string };
  const text = (content ?? "").trim();
  if (!text && !mediaBase64) { res.status(400).json({ error: "Comentário vazio" }); return; }

  let mediaUrl: string | null = null;
  let mediaType: string | null = null;
  if (mediaBase64 && mediaMimetype) {
    try {
      const saved = await saveCommentAttachment(mediaBase64, mediaMimetype);
      mediaUrl = saved.mediaUrl;
      mediaType = saved.mediaType;
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Falha ao salvar anexo" });
      return;
    }
  }

  const [inserted] = await db.insert(taskCommentsTable)
    .values({ tenantId, taskId: id, authorId: req.session.userId ?? null, content: text.slice(0, 2000), mediaUrl, mediaType })
    .returning();
  const [author] = await db.select({ name: usersTable.name }).from(usersTable)
    .where(eq(usersTable.id, req.session.userId!)).limit(1);
  await notifyInvolved(existing, existing.assigneeIds, inserted!.id, req.session.userId ?? null);
  res.status(201).json({ ...inserted, authorName: author?.name ?? null });
});

// ─── Avisos de comentário novo (badge simples, sem push em tempo real) ──────
router.get("/tasks/notifications/unread", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await db.selectDistinct({ taskId: taskNotificationsTable.taskId })
    .from(taskNotificationsTable)
    .where(and(
      eq(taskNotificationsTable.tenantId, tenantId),
      eq(taskNotificationsTable.userId, req.session.userId!),
      eq(taskNotificationsTable.isRead, false),
    ));
  res.json({ taskIds: rows.map((r) => r.taskId) });
});

router.post("/tasks/:id/notifications/read", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.update(taskNotificationsTable).set({ isRead: true })
    .where(and(
      eq(taskNotificationsTable.tenantId, tenantId),
      eq(taskNotificationsTable.taskId, id),
      eq(taskNotificationsTable.userId, req.session.userId!),
    ));
  res.json({ ok: true });
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
  const { isDone, title, position } = req.body as { isDone?: boolean; title?: string; position?: number };
  const update: Record<string, unknown> = {};
  if (isDone !== undefined) update.isDone = isDone;
  if (title !== undefined && title.trim()) update.title = title.trim().slice(0, 300);
  if (position !== undefined) update.position = position;
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
  const { title, description, status, priority, assigneeIds, sectorId, dueDate } = req.body as {
    title?: string; description?: string; status?: string; priority?: string;
    assigneeIds?: number[] | null; sectorId?: number | null; dueDate?: string | null;
  };
  if (!title || !title.trim()) { res.status(400).json({ error: "Título é obrigatório" }); return; }
  const userRole = req.session.userRole!;
  const userSectorId = req.session.userSectorId ?? null;
  // Sector-scoped roles are pinned to their own sector; caller-supplied sectorId is ignored.
  const effectiveSectorId = isGlobalRole(userRole) ? (sectorId ?? null) : userSectorId;
  // Responsáveis só podem ser usuários da mesma loja (tenant).
  const resolvedAssignees = await resolveAssigneeIds(assigneeIds ?? undefined, tenantId);
  if ("error" in resolvedAssignees) { res.status(400).json({ error: resolvedAssignees.error }); return; }
  const [created] = await db.insert(tasksTable).values({
    tenantId,
    title: title.trim(),
    description: description || null,
    status: STATUSES.includes(status ?? "") ? status! : "todo",
    priority: PRIORITIES.includes(priority ?? "") ? priority! : "media",
    createdById: req.session.userId ?? null,
    sectorId: effectiveSectorId,
    dueDate: dueDate ? new Date(dueDate) : null,
  }).returning();
  if (resolvedAssignees.length > 0) await setTaskAssignees(created!.id, tenantId, resolvedAssignees);
  res.status(201).json(await enrichTask(created!));
});

// ─── Update task ─────────────────────────────────────────────────────────────
router.patch("/tasks/:id", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const existing = await loadTaskWithAccess(id, tenantId, req.session, res);
  if (!existing) return;
  const userRole = req.session.userRole!;
  const { title, description, status, priority, assigneeIds, sectorId, dueDate, position, isArchived } = req.body as {
    title?: string; description?: string; status?: string; priority?: string;
    assigneeIds?: number[] | null; sectorId?: number | null; dueDate?: string | null;
    position?: number; isArchived?: boolean;
  };
  // Qualquer um dos responsáveis pode marcar a tarefa como concluída.
  // (Tarefas sem responsável podem ser concluídas por qualquer pessoa com acesso.)
  if (status === "done" && existing.status !== "done"
      && existing.assigneeIds.length > 0 && !existing.assigneeIds.includes(req.session.userId!)) {
    res.status(403).json({ error: "Somente um dos responsáveis pela tarefa pode concluí-la" });
    return;
  }
  let resolvedAssignees: number[] | null = null;
  if (assigneeIds !== undefined) {
    const r = await resolveAssigneeIds(assigneeIds, tenantId);
    if ("error" in r) { res.status(400).json({ error: r.error }); return; }
    resolvedAssignees = r;
  }
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (title !== undefined) update.title = title.trim();
  if (description !== undefined) update.description = description || null;
  if (status !== undefined && STATUSES.includes(status)) update.status = status;
  if (priority !== undefined && PRIORITIES.includes(priority)) update.priority = priority;
  // Only admins/supervisors may move a task to a different sector.
  if (sectorId !== undefined && isGlobalRole(userRole)) update.sectorId = sectorId ?? null;
  if (dueDate !== undefined) update.dueDate = dueDate ? new Date(dueDate) : null;
  if (position !== undefined) update.position = position;
  if (isArchived !== undefined) update.isArchived = isArchived;
  const [updated] = await db.update(tasksTable).set(update)
    .where(and(eq(tasksTable.id, id), eq(tasksTable.tenantId, tenantId))).returning();
  if (resolvedAssignees !== null) await setTaskAssignees(id, tenantId, resolvedAssignees);
  res.json(await enrichTask(updated!));
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
