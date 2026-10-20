import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { Readable } from "node:stream";
import { and, eq, sql } from "drizzle-orm";
import { db, crmContactsTable, sectorsTable, tasksTable, usersTable } from "@workspace/db";
import { isGlobalRole, requireAdmin, requireAuth, requireTenant, tenantIdOf } from "../middlewares/auth";
import {
  assigneesForErp,
  buildCrmReport,
  canSeeErpTask,
  commentToCrm,
  erpPost,
  erpTasks,
  erpTasksConn,
  erpTasksRaw,
  ErpTasksError,
  importTasksToErp,
  lastImport,
  loadCrmCtx,
  setTasksMoved,
  tasksMoved,
  TASKS_MOVED_AT_KEY,
  toCrmTask,
  type ErpConn,
  type ErpTask,
  type ErpTaskDetail,
  type ErpTaskNotice,
} from "../lib/erpTasks";
import { appSetting } from "../lib/tradeInMoved";
import { scheduleClientMessageForTask } from "../lib/taskClientMessage";
import { logger } from "../lib/logger";

// Quadro de tarefas unificado (19/10/2026) — ver lib/erpTasks.ts.
// 1) Configurações › Integrações › ERP: "Mudar tarefas para o ERP" (admin)
//    manda todas as tarefas daqui para o ERP e liga a mudança.
// 2) Ligado, as rotas /tasks do quadro leem e gravam no ERP (mesmo formato
//    de resposta de antes, para a tela não mudar). Desligado, este router
//    passa a vez e as rotas de sempre (routes/tasks.ts) respondem.

const router: IRouter = Router();

const ALLOWED_MIMES: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

function conn(res: Response): ErpConn {
  return res.locals.erpTasksConn as ErpConn;
}

function fail(res: Response, err: unknown): void {
  if (err instanceof ErpTasksError) {
    res.status(err.status >= 500 ? 502 : err.status).json({ error: err.message });
    return;
  }
  logger.warn({ err }, "Tarefas no ERP: falha");
  res.status(502).json({ error: "Não deu para falar com o ERP agora. Tente de novo em instantes." });
}

async function me(req: Request) {
  const [u] = await db.select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
    .from(usersTable).where(eq(usersTable.id, req.session.userId!)).limit(1);
  return u ?? { id: req.session.userId!, name: "Usuário do CRM", email: "" };
}

async function actorOf(req: Request) {
  const u = await me(req);
  return { actorName: u.name.slice(0, 120), ...(u.email ? { actorEmail: u.email.trim().toLowerCase() } : {}) };
}

function idParam(req: Request, res: Response): number | null {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id) || id <= 0) { res.status(400).json({ error: "ID inválido" }); return null; }
  return id;
}

/** Busca a tarefa no ERP e confere se quem pede pode mexer (mesma regra do quadro daqui). */
async function loadWithAccess(req: Request, res: Response, number: number): Promise<ErpTaskDetail | null> {
  const t = await erpTasks<ErpTaskDetail>(conn(res), `/${number}`);
  const u = await me(req);
  if (!canSeeErpTask(t, { email: u.email, isAdmin: req.session.userRole === "admin" })) {
    res.status(403).json({ error: "Acesso negado" });
    return null;
  }
  return t;
}

// ─── Situação (o quadro mostra o aviso "as tarefas moram no ERP") ──────────

router.get("/tasks/erp-status", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const moved = await tasksMoved(tenantId);
  const c = moved ? await erpTasksConn(tenantId) : null;
  res.json({ moved, erpUrl: c?.webUrl ? `${c.webUrl}/tarefas` : null });
});

// ─── Porta: só segue daqui se as tarefas estão no ERP ───────────────────────

async function gate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const tenantId = tenantIdOf(req);
  if (tenantId == null) return next("router");
  try {
    if (!(await tasksMoved(tenantId))) return next("router");
  } catch {
    return next("router");
  }
  const c = await erpTasksConn(tenantId);
  if (!c) {
    res.status(409).json({ error: "As tarefas estão no ERP, mas a ligação com o ERP foi removida. Peça ao administrador para colar a chave do ERP de novo em Configurações › Integrações." });
    return;
  }
  res.locals.erpTasksConn = c;
  next();
}

