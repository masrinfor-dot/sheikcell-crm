// Testa, com requisições HTTP reais contra o app real (não mocks), que um
// usuário autenticado da Loja A nunca consegue ler/listar/alterar dado da
// Loja B — em toda rota que carrega dado sensível (conversas, CRM, tarefas,
// chat interno, usuários, chamados de suporte). Cria duas lojas de teste
// isoladas, ataca cada rota com a sessão da Loja A mirando IDs da Loja B, e
// limpa tudo no final (marcador __ISOLATION_TEST__ nos nomes/e-mails pra
// nunca colidir com dado real e permitir limpeza segura mesmo após falha).
//
// Rodar: node --test src/tenantIsolation.test.ts   (dentro de artifacts/api-server)
// Precisa de DATABASE_URL apontando pro Postgres de DEV — NUNCA rode isto
// contra produção (o setup/cleanup faz INSERT/DELETE de verdade).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";

process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";
process.env["SESSION_SECRET"] ??= "isolation-test-secret";
process.env["OPENAI_API_KEY"] ??= "sk-fake-isolation-test";
process.env["WHATSAPP_BRIDGE_URL"] ??= "http://localhost:3002";
process.env["NODE_ENV"] ??= "development";

if (process.env["DATABASE_URL"]!.includes("prod") || process.env["DATABASE_URL"]!.includes("sheikcell-prod")) {
  throw new Error("DATABASE_URL parece de produção — abortando por segurança. Rode isto só contra o banco de dev.");
}

const {
  db, tenantsTable, usersTable, conversationsTable, messagesTable, crmContactsTable,
  tasksTable, internalConversationsTable, internalConversationMembersTable, internalMessagesTable,
  saasTicketsTable, saasTicketMessagesTable, accessLogsTable,
} = await import("@workspace/db");
const { eq, inArray } = await import("drizzle-orm");
const { default: app } = await import("./app.ts");

const MARK = "__ISOLATION_TEST__";

type Store = {
  tenantId: number;
  adminUserId: number;
  email: string;
  password: string;
  conversationId: number;
  messageId: number;
  crmContactId: number;
  taskId: number;
  internalConversationId: number;
  internalMessageId: number;
  ticketId: number;
};

let server: import("node:http").Server;
let baseUrl: string;
let A: Store;
let B: Store;

function makeClient() {
  let cookie = "";
  async function request(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0]!;
    let json: any = null;
    try { json = await res.json(); } catch { /* resposta sem corpo JSON */ }
    return { status: res.status, body: json };
  }
  return { request };
}

// Apaga qualquer resíduo de uma rodada anterior (idempotente) e, no final, os
// dados desta rodada. Deleta por tenant_id direto onde a tabela tem a coluna;
// saas_ticket_messages não tem tenant_id próprio, então vai por ticketId.
async function wipeTestTenants(): Promise<void> {
  const staleTenants = await db.select({ id: tenantsTable.id }).from(tenantsTable)
    .where(eq(tenantsTable.name, `${MARK}_A`));
  const staleTenantsB = await db.select({ id: tenantsTable.id }).from(tenantsTable)
    .where(eq(tenantsTable.name, `${MARK}_B`));
  const tenantIds = [...staleTenants, ...staleTenantsB].map((t) => t.id);
  if (tenantIds.length === 0) return;

  const staleTickets = await db.select({ id: saasTicketsTable.id }).from(saasTicketsTable)
    .where(inArray(saasTicketsTable.tenantId, tenantIds));
  const staleTicketIds = staleTickets.map((t) => t.id);
  if (staleTicketIds.length > 0) {
    await db.delete(saasTicketMessagesTable).where(inArray(saasTicketMessagesTable.ticketId, staleTicketIds));
  }
  await db.delete(saasTicketsTable).where(inArray(saasTicketsTable.tenantId, tenantIds));
  await db.delete(internalMessagesTable).where(inArray(internalMessagesTable.tenantId, tenantIds));
  await db.delete(internalConversationMembersTable).where(inArray(internalConversationMembersTable.tenantId, tenantIds));
  await db.delete(internalConversationsTable).where(inArray(internalConversationsTable.tenantId, tenantIds));
  await db.delete(messagesTable).where(inArray(messagesTable.tenantId, tenantIds));
  await db.delete(conversationsTable).where(inArray(conversationsTable.tenantId, tenantIds));
  await db.delete(crmContactsTable).where(inArray(crmContactsTable.tenantId, tenantIds));
  await db.delete(tasksTable).where(inArray(tasksTable.tenantId, tenantIds));
  await db.delete(accessLogsTable).where(inArray(accessLogsTable.tenantId, tenantIds));
  await db.delete(usersTable).where(inArray(usersTable.tenantId, tenantIds));
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, tenantIds));
}

