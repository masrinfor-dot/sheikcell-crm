// Link seguro do Gerente IA (sem login): /g/:token no site (e a aba Tarefas
// do painel) chamam estas rotas. O token vale para UM escopo (o "dia" do dono
// = todas as tarefas da loja, ou UMA tarefa) e expira. Só o link do dono
// (can_edit) altera; o que vai pro vendedor é só leitura. A foto de prova só
// sai se pertence ao escopo do link.
import { Router, type IRouter, type Request, type Response } from "express";
import path from "node:path";
import { createReadStream } from "node:fs";
import { and, eq, gte, lt, asc, desc, ne, inArray, sql } from "drizzle-orm";
import {
  db, tasksTable, taskCommentsTable, taskAssigneesTable, taskSubtasksTable, usersTable, gerenteEventsTable, gerenteRemindersTable,
  gerenteTaskDispatchesTable, gerenteBillsTable, gerenteTaskMetaTable,
} from "@workspace/db";
import { resolveLink } from "../lib/gerenteExtras";
import { TASK_CATEGORIES } from "../lib/gerente";
import { parseSpLocal, spDateISO } from "../lib/gerenteRules";

const router: IRouter = Router();

type Link = NonNullable<Awaited<ReturnType<typeof resolveLink>>>;

async function linkOr404(req: Request, res: Response): Promise<Link | null> {
  const link = await resolveLink(String(req.params["token"]));
  if (!link) { res.status(404).json({ error: "Link inválido ou expirado. Peça um novo no WhatsApp: *link*." }); return null; }
  res.setHeader("Cache-Control", "no-store");
  return link;
}

async function team(tenantId: number) {
  return (await db.select({ id: usersTable.id, name: usersTable.name, role: usersTable.role }).from(usersTable)
    .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.isActive, true), ne(usersTable.role, "superadmin")))
    .orderBy(asc(usersTable.name))).map((u) => ({ id: u.id, name: u.name.trim(), isOwner: u.role === "admin" }));
}

/** Lista de tarefas (abertas + concluídas nos últimos 7 dias) com tudo que a tela usa. */
async function taskList(tenantId: number, onlyId?: number) {
  const since = new Date(Date.now() - 7 * 86_400_000);
  const rows = await db.select({
    id: tasksTable.id, title: tasksTable.title, description: tasksTable.description, status: tasksTable.status,
    priority: tasksTable.priority, dueDate: tasksTable.dueDate, createdAt: tasksTable.createdAt, updatedAt: tasksTable.updatedAt,
    category: gerenteTaskMetaTable.category,
  }).from(tasksTable).leftJoin(gerenteTaskMetaTable, eq(gerenteTaskMetaTable.taskId, tasksTable.id))
    .where(and(
      eq(tasksTable.tenantId, tenantId), eq(tasksTable.isArchived, false),
      ...(onlyId ? [eq(tasksTable.id, onlyId)] : [sql`(${tasksTable.status} <> 'done' OR ${tasksTable.updatedAt} >= ${since})`]),
    )).orderBy(asc(tasksTable.id)).limit(600);
  const ids = rows.map((r) => r.id);
  if (!ids.length) return [];
  const [who, subs, comments, dispatch] = await Promise.all([
    db.select({ taskId: taskAssigneesTable.taskId, id: usersTable.id, name: usersTable.name }).from(taskAssigneesTable)
      .innerJoin(usersTable, eq(usersTable.id, taskAssigneesTable.userId)).where(inArray(taskAssigneesTable.taskId, ids)),
    db.select({ taskId: taskSubtasksTable.taskId, done: taskSubtasksTable.isDone }).from(taskSubtasksTable).where(inArray(taskSubtasksTable.taskId, ids)),
    db.select({ taskId: taskCommentsTable.taskId, image: taskCommentsTable.mediaType }).from(taskCommentsTable).where(inArray(taskCommentsTable.taskId, ids)),
    db.select({ taskId: gerenteTaskDispatchesTable.taskId, status: gerenteTaskDispatchesTable.status }).from(gerenteTaskDispatchesTable)
      .where(inArray(gerenteTaskDispatchesTable.taskId, ids)).orderBy(desc(gerenteTaskDispatchesTable.id)),
  ]);
  return rows.map((r) => ({
    ...r,
    assignees: who.filter((w) => w.taskId === r.id).map((w) => ({ id: w.id, name: w.name.trim() })),
    subtasks: { total: subs.filter((s) => s.taskId === r.id).length, done: subs.filter((s) => s.taskId === r.id && s.done).length },
    comments: comments.filter((c) => c.taskId === r.id).length,
    hasProof: comments.some((c) => c.taskId === r.id && c.image === "image"),
    whatsapp: dispatch.find((d) => d.taskId === r.id)?.status ?? null,
  }));
}

