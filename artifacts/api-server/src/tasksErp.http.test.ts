// Quadro de tarefas unificado (19/10/2026): "Mudar tarefas para o ERP" e o
// quadro lendo/gravando no ERP, de ponta a ponta pela API (banco de dev +
// um ERP de mentira em memória).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import http from "node:http";

process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";
process.env["SESSION_SECRET"] ??= "tasks-erp-test-secret";
process.env["OPENAI_API_KEY"] ??= "sk-fake-test";
process.env["WHATSAPP_BRIDGE_URL"] ??= "http://localhost:3002";
process.env["NODE_ENV"] ??= "development";
if (process.env["DATABASE_URL"]!.includes("prod")) throw new Error("DATABASE_URL parece de produção — abortando.");

const {
  db, tenantsTable, usersTable, appSettingsTable, tasksTable, taskAssigneesTable, taskCommentsTable,
  taskSubtasksTable, taskRemindersTable, taskNotificationsTable, tenantErpIntegrationsTable, OPTIONAL_MODULES,
} = await import("@workspace/db");
const { eq, inArray } = await import("drizzle-orm");
const { encryptErpSecret } = await import("./lib/erpCrypto");
const { generateTaskReminders } = await import("./lib/taskReminders");
const { default: app } = await import("./app.ts");

const MARK = "__TASKS_ERP_TEST__";
const KEY = "erp_0123456789ab_TESTE-TAREFAS-CHAVE-0123456789";
let server: http.Server;
let erp: http.Server;
let baseUrl: string;
let tenantId: number;
let anaId: number;
let localTaskId: number;

// ─── ERP de mentira ─────────────────────────────────────────────────────────
type Fake = Record<string, any>;
const store: { tasks: Fake[]; calls: { method: string; path: string; body: any }[]; read: any[] } = { tasks: [], calls: [], read: [] };
const view = (t: Fake) => ({ ...t, subtasks: undefined, comments: undefined, subtaskTotal: t.subtasks.length, subtaskDone: t.subtasks.filter((s: Fake) => s.isDone).length, commentCount: t.comments.length });