router.use("/tasks", requireAuth, (req, res, next) => { void gate(req, res, next); });

// ─── Lista e relatório ──────────────────────────────────────────────────────

async function visibleTasks(req: Request, res: Response, tenantId: number) {
  const rows = await erpTasks<ErpTask[]>(conn(res), "");
  const u = await me(req);
  const isAdmin = req.session.userRole === "admin";
  const visible = rows.filter((t) => canSeeErpTask(t, { email: u.email, isAdmin }));
  const ctx = await loadCrmCtx(tenantId, visible.map((t) => t.crmContactId ?? 0));
  return visible.map((t) => toCrmTask(t, ctx));
}

router.get("/tasks", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  try { res.json(await visibleTasks(req, res, tenantId)); } catch (err) { fail(res, err); }
});

router.get("/tasks/report", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  try { res.json(buildCrmReport(await visibleTasks(req, res, tenantId))); } catch (err) { fail(res, err); }
});

// ─── Avisos (do ERP, pelo e-mail de quem está logado) ──────────────────────

async function notices(req: Request, res: Response): Promise<ErpTaskNotice[]> {
  const u = await me(req);
  if (!u.email) return [];
  return erpTasks<ErpTaskNotice[]>(conn(res), `/notifications?email=${encodeURIComponent(u.email.trim().toLowerCase())}`);
}

router.get("/tasks/notifications/unread", async (req, res): Promise<void> => {
  try {
    const list = await notices(req, res);
    res.json({ taskIds: [...new Set(list.filter((n) => n.kind === "comment").map((n) => n.taskNumber))] });
  } catch (err) { fail(res, err); }
});

router.get("/tasks/reminders/unread", async (req, res): Promise<void> => {
  try {
    const list = await notices(req, res);
    res.json(list.filter((n) => n.kind !== "comment").slice(0, 20).map((n) => ({
      id: n.id, taskId: n.taskNumber, title: n.title, dueDate: n.dueDate ?? n.createdAt, read: false, createdAt: n.createdAt,
    })));
  } catch (err) { fail(res, err); }
});