async function taskDetail(tenantId: number, taskId: number) {
  const [t] = await taskList(tenantId, taskId);
  if (!t) {
    // Concluída há mais de 7 dias: ainda abre pelo número.
    const [raw] = await db.select({ id: tasksTable.id }).from(tasksTable).where(and(eq(tasksTable.id, taskId), eq(tasksTable.tenantId, tenantId), eq(tasksTable.isArchived, false))).limit(1);
    if (!raw) return null;
  }
  const base = t ?? (await db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).limit(1)).map((x) => ({ ...x, category: null, assignees: [], subtasks: { total: 0, done: 0 }, comments: 0, hasProof: false, whatsapp: null }))[0]!;
  const [subtasks, comments] = await Promise.all([
    db.select({ id: taskSubtasksTable.id, title: taskSubtasksTable.title, done: taskSubtasksTable.isDone }).from(taskSubtasksTable)
      .where(eq(taskSubtasksTable.taskId, taskId)).orderBy(asc(taskSubtasksTable.position), asc(taskSubtasksTable.id)),
    db.select({ id: taskCommentsTable.id, content: taskCommentsTable.content, mediaType: taskCommentsTable.mediaType, mediaUrl: taskCommentsTable.mediaUrl, createdAt: taskCommentsTable.createdAt, author: usersTable.name })
      .from(taskCommentsTable).leftJoin(usersTable, eq(usersTable.id, taskCommentsTable.authorId))
      .where(eq(taskCommentsTable.taskId, taskId)).orderBy(asc(taskCommentsTable.createdAt)),
  ]);
  return {
    ...base,
    subtaskList: subtasks,
    commentList: comments.map((c) => ({ id: c.id, content: c.content, author: c.author?.trim() ?? null, createdAt: c.createdAt, image: !!c.mediaUrl && c.mediaType === "image" })),
  };
}

router.get("/gerente-public/:token", async (req, res): Promise<void> => {
  const link = await linkOr404(req, res); if (!link) return;
  const tenantId = link.tenantId;
  if (link.scope === "task" && link.refId) {
    const task = await taskDetail(tenantId, link.refId);
    if (!task) { res.status(404).json({ error: "Tarefa não encontrada." }); return; }
    res.json({ scope: "task", canEdit: link.canEdit, expiresAt: link.expiresAt, task, team: link.canEdit ? await team(tenantId) : [], categories: TASK_CATEGORIES, today: new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }) });
    return;
  }
  const today = spDateISO();
  const start = parseSpLocal(`${today}T00:00`)!;
  const end = new Date(start.getTime() + 86_400_000);
  const [events, reminders, bills, tasks, members, cats] = await Promise.all([
    db.select({ id: gerenteEventsTable.id, title: gerenteEventsTable.title, startsAt: gerenteEventsTable.startsAt, location: gerenteEventsTable.location })
      .from(gerenteEventsTable).where(and(eq(gerenteEventsTable.tenantId, tenantId), eq(gerenteEventsTable.status, "agendado"), gte(gerenteEventsTable.startsAt, start), lt(gerenteEventsTable.startsAt, new Date(start.getTime() + 7 * 86_400_000)))).orderBy(asc(gerenteEventsTable.startsAt)).limit(40),
    db.select({ id: gerenteRemindersTable.id, title: gerenteRemindersTable.title, dueAt: gerenteRemindersTable.dueAt, urgent: gerenteRemindersTable.urgent })
      .from(gerenteRemindersTable).where(and(eq(gerenteRemindersTable.tenantId, tenantId), eq(gerenteRemindersTable.status, "pendente"), lt(gerenteRemindersTable.dueAt, end))).orderBy(asc(gerenteRemindersTable.dueAt)).limit(40),
    db.select({ id: gerenteBillsTable.id, kind: gerenteBillsTable.kind, description: gerenteBillsTable.description, amountCents: gerenteBillsTable.amountCents, dueDate: gerenteBillsTable.dueDate })
      .from(gerenteBillsTable).where(and(eq(gerenteBillsTable.tenantId, tenantId), eq(gerenteBillsTable.status, "aberta"))).orderBy(asc(gerenteBillsTable.dueDate)).limit(20),
    taskList(tenantId),
    team(tenantId),
    db.selectDistinct({ category: gerenteTaskMetaTable.category }).from(gerenteTaskMetaTable).where(eq(gerenteTaskMetaTable.tenantId, tenantId)),
  ]);
  const categories = [...new Set([...TASK_CATEGORIES, ...cats.map((c) => c.category).filter((c): c is string => !!c)])];
  res.json({ scope: "dia", canEdit: link.canEdit, expiresAt: link.expiresAt, today, now: new Date().toISOString(), events, reminders, bills, tasks, team: members, categories });
});