function startErp(): Promise<number> {
  erp = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url!, "http://x");
    const p = url.pathname.replace(/^\/integrations\/tasks/, "");
    store.calls.push({ method: req.method!, path: p, body });
    const send = (status: number, data: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.headers["x-api-key"] !== KEY) return send(401, { message: "Chave inválida" });
    const m = p.match(/^\/(\d+)(\/.*)?$/);
    const t = m ? store.tasks.find((x) => x.number === Number(m[1])) : null;
    if (req.method === "POST" && p === "/import") {
      let created = 0;
      for (const it of body.items) {
        if (store.tasks.some((x) => x.crmTaskId === it.crmTaskId)) continue;
        created++;
        store.tasks.push({
          id: `uuid-${it.crmTaskId}`, number: it.crmTaskId, crmTaskId: it.crmTaskId, title: it.title, description: it.details ?? null,
          status: it.status, priority: it.priority, dueDate: it.dueDate ?? null, durationMinutes: null, alertMinutesBefore: null,
          position: 0, sectorName: it.sectorName ?? null, crmSectorId: it.crmSectorId ?? null, contactName: null, contactPhone: null,
          crmContactId: null, origin: "crm", createdAt: it.createdAt, updatedAt: it.updatedAt,
          createdBy: it.createdBy ? { userId: null, name: it.createdBy.displayName, email: it.createdBy.email ?? null } : null,
          assignees: it.assignees.map((a: Fake, i: number) => ({ id: `as-${i}`, userId: null, name: a.displayName, email: a.email ?? null })),
          subtasks: it.subtasks.map((s: Fake) => ({ id: `11111111-1111-1111-1111-11111111111${s.crmSubtaskId % 10}`, title: s.title, isDone: s.isDone, position: s.position, createdAt: it.createdAt })),
          comments: it.comments.map((c: Fake) => ({ id: `c-${c.crmCommentId}`, authorName: c.author?.displayName ?? null, authorEmail: c.author?.email ?? null, origin: "crm", content: c.content, fileName: null, mimeType: null, hasFile: false, createdAt: c.createdAt })),
        });
      }
      return send(200, { tasks: body.items.length, created, existing: body.items.length - created, comments: 1, subtasks: 1, files: 0, fileErrors: 0, assigneesLinked: 0, peopleWithoutErpUser: ["Ana"] });
    }
    if (req.method === "GET" && p === "") return send(200, store.tasks.map(view));
    if (req.method === "GET" && p === "/people") return send(200, [{ id: "e1", name: "Admin", email: "admin@tasks-erp.invalid" }]);
    if (req.method === "GET" && p === "/notifications") {
      return send(200, url.searchParams.get("email") === "ana@tasks-erp.invalid"
        ? [{ id: "22222222-2222-2222-2222-222222222222", kind: "daily", title: "Vence hoje: X", taskNumber: localTaskId, dueDate: null, createdAt: "2026-10-19T10:00:00Z" },
           { id: "33333333-3333-3333-3333-333333333333", kind: "comment", title: "Comentou", taskNumber: localTaskId, dueDate: null, createdAt: "2026-10-19T10:00:00Z" }]
        : []);
    }
    if (req.method === "POST" && p === "/notifications/read") { store.read.push(body); return send(200, { updated: 1 }); }
    if (req.method === "POST" && p === "") {
      const number = Math.max(0, ...store.tasks.map((x) => x.number)) + 1;
      const nt = {
        id: `uuid-${number}`, number, crmTaskId: null, title: body.title, description: body.details ?? null, status: body.status ?? "todo",
        priority: body.priority ?? "media", dueDate: body.dueDate ?? null, durationMinutes: null, alertMinutesBefore: null, position: 0,
        sectorName: body.sectorName ?? null, crmSectorId: body.crmSectorId ?? null, contactName: null, contactPhone: null, crmContactId: null,
        origin: "crm", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        createdBy: { userId: null, name: body.actor.actorName, email: body.actor.actorEmail ?? null },
        assignees: (body.assignees ?? []).map((a: Fake, i: number) => ({ id: `n-${i}`, userId: null, name: a.displayName, email: a.email ?? null })),
        subtasks: [], comments: [],
      };
      store.tasks.push(nt);
      return send(201, view(nt));
    }
    if (!t) return send(404, { message: "Tarefa não encontrada." });
    if (req.method === "GET" && !m![2]) return send(200, t);
    if (req.method === "PATCH" && !m![2]) {
      if (body.status === "done" && t.assignees.length && !t.assignees.some((a: Fake) => a.email === body.actor.actorEmail)) {
        return send(403, { message: "Somente um dos responsáveis pela tarefa pode concluí-la." });
      }
      Object.assign(t, body.status ? { status: body.status } : {});
      return send(200, view(t));
    }
    if (req.method === "POST" && m![2] === "/comments") {
      const c = { id: "44444444-4444-4444-4444-444444444444", authorName: body.actor.actorName, authorEmail: body.actor.actorEmail, origin: "crm", content: body.content, fileName: null, mimeType: null, hasFile: false, createdAt: new Date().toISOString() };
      t.comments.push(c);
      return send(201, c);
    }
    if (req.method === "POST" && m![2] === "/archive") { store.tasks = store.tasks.filter((x) => x !== t); return send(200, { ok: true }); }
    return send(404, { message: "rota" });
  });
  return new Promise((r) => erp.listen(0, () => r((erp.address() as import("node:net").AddressInfo).port)));
}

function client() {
  let cookie = "";
  return async (method: string, p: string, body?: unknown) => {
    const res = await fetch(baseUrl + p, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0]!;
    let json: any = null;
    try { json = await res.json(); } catch { /* sem json */ }
    return { status: res.status, body: json };
  };
}

async function wipe() {
  const t = await db.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.name, MARK));
  const ids = t.map((x) => x.id);
  if (!ids.length) return;
  const taskIds = (await db.select({ id: tasksTable.id }).from(tasksTable).where(inArray(tasksTable.tenantId, ids))).map((x) => x.id);
  if (taskIds.length) {
    await db.delete(taskNotificationsTable).where(inArray(taskNotificationsTable.taskId, taskIds));
    await db.delete(taskCommentsTable).where(inArray(taskCommentsTable.taskId, taskIds));
    await db.delete(taskSubtasksTable).where(inArray(taskSubtasksTable.taskId, taskIds));
    await db.delete(taskAssigneesTable).where(inArray(taskAssigneesTable.taskId, taskIds));
    await db.delete(taskRemindersTable).where(inArray(taskRemindersTable.taskId, taskIds));
    await db.delete(tasksTable).where(inArray(tasksTable.id, taskIds));
  }
  await db.delete(tenantErpIntegrationsTable).where(inArray(tenantErpIntegrationsTable.tenantId, ids));
  await db.delete(appSettingsTable).where(inArray(appSettingsTable.tenantId, ids));
  await db.delete(usersTable).where(inArray(usersTable.tenantId, ids));
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
}