async function seedStore(label: "A" | "B"): Promise<Omit<Store, "conversationId" | "messageId" | "crmContactId" | "taskId" | "internalConversationId" | "internalMessageId" | "ticketId">> {
  const [tenant] = await db.insert(tenantsTable).values({ name: `${MARK}_${label}` }).returning();
  const email = `${MARK.toLowerCase()}-${label.toLowerCase()}@isolation-test.invalid`;
  const password = "SenhaForte123!";
  const passwordHash = await bcrypt.hash(password, 10);
  const [admin] = await db.insert(usersTable).values({
    tenantId: tenant!.id, name: `Admin Teste ${label}`, email, passwordHash, role: "admin", isActive: true,
  }).returning();
  return { tenantId: tenant!.id, adminUserId: admin!.id, email, password };
}

before(async () => {
  await wipeTestTenants();

  const baseA = await seedStore("A");
  const baseB = await seedStore("B");

  // Dado "de dono" de cada loja: uma conversa de cliente + mensagem, um
  // contato de CRM, uma tarefa — direto no banco (mesma forma que a rota usa).
  async function seedOwnedData(base: Awaited<ReturnType<typeof seedStore>>, label: string) {
    const [conv] = await db.insert(conversationsTable).values({
      tenantId: base.tenantId, phone: "5511999990000", name: `Cliente ${label}`, channel: "manual",
    }).returning();
    const [msg] = await db.insert(messagesTable).values({
      tenantId: base.tenantId, conversationId: conv!.id, content: `mensagem secreta da loja ${label}`, direction: "inbound",
    }).returning();
    const [contact] = await db.insert(crmContactsTable).values({
      tenantId: base.tenantId, name: `Contato CRM ${label}`, phone: "5511999990001",
    }).returning();
    const [task] = await db.insert(tasksTable).values({
      tenantId: base.tenantId, title: `Tarefa confidencial ${label}`,
    }).returning();
    return { conversationId: conv!.id, messageId: msg!.id, crmContactId: contact!.id, taskId: task!.id };
  }

  const ownedA = await seedOwnedData(baseA, "A");
  const ownedB = await seedOwnedData(baseB, "B");

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address();
  if (addr == null || typeof addr === "string") throw new Error("Falha ao obter porta do servidor de teste");
  baseUrl = `http://127.0.0.1:${addr.port}/api`;

  // Chat interno: precisa estar logado pra sala geral auto-criar. Loga como
  // cada admin, garante a sala e manda uma mensagem "secreta" pra ter um id
  // real de conversa/mensagem do chat interno de cada loja pra atacar depois.
  async function seedInternalChat(base: Awaited<ReturnType<typeof seedStore>>, label: string) {
    const client = makeClient();
    await client.request("POST", "/auth/login", { email: base.email, password: base.password });
    const convs = await client.request("GET", "/internal-chat/conversations");
    const general = convs.body.find((c: any) => c.kind === "general");
    if (!general) throw new Error(`Sala geral do chat interno não apareceu pra loja ${label}`);
    const sent = await client.request("POST", `/internal-chat/conversations/${general.id}/messages`, {
      content: `mensagem interna secreta da loja ${label}`,
    });
    const ticket = await client.request("POST", "/tickets", { title: `Chamado confidencial ${label}` });
    return { internalConversationId: general.id as number, internalMessageId: sent.body.id as number, ticketId: ticket.body.ticket.id as number };
  }

  const internalA = await seedInternalChat(baseA, "A");
  const internalB = await seedInternalChat(baseB, "B");

  A = { ...baseA, ...ownedA, ...internalA };
  B = { ...baseB, ...ownedB, ...internalB };
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await wipeTestTenants();
});

// ─── Cliente autenticado como o admin da Loja A, usado em todo teste abaixo ─
let clientA: ReturnType<typeof makeClient>;

test("setup: login da Loja A funciona", async () => {
  clientA = makeClient();
  const res = await clientA.request("POST", "/auth/login", { email: A.email, password: A.password });
  assert.equal(res.status, 200);
});

// ─── Conversas (Central de Atendimento) ─────────────────────────────────────
test("GET /chat/conversations não lista conversa da Loja B", async () => {
  const res = await clientA.request("GET", "/chat/conversations");
  assert.equal(res.status, 200);
  const ids = (res.body.conversations ?? res.body).map((c: any) => c.id);
  assert.ok(!ids.includes(B.conversationId), "vazou conversationId da Loja B na listagem");
});

test("GET /chat/conversations/:id da Loja B é bloqueado", async () => {
  const res = await clientA.request("GET", `/chat/conversations/${B.conversationId}`);
  assert.ok([403, 404].includes(res.status), `esperava 403/404, veio ${res.status}`);
});

test("GET /chat/conversations/:id/messages da Loja B é bloqueado", async () => {
  const res = await clientA.request("GET", `/chat/conversations/${B.conversationId}/messages`);
  assert.ok([403, 404].includes(res.status), `esperava 403/404, veio ${res.status}`);
  if (res.body) {
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes("mensagem secreta da loja B"), "vazou conteúdo de mensagem da Loja B");
  }
});