router.get("/gerente-public/:token/task/:id", async (req, res): Promise<void> => {
  const link = await linkOr404(req, res); if (!link) return;
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || (link.scope === "task" && link.refId !== id)) { res.status(404).json({ error: "Link inválido para esta tarefa." }); return; }
  const task = await taskDetail(link.tenantId, id);
  if (!task) { res.status(404).json({ error: "Tarefa não encontrada." }); return; }
  res.json({ scope: "task", canEdit: link.canEdit, expiresAt: link.expiresAt, task });
});

// ─── Ações (só link do dono) ─────────────────────────────────────────────────

async function editable(req: Request, res: Response, needTask = true): Promise<{ tenantId: number; taskId: number } | null> {
  const link = await resolveLink(String(req.params["token"]));
  if (!link || !link.canEdit) { res.status(403).json({ error: "Este link é só de leitura." }); return null; }
  if (!needTask) return { tenantId: link.tenantId, taskId: 0 };
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || (link.scope === "task" && link.refId !== id)) { res.status(403).json({ error: "Link não vale pra esta tarefa." }); return null; }
  const [t] = await db.select({ id: tasksTable.id }).from(tasksTable).where(and(eq(tasksTable.id, id), eq(tasksTable.tenantId, link.tenantId))).limit(1);
  if (!t) { res.status(404).json({ error: "Tarefa não encontrada." }); return null; }
  return { tenantId: link.tenantId, taskId: t.id };
}

router.post("/gerente-public/:token/task/:id/status", async (req, res): Promise<void> => {
  const ref = await editable(req, res); if (!ref) return;
  const status = (req.body as { status?: unknown })?.status;
  if (status !== "todo" && status !== "doing" && status !== "done") { res.status(400).json({ error: "Situação inválida." }); return; }
  const notify = (req.body as { notify?: unknown })?.notify !== false;
  const { setTaskStatus } = await import("../lib/gerenteTaskOps");
  res.json({ message: await setTaskStatus(ref.tenantId, ref.taskId, status, notify) });
});

router.post("/gerente-public/:token/task/:id/comment", async (req, res): Promise<void> => {
  const ref = await editable(req, res); if (!ref) return;
  const text = String((req.body as { text?: unknown })?.text ?? "").trim();
  if (!text) { res.status(400).json({ error: "Escreva o comentário." }); return; }
  const notify = (req.body as { notify?: unknown })?.notify === true;
  const { addTaskComment } = await import("../lib/gerenteTaskOps");
  res.json({ message: await addTaskComment(ref.tenantId, ref.taskId, text.slice(0, 2000), notify) });
});

router.patch("/gerente-public/:token/task/:id", async (req, res): Promise<void> => {
  const ref = await editable(req, res); if (!ref) return;
  const b = req.body as Record<string, unknown>;
  const patch: import("../lib/gerenteTaskOps").TaskPatch = {};
  if (typeof b["title"] === "string") patch.title = b["title"];
  if (b["dueDate"] === null) patch.dueDate = null;
  else if (typeof b["dueDate"] === "string") { const d = parseSpLocal(b["dueDate"]); if (!d) { res.status(400).json({ error: "Data inválida." }); return; } patch.dueDate = d; }
  if (b["priority"] === "baixa" || b["priority"] === "media" || b["priority"] === "alta") patch.priority = b["priority"];
  if (Array.isArray(b["assigneeIds"])) patch.assigneeIds = (b["assigneeIds"] as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 20);
  if (b["category"] === null || typeof b["category"] === "string") patch.category = b["category"] as string | null;
  if (b["description"] === null || typeof b["description"] === "string") patch.description = b["description"] as string | null;
  const { updateTask } = await import("../lib/gerenteTaskOps");
  res.json({ message: await updateTask(ref.tenantId, ref.taskId, patch) });
});