const admin = client();
const ana = client();

before(async () => {
  await wipe();
  const erpPort = await startErp();
  const [tenant] = await db.insert(tenantsTable).values({ name: MARK, enabledModules: [...OPTIONAL_MODULES] }).returning();
  tenantId = tenant!.id;
  const hash = await bcrypt.hash("SenhaForte123!", 10);
  const [, a] = await db.insert(usersTable).values([
    { tenantId, name: "Admin", email: "admin@tasks-erp.invalid", passwordHash: hash, role: "admin", isActive: true },
    { tenantId, name: "Ana", email: "ana@tasks-erp.invalid", passwordHash: hash, role: "supervisor", isActive: true, moduleAccess: { tarefas: "edit" } },
  ]).returning();
  anaId = a!.id;
  const [adminRow] = await db.select().from(usersTable).where(eq(usersTable.email, "admin@tasks-erp.invalid"));
  const [task] = await db.insert(tasksTable).values({
    tenantId, title: "Cobrar fornecedor", status: "doing", priority: "alta", createdById: adminRow!.id,
    dueDate: new Date(Date.now() + 5 * 60_000), alertMinutesBefore: 15,
  }).returning();
  localTaskId = task!.id;
  await db.insert(taskAssigneesTable).values({ tenantId, taskId: localTaskId, userId: anaId });
  await db.insert(taskCommentsTable).values({ tenantId, taskId: localTaskId, authorId: anaId, content: "Liguei, sem resposta" });
  await db.insert(taskSubtasksTable).values({ tenantId, taskId: localTaskId, title: "Mandar e-mail", isDone: true, position: 1 });
  const enc = encryptErpSecret(KEY);
  await db.insert(tenantErpIntegrationsTable).values({
    tenantId, baseUrl: `http://127.0.0.1:${erpPort}`, encryptedApiKey: enc.ciphertext, iv: enc.iv, authTag: enc.authTag,
    keyVersion: enc.keyVersion, last4: KEY.slice(-4), erpWebUrl: "https://erp.exemplo.invalid",
  });
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api`;
  assert.equal((await admin("POST", "/auth/login", { email: "admin@tasks-erp.invalid", password: "SenhaForte123!" })).status, 200);
  assert.equal((await ana("POST", "/auth/login", { email: "ana@tasks-erp.invalid", password: "SenhaForte123!" })).status, 200);
});

after(async () => {
  await wipe();
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => erp.close(() => r()));
});

test("sem a mudança, o quadro é o de sempre (tabelas do CRM)", async () => {
  const r = await admin("GET", "/tasks");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((t: any) => t.id), [localTaskId]);
  assert.equal((await admin("GET", "/tasks/erp-status")).body.moved, false);
});

test("só admin muda as tarefas para o ERP", async () => {
  assert.equal((await ana("POST", "/settings/erp/tasks/move")).status, 403);
});

test("Mudar tarefas para o ERP: manda tudo (pessoas por e-mail, comentário, subtarefa) e liga", async () => {
  const r = await admin("POST", "/settings/erp/tasks/move");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.moved, true);
  assert.equal(r.body.report.created, 1);
  const imp = store.calls.find((c) => c.path === "/import")!.body.items[0];
  assert.equal(imp.crmTaskId, localTaskId);
  assert.deepEqual(imp.assignees, [{ displayName: "Ana", email: "ana@tasks-erp.invalid" }]);
  assert.deepEqual(imp.createdBy, { displayName: "Admin", email: "admin@tasks-erp.invalid" });
  assert.equal(imp.comments[0].content, "Liguei, sem resposta");
  assert.deepEqual(imp.comments[0].author, { displayName: "Ana", email: "ana@tasks-erp.invalid" });
  assert.equal(imp.subtasks[0].isDone, true);
  // Repetir não duplica.
  const again = await admin("POST", "/settings/erp/tasks/import");
  assert.equal(again.body.report.created, 0);
  const st = await admin("GET", "/settings/erp/tasks");
  assert.equal(st.body.moved, true);
  assert.equal(st.body.erpUrl, "https://erp.exemplo.invalid/tarefas");
});

test("com as tarefas no ERP, o quadro lê de lá (mesmo número) e cada um vê as suas", async () => {
  store.tasks.push({
    id: "uuid-900", number: 900, crmTaskId: null, title: "Só do gerente", description: null, status: "todo", priority: "media",
    dueDate: null, durationMinutes: null, alertMinutesBefore: null, position: 0, sectorName: null, crmSectorId: null,
    contactName: null, contactPhone: null, crmContactId: null, origin: "erp", createdAt: "2026-10-19T10:00:00Z", updatedAt: "2026-10-19T10:00:00Z",
    createdBy: { userId: "e9", name: "Gerente ERP", email: "gerente@erp.invalid" }, assignees: [], subtasks: [], comments: [],
  });
  const all = await admin("GET", "/tasks");
  assert.deepEqual(all.body.map((t: any) => t.id).sort(), [localTaskId, 900].sort());
  const mine = await ana("GET", "/tasks");
  assert.deepEqual(mine.body.map((t: any) => t.id), [localTaskId]);
  assert.deepEqual(mine.body[0].assignees, [{ id: anaId, name: "Ana" }]);
  assert.equal(mine.body[0].subtaskDone, 1);
  assert.equal((await ana("GET", "/tasks/900/comments")).status, 403);
  assert.equal((await admin("GET", "/tasks/erp-status")).body.moved, true);
});

test("mover/concluir vai para o ERP com quem fez; só o responsável conclui", async () => {
  const no = await admin("PATCH", `/tasks/${localTaskId}`, { status: "done" });
  assert.equal(no.status, 403);
  assert.match(no.body.error, /responsáveis/);
  const ok = await ana("PATCH", `/tasks/${localTaskId}`, { status: "done" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, "done");
  const patch = store.calls.filter((c) => c.method === "PATCH").pop()!;
  assert.deepEqual(patch.body.actor, { actorName: "Ana", actorEmail: "ana@tasks-erp.invalid" });
});

test("criar e comentar pelo CRM grava no ERP; responsáveis pelo e-mail", async () => {
  const r = await admin("POST", "/tasks", { title: "Conferir estoque", assigneeIds: [anaId], priority: "alta" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const created = store.calls.filter((c) => c.method === "POST" && c.path === "").pop()!.body;
  assert.deepEqual(created.assignees, [{ displayName: "Ana", email: "ana@tasks-erp.invalid" }]);
  assert.equal(created.actor.actorEmail, "admin@tasks-erp.invalid");
  assert.deepEqual(r.body.assignees, [{ id: anaId, name: "Ana" }]);
  const c = await ana("POST", `/tasks/${r.body.id}/comments`, { content: "Vou ver amanhã" });
  assert.equal(c.status, 201);
  assert.equal(c.body.authorId, anaId);
  const comments = await ana("GET", `/tasks/${r.body.id}/comments`);
  assert.deepEqual(comments.body.map((x: any) => x.content), ["Vou ver amanhã"]);
  assert.equal((await admin("DELETE", `/tasks/${r.body.id}`)).status, 200);
});

test("avisos vêm do ERP pelo e-mail de quem está logado", async () => {
  const rem = await ana("GET", "/tasks/reminders/unread");
  assert.deepEqual(rem.body.map((x: any) => [x.id, x.taskId, x.title]), [["22222222-2222-2222-2222-222222222222", localTaskId, "Vence hoje: X"]]);
  const unread = await ana("GET", "/tasks/notifications/unread");
  assert.deepEqual(unread.body.taskIds, [localTaskId]);
  await ana("POST", "/tasks/reminders/22222222-2222-2222-2222-222222222222/read");
  assert.deepEqual(store.read.pop(), { email: "ana@tasks-erp.invalid", id: "22222222-2222-2222-2222-222222222222" });
});

test("os lembretes do CRM não disparam para quem mudou as tarefas para o ERP (sem aviso duplicado)", async () => {
  await generateTaskReminders();
  const rows = await db.select().from(taskRemindersTable).where(eq(taskRemindersTable.tenantId, tenantId));
  assert.equal(rows.length, 0);
});

test("voltar para o CRM: o quadro volta a ler as tabelas daqui", async () => {
  assert.equal((await admin("POST", "/settings/erp/tasks/back")).status, 200);
  const r = await admin("GET", "/tasks");
  assert.deepEqual(r.body.map((t: any) => t.id), [localTaskId]);
});
