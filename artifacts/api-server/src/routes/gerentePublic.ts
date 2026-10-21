// Link seguro do Gerente IA (sem login, só leitura): /g/:token no site chama
// estas rotas. O token vale para UM escopo (o dia do dono ou UMA tarefa) e
// expira; a foto de prova só sai se pertence a esse escopo.
import { Router, type IRouter } from "express";
import path from "node:path";
import { createReadStream } from "node:fs";
import { and, eq, gte, lt, asc, desc, ne, inArray } from "drizzle-orm";
import {
  db, tasksTable, taskCommentsTable, taskAssigneesTable, usersTable, gerenteEventsTable, gerenteRemindersTable,
  gerenteTaskDispatchesTable, gerenteBillsTable,
} from "@workspace/db";
import { resolveLink } from "../lib/gerenteExtras";
import { parseSpLocal, spDateISO } from "../lib/gerenteRules";

const router: IRouter = Router();

async function taskView(tenantId: number, taskId: number) {
  const [t] = await db.select().from(tasksTable).where(and(eq(tasksTable.id, taskId), eq(tasksTable.tenantId, tenantId))).limit(1);
  if (!t) return null;
  const who = await db.select({ name: usersTable.name }).from(taskAssigneesTable).innerJoin(usersTable, eq(usersTable.id, taskAssigneesTable.userId)).where(eq(taskAssigneesTable.taskId, t.id));
  const comments = await db.select({ id: taskCommentsTable.id, content: taskCommentsTable.content, mediaType: taskCommentsTable.mediaType, hasMedia: taskCommentsTable.mediaUrl, createdAt: taskCommentsTable.createdAt, author: usersTable.name })
    .from(taskCommentsTable).leftJoin(usersTable, eq(usersTable.id, taskCommentsTable.authorId))
    .where(eq(taskCommentsTable.taskId, t.id)).orderBy(asc(taskCommentsTable.createdAt));
  const [dispatch] = await db.select({ status: gerenteTaskDispatchesTable.status, doneAt: gerenteTaskDispatchesTable.doneAt }).from(gerenteTaskDispatchesTable)
    .where(eq(gerenteTaskDispatchesTable.taskId, t.id)).orderBy(desc(gerenteTaskDispatchesTable.id)).limit(1);
  return {
    id: t.id, title: t.title, description: t.description, status: t.status, priority: t.priority, dueDate: t.dueDate, isArchived: t.isArchived,
    assignees: who.map((w) => w.name.trim()), whatsapp: dispatch ?? null,
    comments: comments.map((c) => ({ id: c.id, content: c.content, author: c.author?.trim() ?? null, createdAt: c.createdAt, image: !!c.hasMedia && c.mediaType === "image" })),
  };
}

router.get("/gerente-public/:token", async (req, res): Promise<void> => {
  const link = await resolveLink(String(req.params["token"]));
  if (!link) { res.status(404).json({ error: "Link inválido ou expirado. Peça um novo no WhatsApp: *link*." }); return; }
  res.setHeader("Cache-Control", "no-store");
  if (link.scope === "task" && link.refId) {
    const task = await taskView(link.tenantId, link.refId);
    if (!task) { res.status(404).json({ error: "Tarefa não encontrada." }); return; }
    res.json({ scope: "task", expiresAt: link.expiresAt, task });
    return;
  }
  const today = spDateISO();
  const start = parseSpLocal(`${today}T00:00`)!;
  const end = new Date(start.getTime() + 86_400_000);
  const tenantId = link.tenantId;
  const [events, reminders, bills, tasks] = await Promise.all([
    db.select({ id: gerenteEventsTable.id, title: gerenteEventsTable.title, startsAt: gerenteEventsTable.startsAt, location: gerenteEventsTable.location })
      .from(gerenteEventsTable).where(and(eq(gerenteEventsTable.tenantId, tenantId), eq(gerenteEventsTable.status, "agendado"), gte(gerenteEventsTable.startsAt, start), lt(gerenteEventsTable.startsAt, new Date(start.getTime() + 7 * 86_400_000)))).orderBy(asc(gerenteEventsTable.startsAt)).limit(40),
    db.select({ id: gerenteRemindersTable.id, title: gerenteRemindersTable.title, dueAt: gerenteRemindersTable.dueAt, urgent: gerenteRemindersTable.urgent })
      .from(gerenteRemindersTable).where(and(eq(gerenteRemindersTable.tenantId, tenantId), eq(gerenteRemindersTable.status, "pendente"), lt(gerenteRemindersTable.dueAt, end))).orderBy(asc(gerenteRemindersTable.dueAt)).limit(40),
    db.select({ id: gerenteBillsTable.id, kind: gerenteBillsTable.kind, description: gerenteBillsTable.description, amountCents: gerenteBillsTable.amountCents, dueDate: gerenteBillsTable.dueDate })
      .from(gerenteBillsTable).where(and(eq(gerenteBillsTable.tenantId, tenantId), eq(gerenteBillsTable.status, "aberta"))).orderBy(asc(gerenteBillsTable.dueDate)).limit(20),
    db.select({ id: tasksTable.id, title: tasksTable.title, dueDate: tasksTable.dueDate, status: tasksTable.status })
      .from(tasksTable).where(and(eq(tasksTable.tenantId, tenantId), eq(tasksTable.isArchived, false), ne(tasksTable.status, "done"))).orderBy(asc(tasksTable.dueDate)).limit(40),
  ]);
  const ids = tasks.map((t) => t.id);
  const who = ids.length ? await db.select({ taskId: taskAssigneesTable.taskId, name: usersTable.name }).from(taskAssigneesTable).innerJoin(usersTable, eq(usersTable.id, taskAssigneesTable.userId)).where(inArray(taskAssigneesTable.taskId, ids)) : [];
  const recentDone = await db.select({ taskId: gerenteTaskDispatchesTable.taskId, title: tasksTable.title, who: gerenteTaskDispatchesTable.assigneeName, doneAt: gerenteTaskDispatchesTable.doneAt })
    .from(gerenteTaskDispatchesTable).innerJoin(tasksTable, eq(tasksTable.id, gerenteTaskDispatchesTable.taskId))
    .where(and(eq(gerenteTaskDispatchesTable.tenantId, tenantId), eq(gerenteTaskDispatchesTable.status, "concluida"), gte(gerenteTaskDispatchesTable.doneAt, new Date(start.getTime() - 2 * 86_400_000))))
    .orderBy(desc(gerenteTaskDispatchesTable.doneAt)).limit(20);
  res.json({
    scope: "dia", expiresAt: link.expiresAt, today, events, reminders, bills,
    tasks: tasks.map((t) => ({ ...t, assignees: who.filter((w) => w.taskId === t.id).map((w) => w.name.trim().split(" ")[0]) })),
    recentDone,
  });
});

// Abre uma tarefa a partir do link do dia (o link do dia cobre as tarefas da loja).
router.get("/gerente-public/:token/task/:id", async (req, res): Promise<void> => {
  const link = await resolveLink(String(req.params["token"]));
  const id = Number(req.params["id"]);
  if (!link || !Number.isInteger(id) || (link.scope === "task" && link.refId !== id)) { res.status(404).json({ error: "Link inválido ou expirado." }); return; }
  const task = await taskView(link.tenantId, id);
  if (!task) { res.status(404).json({ error: "Tarefa não encontrada." }); return; }
  res.setHeader("Cache-Control", "no-store");
  res.json({ scope: "task", expiresAt: link.expiresAt, task });
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