// ─── CRM ─────────────────────────────────────────────────────────────────────
test("GET /crm não lista contato da Loja B", async () => {
  const res = await clientA.request("GET", "/crm");
  assert.equal(res.status, 200);
  const ids = (res.body.contacts ?? res.body).map((c: any) => c.id);
  assert.ok(!ids.includes(B.crmContactId), "vazou crmContactId da Loja B na listagem");
});

test("GET /crm/:id da Loja B é bloqueado", async () => {
  const res = await clientA.request("GET", `/crm/${B.crmContactId}`);
  assert.ok([403, 404].includes(res.status), `esperava 403/404, veio ${res.status}`);
});

test("PATCH /crm/:id da Loja B não altera o dado real", async () => {
  const res = await clientA.request("PATCH", `/crm/${B.crmContactId}`, { name: "HACKEADO PELA LOJA A" });
  assert.ok(res.status !== 200, `PATCH cross-tenant não deveria retornar 200 (veio ${res.status})`);
  const [row] = await db.select({ name: crmContactsTable.name }).from(crmContactsTable).where(eq(crmContactsTable.id, B.crmContactId));
  assert.notEqual(row?.name, "HACKEADO PELA LOJA A", "PATCH cross-tenant alterou dado real da Loja B");
});

// ─── Tarefas ─────────────────────────────────────────────────────────────────
test("GET /tasks não lista tarefa da Loja B", async () => {
  const res = await clientA.request("GET", "/tasks");
  assert.equal(res.status, 200);
  const ids = (res.body.tasks ?? res.body).map((t: any) => t.id);
  assert.ok(!ids.includes(B.taskId), "vazou taskId da Loja B na listagem");
});

test("GET /tasks/:id/comments da tarefa da Loja B é bloqueado", async () => {
  const res = await clientA.request("GET", `/tasks/${B.taskId}/comments`);
  assert.ok([403, 404].includes(res.status), `esperava 403/404, veio ${res.status}`);
});

// ─── Chat interno ────────────────────────────────────────────────────────────
test("GET /internal-chat/conversations não lista sala da Loja B", async () => {
  const res = await clientA.request("GET", "/internal-chat/conversations");
  assert.equal(res.status, 200);
  const ids = res.body.map((c: any) => c.id);
  assert.ok(!ids.includes(B.internalConversationId), "vazou internalConversationId da Loja B na listagem");
});

test("GET /internal-chat/conversations/:id/messages da Loja B é bloqueado", async () => {
  const res = await clientA.request("GET", `/internal-chat/conversations/${B.internalConversationId}/messages`);
  assert.equal(res.status, 403);
});

test("POST /internal-chat/conversations/:id/messages na sala da Loja B é bloqueado e não insere nada", async () => {
  const [before] = await db.select({ n: internalMessagesTable.id }).from(internalMessagesTable)
    .where(eq(internalMessagesTable.conversationId, B.internalConversationId));
  const res = await clientA.request("POST", `/internal-chat/conversations/${B.internalConversationId}/messages`, { content: "invasão" });
  assert.equal(res.status, 403);
  const after_ = await db.select().from(internalMessagesTable).where(eq(internalMessagesTable.conversationId, B.internalConversationId));
  assert.equal(after_.length, 1, "uma mensagem estranha apareceu na sala da Loja B após tentativa de invasão");
  void before;
});

// ─── Usuários (admin) ───────────────────────────────────────────────────────
test("GET /admin/users não lista usuário da Loja B", async () => {
  const res = await clientA.request("GET", "/admin/users");
  assert.equal(res.status, 200);
  const ids = (res.body.users ?? res.body).map((u: any) => u.id);
  assert.ok(!ids.includes(B.adminUserId), "vazou userId da Loja B na listagem de usuários");
});

test("PATCH /admin/users/:id do admin da Loja B não altera o dado real", async () => {
  const res = await clientA.request("PATCH", `/admin/users/${B.adminUserId}`, { name: "HACKEADO PELA LOJA A" });
  assert.ok(res.status !== 200, `PATCH cross-tenant não deveria retornar 200 (veio ${res.status})`);
  const [row] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, B.adminUserId));
  assert.notEqual(row?.name, "HACKEADO PELA LOJA A", "PATCH cross-tenant alterou o admin real da Loja B");
});

// ─── Chamados de suporte (loja ↔ superadmin) ────────────────────────────────
test("GET /tickets não lista chamado da Loja B", async () => {
  const res = await clientA.request("GET", "/tickets");
  assert.equal(res.status, 200);
  const ids = res.body.tickets.map((t: any) => t.id);
  assert.ok(!ids.includes(B.ticketId), "vazou ticketId da Loja B na listagem de chamados");
});

test("GET /tickets/:id/messages do chamado da Loja B é bloqueado", async () => {
  const res = await clientA.request("GET", `/tickets/${B.ticketId}/messages`);
  assert.equal(res.status, 404);
});