router.post("/tasks/reminders/:id/read", async (req, res): Promise<void> => {
  const u = await me(req);
  const id = String(req.params.id);
  if (!u.email || !/^[0-9a-f-]{36}$/i.test(id)) { res.json({ ok: true }); return; }
  try {
    await erpPost(conn(res), "/notifications/read", { email: u.email.trim().toLowerCase(), id });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

router.post("/tasks/:id/notifications/read", async (req, res): Promise<void> => {
  const n = idParam(req, res); if (n == null) return;
  const u = await me(req);
  if (!u.email) { res.json({ ok: true }); return; }
  try {
    await erpPost(conn(res), "/notifications/read", { email: u.email.trim().toLowerCase(), taskNumber: n, kinds: ["comment"] });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

// ─── Comentários ────────────────────────────────────────────────────────────

router.get("/tasks/:id/comments", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const n = idParam(req, res); if (n == null) return;
  try {
    const t = await loadWithAccess(req, res, n); if (!t) return;
    const ctx = await loadCrmCtx(tenantId);
    res.json(t.comments.map((c) => commentToCrm(c, n, ctx)));
  } catch (err) { fail(res, err); }
});

router.post("/tasks/:id/comments", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const n = idParam(req, res); if (n == null) return;
  const { content, mediaBase64, mediaMimetype } = req.body as { content?: string; mediaBase64?: string; mediaMimetype?: string };
  const text = (content ?? "").trim();
  if (!text && !mediaBase64) { res.status(400).json({ error: "Comentário vazio" }); return; }
  let file: { fileName: string; mimeType: string; dataBase64: string } | null = null;
  if (mediaBase64 && mediaMimetype) {
    const mime = mediaMimetype.split(";")[0]!.trim().toLowerCase();
    const ext = ALLOWED_MIMES[mime];
    if (!ext) { res.status(400).json({ error: "Tipo de arquivo não suportado" }); return; }
    if (Buffer.byteLength(mediaBase64, "base64") > 15 * 1024 * 1024) { res.status(400).json({ error: "Arquivo muito grande (máximo 15 MB)" }); return; }
    file = { fileName: `anexo.${ext}`, mimeType: mime, dataBase64: mediaBase64 };
  }
  try {
    const t = await loadWithAccess(req, res, n); if (!t) return;
    const c = await erpPost<ErpTaskDetail["comments"][number]>(conn(res), `/${n}/comments`, {
      actor: await actorOf(req), content: text.slice(0, 2000), ...(file ?? {}),
    });
    res.status(201).json(commentToCrm(c, n, await loadCrmCtx(tenantId)));
  } catch (err) { fail(res, err); }
});

router.get("/tasks/:id/comments/:commentId/file", async (req, res): Promise<void> => {
  const n = idParam(req, res); if (n == null) return;
  const commentId = String(req.params.commentId);
  if (!/^[0-9a-f-]{36}$/i.test(commentId)) { res.status(400).json({ error: "Anexo inválido" }); return; }
  try {
    const t = await loadWithAccess(req, res, n); if (!t) return;
    const r = await erpTasksRaw(conn(res), `/${n}/comments/${commentId}/file`);
    for (const h of ["content-type", "content-disposition", "x-content-type-options", "content-security-policy"]) {
      const v = r.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!r.body) { res.end(); return; }
    Readable.fromWeb(r.body as unknown as import("node:stream/web").ReadableStream).pipe(res);
  } catch (err) { fail(res, err); }
});

// ─── Subtarefas ─────────────────────────────────────────────────────────────

router.get("/tasks/:id/subtasks", async (req, res): Promise<void> => {
  const n = idParam(req, res); if (n == null) return;
  try {
    const t = await loadWithAccess(req, res, n); if (!t) return;
    res.json(t.subtasks.map((s) => ({ ...s, taskId: n })));
  } catch (err) { fail(res, err); }
});

router.post("/tasks/:id/subtasks", async (req, res): Promise<void> => {
  const n = idParam(req, res); if (n == null) return;
  const title = String((req.body as { title?: string }).title ?? "").trim();
  if (!title) { res.status(400).json({ error: "Título é obrigatório" }); return; }
  try {
    const t = await loadWithAccess(req, res, n); if (!t) return;
    const s = await erpPost<object>(conn(res), `/${n}/subtasks`, { actor: await actorOf(req), title: title.slice(0, 300) });
    res.status(201).json({ ...s, taskId: n });
  } catch (err) { fail(res, err); }
});

router.patch("/tasks/:id/subtasks/:subId", async (req, res): Promise<void> => {
  const n = idParam(req, res); if (n == null) return;
  const subId = String(req.params.subId);
  if (!/^[0-9a-f-]{36}$/i.test(subId)) { res.status(404).json({ error: "Subtarefa não encontrada" }); return; }
  const { isDone, title, position } = req.body as { isDone?: boolean; title?: string; position?: number };
  const body: Record<string, unknown> = {};
  if (isDone !== undefined) body.isDone = !!isDone;
  if (title !== undefined && String(title).trim()) body.title = String(title).trim().slice(0, 300);
  if (position !== undefined && Number.isInteger(position)) body.position = position;
  if (Object.keys(body).length === 0) { res.status(400).json({ error: "Nada para atualizar" }); return; }
  try {
    const t = await loadWithAccess(req, res, n); if (!t) return;
    const s = await erpPost<object>(conn(res), `/${n}/subtasks/${subId}`, { actor: await actorOf(req), ...body }, "PATCH");
    res.json({ ...s, taskId: n });
  } catch (err) { fail(res, err); }
});

router.delete("/tasks/:id/subtasks/:subId", async (req, res): Promise<void> => {
  const n = idParam(req, res); if (n == null) return;
  const subId = String(req.params.subId);
  if (!/^[0-9a-f-]{36}$/i.test(subId)) { res.json({ ok: true }); return; }
  try {
    const t = await loadWithAccess(req, res, n); if (!t) return;
    await erpPost(conn(res), `/${n}/subtasks/${subId}/delete`, { actor: await actorOf(req) });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

// ─── Criar, editar, excluir ─────────────────────────────────────────────────

type TaskBody = {
  title?: string; description?: string | null; status?: string; priority?: string;
  assigneeIds?: number[] | null; sectorId?: number | null; dueDate?: string | null;
  position?: number; isArchived?: boolean;
  contactId?: number | null; durationMinutes?: number | null; alertMinutesBefore?: number | null;
  clientMessage?: string | null;
};

async function contactFields(tenantId: number, raw: unknown): Promise<Record<string, unknown> | { error: string }> {
  if (raw == null || raw === "") return { crmContactId: null, contactLabel: null, contactPhone: null };
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return { error: "Cliente inválido" };
  const [c] = await db.select({ id: crmContactsTable.id, name: crmContactsTable.name, contact: crmContactsTable.contact, phone: crmContactsTable.phone })
    .from(crmContactsTable).where(and(eq(crmContactsTable.id, id), eq(crmContactsTable.tenantId, tenantId))).limit(1);
  if (!c) return { error: "Cliente não encontrado" };
  return { crmContactId: c.id, contactLabel: c.name.slice(0, 160), contactPhone: (c.contact ?? c.phone ?? "").slice(0, 40) || null };
}

async function sectorFields(tenantId: number, sectorId: number | null): Promise<Record<string, unknown>> {
  if (sectorId == null) return { crmSectorId: null, sectorName: null };
  const [s] = await db.select({ id: sectorsTable.id, name: sectorsTable.name }).from(sectorsTable)
    .where(and(eq(sectorsTable.id, sectorId), eq(sectorsTable.tenantId, tenantId))).limit(1);
  return s ? { crmSectorId: s.id, sectorName: s.name.slice(0, 80) } : { crmSectorId: null, sectorName: null };
}

function minutes(raw: unknown, max: number): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.round(n), max);
}

async function buildErpBody(req: Request, tenantId: number, body: TaskBody, current: ErpTaskDetail | null) {
  const out: Record<string, unknown> = {};
  if (body.title !== undefined) out.title = String(body.title).trim().slice(0, 200);
  if (body.description !== undefined) out.details = body.description ? String(body.description).slice(0, 5000) : null;
  if (body.status !== undefined && ["todo", "doing", "done"].includes(body.status)) out.status = body.status;
  if (body.priority !== undefined && ["baixa", "media", "alta"].includes(body.priority)) out.priority = body.priority;
  if (body.dueDate !== undefined) out.dueDate = body.dueDate ? new Date(body.dueDate).toISOString() : null;
  if (body.position !== undefined && Number.isInteger(body.position)) out.position = body.position;
  if (body.durationMinutes !== undefined) out.durationMinutes = minutes(body.durationMinutes, 24 * 60);
  if (body.alertMinutesBefore !== undefined) out.alertMinutesBefore = minutes(body.alertMinutesBefore, 7 * 24 * 60);
  // Setor: quem não é admin/supervisor fica no próprio setor (igual ao quadro daqui).
  const role = req.session.userRole;
  if (!current) {
    Object.assign(out, await sectorFields(tenantId, isGlobalRole(role) ? (body.sectorId ?? null) : (req.session.userSectorId ?? null)));
  } else if (body.sectorId !== undefined && isGlobalRole(role)) {
    Object.assign(out, await sectorFields(tenantId, body.sectorId ?? null));
  }
  if (body.contactId !== undefined) {
    const c = await contactFields(tenantId, body.contactId);
    if ("error" in c) return { error: c.error as string };
    Object.assign(out, c);
  }
  if (body.assigneeIds !== undefined) {
    const ctx = await loadCrmCtx(tenantId);
    const a = assigneesForErp(body.assigneeIds ?? [], ctx, current);
    if ("error" in a) return { error: a.error };
    out.assignees = a;
  }
  return { body: out };
}

async function respondTask(req: Request, res: Response, tenantId: number, t: ErpTask, clientMessage: string | null | undefined, status = 200) {
  const ctx = await loadCrmCtx(tenantId, [t.crmContactId ?? 0]);
  let clientMessageWarning: string | null = null;
  if (clientMessage?.trim()) {
    clientMessageWarning = await scheduleClientMessageForTask(
      tenantId,
      { id: null, erpTaskNumber: t.number, contactId: t.crmContactId, dueDate: t.dueDate ? new Date(t.dueDate) : null },
      clientMessage,
      req.session.userId ?? null,
    );
  }
  res.status(status).json({ ...toCrmTask(t, ctx), ...(clientMessageWarning ? { clientMessageWarning } : {}) });
}

router.post("/tasks", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const body = req.body as TaskBody;
  if (!body.title || !String(body.title).trim()) { res.status(400).json({ error: "Título é obrigatório" }); return; }
  try {
    const built = await buildErpBody(req, tenantId, body, null);
    if ("error" in built) { res.status(400).json({ error: built.error }); return; }
    const t = await erpPost<ErpTask>(conn(res), "", { actor: await actorOf(req), ...built.body });
    await respondTask(req, res, tenantId, t, body.clientMessage, 201);
  } catch (err) { fail(res, err); }
});

router.patch("/tasks/:id", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const n = idParam(req, res); if (n == null) return;
  const body = req.body as TaskBody;
  try {
    const current = await loadWithAccess(req, res, n); if (!current) return;
    if (body.isArchived === true) {
      await erpPost(conn(res), `/${n}/archive`, { actor: await actorOf(req) });
      res.json({ ...toCrmTask(current, await loadCrmCtx(tenantId)), isArchived: true });
      return;
    }
    const built = await buildErpBody(req, tenantId, body, current);
    if ("error" in built) { res.status(400).json({ error: built.error }); return; }
    const t = await erpPost<ErpTask>(conn(res), `/${n}`, { actor: await actorOf(req), ...built.body }, "PATCH");
    await respondTask(req, res, tenantId, t, body.clientMessage);
  } catch (err) { fail(res, err); }
});

router.delete("/tasks/:id", async (req, res): Promise<void> => {
  const n = idParam(req, res); if (n == null) return;
  try {
    const t = await loadWithAccess(req, res, n); if (!t) return;
    await erpPost(conn(res), `/${n}/archive`, { actor: await actorOf(req) });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

// ─── Configurações › Integrações › ERP: mudar as tarefas para o ERP ─────────

router.get("/settings/erp/tasks", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(tasksTable)
    .where(and(eq(tasksTable.tenantId, tenantId), eq(tasksTable.isArchived, false)));
  const c = await erpTasksConn(tenantId);
  res.json({
    moved: await tasksMoved(tenantId),
    movedAt: await appSetting(tenantId, TASKS_MOVED_AT_KEY),
    configured: !!c,
    erpUrl: c?.webUrl ? `${c.webUrl}/tarefas` : null,
    localTasks: count,
    lastImport: await lastImport(tenantId),
  });
});

/** Testa se a chave tem o acesso "Quadro de tarefas" (lista as pessoas do ERP). */
router.post("/settings/erp/tasks/check", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const c = await erpTasksConn(tenantId);
  if (!c) { res.status(400).json({ error: "Cole a chave do ERP primeiro (card acima)." }); return; }
  try {
    const people = await erpTasks<{ email: string }[]>(c, "/people");
    const ctx = await loadCrmCtx(tenantId);
    const erpEmails = new Set(people.map((p) => (p.email ?? "").trim().toLowerCase()));
    const withoutPair = ctx.users.filter((u) => !erpEmails.has((u.email ?? "").trim().toLowerCase())).map((u) => u.name);
    res.json({ ok: true, erpUsers: people.length, crmUsersWithoutErpUser: withoutPair });
  } catch (err) { fail(res, err); }
});

async function runImport(req: Request, res: Response, thenMove: boolean): Promise<void> {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const c = await erpTasksConn(tenantId);
  if (!c) { res.status(400).json({ error: "Cole a chave do ERP primeiro (card acima)." }); return; }
  try {
    const report = await importTasksToErp(tenantId, c);
    if (thenMove) await setTasksMoved(tenantId, true);
    res.json({ ok: true, report, moved: thenMove || (await tasksMoved(tenantId)) });
  } catch (err) { fail(res, err); }
}

router.post("/settings/erp/tasks/move", requireAdmin, (req, res) => { void runImport(req, res, true); });
router.post("/settings/erp/tasks/import", requireAdmin, (req, res) => { void runImport(req, res, false); });

router.post("/settings/erp/tasks/back", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  await setTasksMoved(tenantId, false);
  res.json({ ok: true, moved: false });
});

export default router;
