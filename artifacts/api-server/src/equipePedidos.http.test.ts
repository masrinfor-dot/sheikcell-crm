// Tela "Equipe" (chat interno + pedidos, 29/10/2026), de ponta a ponta pela API:
//  - "Esperando alguém" no quadro (PATCH /tasks/:id { waitingFor }) com as
//    tarefas no CRM e com as tarefas no ERP (fica guardado no CRM);
//  - "sem resposta há X" na lista de conversas do chat interno.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import http from "node:http";

process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";
process.env["SESSION_SECRET"] ??= "equipe-test-secret";
process.env["OPENAI_API_KEY"] ??= "sk-fake-test";
process.env["WHATSAPP_BRIDGE_URL"] ??= "http://localhost:3002";
process.env["NODE_ENV"] ??= "development";
if (process.env["DATABASE_URL"]!.includes("prod")) throw new Error("DATABASE_URL parece de produção — abortando.");

const {
  db, tenantsTable, usersTable, appSettingsTable, tasksTable, taskAssigneesTable, taskWaitingTable,
  tenantErpIntegrationsTable, internalConversationsTable, internalConversationMembersTable, internalMessagesTable, OPTIONAL_MODULES,
} = await import("@workspace/db");
const { eq, inArray } = await import("drizzle-orm");
const { encryptErpSecret } = await import("./lib/erpCrypto");
const { setTasksMoved } = await import("./lib/erpTasks");
const { mentionsName, pendingSince } = await import("./lib/internalPendingReply");
const { waitingChange } = await import("./lib/taskWaiting");
const { default: app } = await import("./app.ts");

const MARK = "__EQUIPE_PEDIDOS_TEST__";
const KEY = "erp_0123456789ab_TESTE-EQUIPE-CHAVE-0123456789";
let server: http.Server;
let erp: http.Server;
let baseUrl: string;
let tenantId: number;
let adminId: number;
let anaId: number;
let caioId: number;
let botId: number;
let taskId: number;

// ─── ERP de mentira (só o que o quadro usa aqui) ────────────────────────────
type Fake = Record<string, any>;
const erpStore: { tasks: Fake[]; calls: { method: string; path: string; body: any }[] } = { tasks: [], calls: [] };

function startErp(): Promise<number> {
  erp = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const p = new URL(req.url!, "http://x").pathname.replace(/^\/integrations\/tasks/, "");
    erpStore.calls.push({ method: req.method!, path: p, body });
    const send = (status: number, data: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.headers["x-api-key"] !== KEY) return send(401, { message: "Chave inválida" });
    if (req.method === "GET" && p === "") return send(200, erpStore.tasks);
    const m = p.match(/^\/(\d+)$/);
    const t = m ? erpStore.tasks.find((x) => x.number === Number(m[1])) : null;
    if (!t) return send(404, { message: "Tarefa não encontrada." });
    if (req.method === "GET") return send(200, { ...t, subtasks: [], comments: [] });
    if (req.method === "PATCH") { if (body.status) t.status = body.status; return send(200, t); }
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
  await db.delete(taskWaitingTable).where(inArray(taskWaitingTable.tenantId, ids));
  const taskIds = (await db.select({ id: tasksTable.id }).from(tasksTable).where(inArray(tasksTable.tenantId, ids))).map((x) => x.id);
  if (taskIds.length) {
    await db.delete(taskAssigneesTable).where(inArray(taskAssigneesTable.taskId, taskIds));
    await db.delete(tasksTable).where(inArray(tasksTable.id, taskIds));
  }
  const convIds = (await db.select({ id: internalConversationsTable.id }).from(internalConversationsTable)
    .where(inArray(internalConversationsTable.tenantId, ids))).map((x) => x.id);
  if (convIds.length) {
    await db.update(internalConversationsTable).set({ pinnedMessageId: null }).where(inArray(internalConversationsTable.id, convIds));
    await db.delete(internalMessagesTable).where(inArray(internalMessagesTable.conversationId, convIds));
    await db.delete(internalConversationMembersTable).where(inArray(internalConversationMembersTable.conversationId, convIds));
    await db.delete(internalConversationsTable).where(inArray(internalConversationsTable.id, convIds));
  }
  await db.delete(tenantErpIntegrationsTable).where(inArray(tenantErpIntegrationsTable.tenantId, ids));
  await db.delete(appSettingsTable).where(inArray(appSettingsTable.tenantId, ids));
  await db.delete(usersTable).where(inArray(usersTable.tenantId, ids));
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
}