router.post("/gerente-public/:token/task/:id/subtasks", async (req, res): Promise<void> => {
  const ref = await editable(req, res); if (!ref) return;
  const title = String((req.body as { title?: unknown })?.title ?? "").trim();
  if (!title) { res.status(400).json({ error: "Escreva o item." }); return; }
  const { addSubtask } = await import("../lib/gerenteTaskOps");
  await addSubtask(ref.tenantId, ref.taskId, title);
  res.json({ ok: true });
});

router.patch("/gerente-public/:token/task/:id/subtasks/:sid", async (req, res): Promise<void> => {
  const ref = await editable(req, res); if (!ref) return;
  const sid = Number(req.params["sid"]);
  if (!Number.isInteger(sid)) { res.status(400).json({ error: "Item inválido." }); return; }
  const { toggleSubtask } = await import("../lib/gerenteTaskOps");
  await toggleSubtask(ref.tenantId, ref.taskId, sid, (req.body as { done?: unknown })?.done === true);
  res.json({ ok: true });
});

router.post("/gerente-public/:token/task/:id/archive", async (req, res): Promise<void> => {
  const ref = await editable(req, res); if (!ref) return;
  const { archiveTask } = await import("../lib/gerenteTaskOps");
  res.json({ message: await archiveTask(ref.tenantId, ref.taskId) });
});

// Captura rápida: a mesma interpretação do WhatsApp ("tarefa pro Alan …").
router.post("/gerente-public/:token/capture", async (req, res): Promise<void> => {
  const ref = await editable(req, res, false); if (!ref) return;
  const text = String((req.body as { text?: unknown })?.text ?? "").trim();
  if (!text) { res.status(400).json({ error: "Escreva o que precisa." }); return; }
  const { handlePanelMessage } = await import("../lib/gerente");
  res.json(await handlePanelMessage(ref.tenantId, text.slice(0, 2000)));
});

router.post("/gerente-public/:token/merge-duplicates", async (req, res): Promise<void> => {
  const ref = await editable(req, res, false); if (!ref) return;
  const { mergeDuplicateTasks } = await import("../lib/gerenteTaskOps");
  const r = await mergeDuplicateTasks(ref.tenantId);
  res.json({ groups: r.length, archived: r.reduce((s, g) => s + g.archived.length, 0) });
});

// Foto de prova/comentário: só se o comentário for de uma tarefa coberta pelo link.
router.get("/gerente-public/:token/media/:commentId", async (req, res): Promise<void> => {
  const link = await resolveLink(String(req.params["token"]));
  const commentId = Number(req.params["commentId"]);
  if (!link || !Number.isInteger(commentId)) { res.status(404).end(); return; }
  const [c] = await db.select({ taskId: taskCommentsTable.taskId, tenantId: taskCommentsTable.tenantId, mediaUrl: taskCommentsTable.mediaUrl })
    .from(taskCommentsTable).where(eq(taskCommentsTable.id, commentId)).limit(1);
  if (!c || c.tenantId !== link.tenantId || !c.mediaUrl || (link.scope === "task" && c.taskId !== link.refId)) { res.status(404).end(); return; }
  const { MEDIA_DIR } = await import("../lib/whatsappInbound");
  const file = path.basename(c.mediaUrl);
  if (!/^[a-zA-Z0-9._-]{5,120}$/.test(file)) { res.status(404).end(); return; }
  res.setHeader("Cache-Control", "private, max-age=3600");
  const ext = file.split(".").pop()!.toLowerCase();
  res.type(ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg");
  createReadStream(path.join(MEDIA_DIR, file)).on("error", () => { if (!res.headersSent) res.status(404).end(); else res.end(); }).pipe(res);
});

export default router;