const admin = client();
const ana = client();
const caio = client();

before(async () => {
  await wipe();
  const erpPort = await startErp();
  const [tenant] = await db.insert(tenantsTable).values({ name: MARK, enabledModules: [...OPTIONAL_MODULES] }).returning();
  tenantId = tenant!.id;
  const hash = await bcrypt.hash("SenhaForte123!", 10);
  const access = { tarefas: "edit", equipe: "edit" } as const;
  const rows = await db.insert(usersTable).values([
    { tenantId, name: "Samuel Admin", email: "admin@equipe.invalid", passwordHash: hash, role: "admin", isActive: true },
    { tenantId, name: "Lucélia", email: "ana@equipe.invalid", passwordHash: hash, role: "supervisor", isActive: true, moduleAccess: access },
    { tenantId, name: "Caio", email: "caio@equipe.invalid", passwordHash: hash, role: "vendedor", isActive: true, moduleAccess: access },
    { tenantId, name: "Gerente IA", email: "bot@equipe.invalid", passwordHash: "!bot", role: "vendedor", isActive: false },
  ]).returning();
  [adminId, anaId, caioId, botId] = rows.map((r) => r.id) as [number, number, number, number];
  const [task] = await db.insert(tasksTable).values({ tenantId, title: "Orçamento de frete", status: "todo", createdById: adminId }).returning();
  taskId = task!.id;
  await db.insert(taskAssigneesTable).values({ tenantId, taskId, userId: anaId });
  const enc = encryptErpSecret(KEY);
  await db.insert(tenantErpIntegrationsTable).values({
    tenantId, baseUrl: `http://127.0.0.1:${erpPort}`, encryptedApiKey: enc.ciphertext, iv: enc.iv, authTag: enc.authTag,
    keyVersion: enc.keyVersion, last4: KEY.slice(-4), erpWebUrl: "https://erp.exemplo.invalid",
  });
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api`;
  for (const [c, email] of [[admin, "admin"], [ana, "ana"], [caio, "caio"]] as const) {
    assert.equal((await c("POST", "/auth/login", { email: `${email}@equipe.invalid`, password: "SenhaForte123!" })).status, 200);
  }
});

after(async () => {
  await wipe();
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => erp.close(() => r()));
});

// ─── Regras puras ───────────────────────────────────────────────────────────

test("menção do nome com ou sem acento; e-mail e nome parecido não contam", () => {
  assert.equal(mentionsName("@lucelia pode ver?", "Lucélia"), true);
  assert.equal(mentionsName("oi @Lucélia", "Lucelia"), true);
  assert.equal(mentionsName("@Samuel conferir", "Samuel Admin"), true);
  assert.equal(mentionsName("@Samuel Admin conferir", "Samuel Admin"), true);
  assert.equal(mentionsName("@Lucelias", "Lucélia"), false);
  assert.equal(mentionsName("lucelia@loja.com", "Lucélia"), false);
});

test("desde quando deve resposta: direta = 1ª mensagem do outro; grupo = só menção ou resposta a mim", () => {
  const a = new Date("2026-10-29T10:00:00Z"), b = new Date("2026-10-29T10:05:00Z");
  const me = { id: 7, name: "Caio" };
  assert.equal(pendingSince("direct", [{ createdAt: a, content: "oi", replyToSenderId: null }], me), a);
  assert.equal(pendingSince("group", [{ createdAt: a, content: "bom dia", replyToSenderId: null }], me), null);
  assert.equal(pendingSince("group", [
    { createdAt: a, content: "bom dia", replyToSenderId: null },
    { createdAt: b, content: "@caio viu?", replyToSenderId: null },
  ], me), b);
  assert.equal(pendingSince("general", [{ createdAt: a, content: "isso", replyToSenderId: 7 }], me), a);
});

test("esperando: mudar o status sem dizer nada tira; mesmo status não mexe", () => {
  assert.equal(waitingChange({ waitingFor: "  Transportadora " }, "doing"), "Transportadora");
  assert.equal(waitingChange({ waitingFor: "" }, "doing"), "alguém");
  assert.equal(waitingChange({ waitingFor: null }, "doing"), null);
  assert.equal(waitingChange({ status: "done" }, "doing"), null);
  assert.equal(waitingChange({ status: "doing" }, "doing"), undefined);
  assert.equal(waitingChange({ title: "x" } as never, "doing"), undefined);
});

// ─── Quadro com as tarefas no CRM ───────────────────────────────────────────

test("CRM: 'Esperando alguém' grava, aparece na lista e sai ao voltar a fazer", async () => {
  const w = await ana("PATCH", `/tasks/${taskId}`, { status: "doing", waitingFor: "Transportadora" });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  assert.equal(w.body.status, "doing");
  assert.equal(w.body.waitingFor, "Transportadora");
  assert.ok(w.body.waitingSince);
  const list = await admin("GET", "/tasks");
  const t = list.body.find((x: any) => x.id === taskId);
  assert.equal(t.waitingFor, "Transportadora");
  assert.equal(t.createdBy.id, adminId);
  const back = await ana("PATCH", `/tasks/${taskId}`, { status: "doing", waitingFor: null });
  assert.equal(back.body.waitingFor, null);
  // Esperando de novo e depois conclui: concluído nunca fica "esperando".
  await ana("PATCH", `/tasks/${taskId}`, { waitingFor: "Cliente" });
  const done = await ana("PATCH", `/tasks/${taskId}`, { status: "done" });
  assert.equal(done.body.waitingFor, null);
  const rows = await db.select().from(taskWaitingTable).where(eq(taskWaitingTable.tenantId, tenantId));
  assert.equal(rows.length, 0);
});

test("CRM: quem não pediu nem faz o pedido não mexe no 'esperando'", async () => {
  const r = await caio("PATCH", `/tasks/${taskId}`, { waitingFor: "Fornecedor" });
  assert.equal(r.status, 403);
  const rows = await db.select().from(taskWaitingTable).where(eq(taskWaitingTable.tenantId, tenantId));
  assert.equal(rows.length, 0);
});

// ─── Quadro com as tarefas no ERP ───────────────────────────────────────────

test("ERP: 'Esperando alguém' fica no CRM sem chamar o ERP; voltar a fazer muda o status lá", async () => {
  erpStore.tasks.push({
    id: "uuid-700", number: 700, title: "Separar telas A15", description: null, status: "doing", priority: "media",
    dueDate: null, durationMinutes: null, alertMinutesBefore: null, position: 0, sectorName: null, crmSectorId: null,
    contactName: null, contactPhone: null, crmContactId: null, origin: "erp", createdAt: "2026-10-29T10:00:00Z", updatedAt: "2026-10-29T10:00:00Z",
    createdBy: { userId: null, name: "Samuel Admin", email: "admin@equipe.invalid" },
    assignees: [{ id: "a1", userId: null, name: "Lucélia", email: "ana@equipe.invalid" }],
    subtaskTotal: 0, subtaskDone: 0, commentCount: 0,
  });
  await setTasksMoved(tenantId, true);
  try {
    const before = erpStore.calls.filter((c) => c.method === "PATCH").length;
    const w = await ana("PATCH", "/tasks/700", { waitingFor: "Fornecedor" });
    assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.equal(w.body.waitingFor, "Fornecedor");
    assert.equal(erpStore.calls.filter((c) => c.method === "PATCH").length, before, "só o 'esperando' não vai para o ERP");
    const list = await ana("GET", "/tasks");
    assert.deepEqual(list.body.map((t: any) => [t.id, t.waitingFor, t.createdBy?.id]), [[700, "Fornecedor", adminId]]);
    const back = await ana("PATCH", "/tasks/700", { status: "todo" });
    assert.equal(back.body.status, "todo");
    assert.equal(back.body.waitingFor, null);
    assert.equal(erpStore.calls.filter((c) => c.method === "PATCH").pop()!.body.status, "todo");
    assert.equal((await caio("PATCH", "/tasks/700", { waitingFor: "x" })).status, 403);
  } finally {
    await setTasksMoved(tenantId, false);
  }
});

// ─── Chat interno: "sem resposta há X" ──────────────────────────────────────

test("conversa direta: mensagem sem resposta marca; responder tira", async () => {
  // Conversa 1:1 nova está desligada na tela; as antigas continuam valendo.
  const [conv] = await db.insert(internalConversationsTable).values({ tenantId, kind: "direct" }).returning();
  const convId = conv!.id;
  await db.insert(internalConversationMembersTable).values([
    { tenantId, conversationId: convId, userId: adminId }, { tenantId, conversationId: convId, userId: anaId },
  ]);
  assert.equal((await ana("POST", `/internal-chat/conversations/${convId}/messages`, { content: "Pode conferir o Pix da Fabrícia?" })).status, 200);
  let list = await admin("GET", "/internal-chat/conversations");
  let c = list.body.find((x: any) => x.id === convId);
  assert.ok(c.waitingReplySince, "admin deve resposta");
  // Quem mandou não deve nada.
  list = await ana("GET", "/internal-chat/conversations");
  assert.equal(list.body.find((x: any) => x.id === convId).waitingReplySince, null);
  // Ler não é responder.
  await admin("POST", `/internal-chat/conversations/${convId}/read`);
  list = await admin("GET", "/internal-chat/conversations");
  assert.ok(list.body.find((x: any) => x.id === convId).waitingReplySince);
  await admin("POST", `/internal-chat/conversations/${convId}/messages`, { content: "Conferido!" });
  list = await admin("GET", "/internal-chat/conversations");
  c = list.body.find((x: any) => x.id === convId);
  assert.equal(c.waitingReplySince, null);
});

test("grupo: só cobra quem foi marcado (@nome) — e o Gerente IA (bot) não cobra", async () => {
  const g = await admin("POST", "/internal-chat/conversations/group", { name: "Loja PP", memberIds: [anaId, caioId] });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const convId = g.body.id as number;
  await ana("POST", `/internal-chat/conversations/${convId}/messages`, { content: "Chegou a remessa de capinhas" });
  const pend = async (c: typeof admin) => (await c("GET", "/internal-chat/conversations")).body.find((x: any) => x.id === convId).waitingReplySince;
  assert.equal(await pend(admin), null);
  assert.equal(await pend(caio), null);
  await ana("POST", `/internal-chat/conversations/${convId}/messages`, { content: "@caio a OS 2553 fica pronta 17h?" });
  assert.ok(await pend(caio));
  assert.equal(await pend(admin), null);
  // Mensagem do bot (usuário inativo) marcando o admin não conta.
  await db.insert(internalConversationMembersTable).values({ tenantId, conversationId: convId, userId: botId });
  await db.insert(internalMessagesTable).values({ tenantId, conversationId: convId, senderId: botId, content: "@Samuel tarefa nova" });
  assert.equal(await pend(admin), null);
});

test("grupo de duas pessoas (ex.: sala do Gerente com a pessoa) conta como conversa direta", async () => {
  const g = await admin("POST", "/internal-chat/conversations/group", { name: "📋 Gerente · Caio", memberIds: [caioId] });
  const convId = g.body.id as number;
  await db.insert(internalConversationMembersTable).values({ tenantId, conversationId: convId, userId: botId });
  await caio("POST", `/internal-chat/conversations/${convId}/messages`, { content: "Feito o caixa" });
  const list = await admin("GET", "/internal-chat/conversations");
  assert.ok(list.body.find((x: any) => x.id === convId).waitingReplySince);
});
