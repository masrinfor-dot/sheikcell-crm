// Gerente IA com banco: o número autorizado é reconhecido em qualquer linha
// da loja, a mensagem NUNCA vira conversa de atendimento, reentrega não
// duplica, as ações por regra gravam os registros e o aviso de lembrete sai
// pelo bridge. Sem IA (chave fake) — só o caminho por regras, que é o que
// este código controla. Loja de teste isolada (marcador) e limpa no final.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";
process.env["SESSION_SECRET"] ??= "gerente-test-secret";
process.env["OPENAI_API_KEY"] ??= "sk-fake-gerente-test";
process.env["NODE_ENV"] ??= "development";

const {
  db, tenantsTable, sectorsTable, usersTable, conversationsTable, messagesTable, whatsappSessionsTable,
  attendanceLogsTable, crmContactsTable, whatsappContactsTable, tasksTable, taskAssigneesTable,
  gerenteSettingsTable, gerenteMessagesTable, gerenteRemindersTable, gerenteEntriesTable, gerenteBillsTable,
  gerenteEventsTable, gerentePendingActionsTable,
} = await import("@workspace/db");
const { eq, and } = await import("drizzle-orm");
const { processInboundWA } = await import("./whatsappInbound.ts");
const { handlePanelMessage, runGerenteNotifications, isAuthorizedPhone, normalizeAuthorizedPhones, invalidateGerenteCache } = await import("./gerente.ts");

const MARK = "__GERENTE_IA_TEST__";
const sessionKey = `test-gerente-${Math.random().toString(36).slice(2, 10)}`;
// Celular do dono SEM o 9 (como o WhatsApp às vezes entrega) — a lista
// autorizada guarda a forma canônica com o 9. Tem que casar mesmo assim.
const OWNER_PHONE_JID = "553391408604";
const OWNER_PHONE_CANONICAL = "5533991408604";
const CLIENT_PHONE = "5533988887777";
let tenantId: number;
let userId: number;
let server: Server;
const bridgeSends: { to: string; text: string; session: string }[] = [];

async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 4000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("waitFor: tempo esgotado");
}

function inbound(text: string, phone = OWNER_PHONE_JID, id = `msg-${Math.random().toString(36).slice(2)}`) {
  return processInboundWA({
    sessionKey, isGroupMsg: false,
    data: { key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id }, pushName: "Dono", message: { conversation: text } },
  } as Parameters<typeof processInboundWA>[0]);
}

async function wipe(): Promise<void> {
  const stale = await db.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.name, MARK));
  for (const { id } of stale) {
    await db.delete(gerentePendingActionsTable).where(eq(gerentePendingActionsTable.tenantId, id));
    await db.delete(gerenteMessagesTable).where(eq(gerenteMessagesTable.tenantId, id));
    await db.delete(gerenteRemindersTable).where(eq(gerenteRemindersTable.tenantId, id));
    await db.delete(gerenteEventsTable).where(eq(gerenteEventsTable.tenantId, id));
    await db.delete(gerenteEntriesTable).where(eq(gerenteEntriesTable.tenantId, id));
    await db.delete(gerenteBillsTable).where(eq(gerenteBillsTable.tenantId, id));
    await db.delete(gerenteSettingsTable).where(eq(gerenteSettingsTable.tenantId, id));
    await db.delete(taskAssigneesTable).where(eq(taskAssigneesTable.tenantId, id));
    await db.delete(tasksTable).where(eq(tasksTable.tenantId, id));
    await db.delete(messagesTable).where(eq(messagesTable.tenantId, id));
    await db.delete(attendanceLogsTable).where(eq(attendanceLogsTable.tenantId, id));
    await db.delete(conversationsTable).where(eq(conversationsTable.tenantId, id));
    await db.delete(crmContactsTable).where(eq(crmContactsTable.tenantId, id));
    await db.delete(whatsappContactsTable).where(eq(whatsappContactsTable.tenantId, id));
    await db.delete(whatsappSessionsTable).where(eq(whatsappSessionsTable.tenantId, id));
    await db.delete(usersTable).where(eq(usersTable.tenantId, id));
    await db.delete(sectorsTable).where(eq(sectorsTable.tenantId, id));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id));
  }
}

before(async () => {
  await wipe();
  // Bridge de mentira: grava o que o Gerente mandou pelo WhatsApp.
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (req.url === "/whatsapp/send") bridgeSends.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "application/json" }).end("{\"ok\":true}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  process.env["WHATSAPP_BRIDGE_URL"] = `http://127.0.0.1:${port}`;

  const [tenant] = await db.insert(tenantsTable).values({ name: MARK }).returning();
  tenantId = tenant!.id;
  await db.insert(sectorsTable).values({ tenantId, name: "Vendas", isActive: true });
  await db.insert(whatsappSessionsTable).values({ tenantId, sessionKey, status: "connected" });
  const [u] = await db.insert(usersTable).values({
    tenantId, name: "Nilmar Souza", email: `nilmar-${sessionKey}@test.local`, passwordHash: "x", role: "vendedor",
  }).returning();
  userId = u!.id;
  await db.insert(gerenteSettingsTable).values({ tenantId, authorizedPhones: [OWNER_PHONE_CANONICAL] });
  invalidateGerenteCache();
});

after(async () => {
  await wipe();
  await new Promise<void>((r) => server.close(() => r()));
});

test("normaliza a lista de autorizados e reconhece o número com ou sem o 9", () => {
  assert.deepEqual(normalizeAuthorizedPhones(["33 99140-8604", "(33) 9140-8604", "", "abc"]), [OWNER_PHONE_CANONICAL]);
  const s = { authorizedPhones: [OWNER_PHONE_CANONICAL] };
  assert.equal(isAuthorizedPhone(s, OWNER_PHONE_JID), true);
  assert.equal(isAuthorizedPhone(s, OWNER_PHONE_CANONICAL), true);
  assert.equal(isAuthorizedPhone(s, CLIENT_PHONE), false);
});

test("mensagem do dono vira lembrete e NÃO vira conversa de atendimento", async () => {
  await inbound("lembra de ligar pro contador amanhã às 9h", OWNER_PHONE_JID, "msg-lembrete-1");
  const out = await waitFor(async () => (await db.select().from(gerenteMessagesTable)
    .where(and(eq(gerenteMessagesTable.tenantId, tenantId), eq(gerenteMessagesTable.direction, "out"))))[0]);
  assert.match(out.content, /Lembrete anotado/);
  assert.match(out.content, /ligar pro contador/);

  const reminders = await db.select().from(gerenteRemindersTable).where(eq(gerenteRemindersTable.tenantId, tenantId));
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0]!.title, "ligar pro contador");

  // Nada no atendimento: zero conversas/mensagens dessa loja.
  const convs = await db.select().from(conversationsTable).where(eq(conversationsTable.tenantId, tenantId));
  assert.equal(convs.length, 0);
  const msgs = await db.select().from(messagesTable).where(eq(messagesTable.tenantId, tenantId));
  assert.equal(msgs.length, 0);

  // Resposta saiu pelo bridge, pro número do dono, pela mesma linha.
  const send = await waitFor(async () => bridgeSends.find((s) => /Lembrete anotado/.test(s.text)));
  assert.equal(send.session, sessionKey);
  assert.equal(send.to, OWNER_PHONE_CANONICAL);

  // A linha por onde o dono falou fica registrada (é por aí que os avisos saem).
  const [settings] = await db.select().from(gerenteSettingsTable).where(eq(gerenteSettingsTable.tenantId, tenantId));
  assert.equal(settings!.lastSessionKey, sessionKey);
  assert.equal(settings!.lastPhone, OWNER_PHONE_CANONICAL);
});

test("reentrega da mesma mensagem (mesmo ID) não duplica o lembrete", async () => {
  await inbound("lembra de ligar pro contador amanhã às 9h", OWNER_PHONE_JID, "msg-lembrete-1");
  await new Promise((r) => setTimeout(r, 300));
  const reminders = await db.select().from(gerenteRemindersTable).where(eq(gerenteRemindersTable.tenantId, tenantId));
  assert.equal(reminders.length, 1);
});

test("cliente comum na mesma linha segue o fluxo normal (vira conversa)", async () => {
  await inbound("oi, quero ver um celular", CLIENT_PHONE, "msg-cliente-1");
  const convs = await db.select().from(conversationsTable).where(eq(conversationsTable.tenantId, tenantId));
  assert.equal(convs.length, 1);
  assert.equal(convs[0]!.phone, CLIENT_PHONE);
  const g = await db.select().from(gerenteMessagesTable).where(and(eq(gerenteMessagesTable.tenantId, tenantId), eq(gerenteMessagesTable.phone, CLIENT_PHONE)));
  assert.equal(g.length, 0);
});

test("painel: gasto, conta, tarefa pra equipe, consultas e desfazer", async () => {
  const g = await handlePanelMessage(tenantId, "gastei 50 no almoço");
  assert.match(g.replies[0]!, /R\$\s?50,00/);
  const entries = await db.select().from(gerenteEntriesTable).where(eq(gerenteEntriesTable.tenantId, tenantId));
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.kind, "gasto");
  assert.equal(entries[0]!.description, "almoço");

  const c = await handlePanelMessage(tenantId, "pagar 1.500 aluguel dia 10/11");
  assert.match(c.replies[0]!, /Conta a pagar/);
  const bills = await db.select().from(gerenteBillsTable).where(eq(gerenteBillsTable.tenantId, tenantId));
  assert.equal(bills.length, 1);
  assert.equal(bills[0]!.amountCents, 150000);
  assert.equal(bills[0]!.dueDate.slice(5), "11-10");

  const t = await handlePanelMessage(tenantId, "tarefa pro Nilmar: conferir estoque até sexta");
  assert.match(t.replies[0]!, /Nilmar Souza/);
  const tasks = await db.select().from(tasksTable).where(eq(tasksTable.tenantId, tenantId));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.title, "conferir estoque");
  const assignees = await db.select().from(taskAssigneesTable).where(eq(taskAssigneesTable.taskId, tasks[0]!.id));
  assert.deepEqual(assignees.map((a) => a.userId), [userId]);

  const contas = await handlePanelMessage(tenantId, "contas");
  assert.match(contas.replies[0]!, /aluguel/);
  const fin = await handlePanelMessage(tenantId, "financeiro");
  assert.match(fin.replies[0]!, /Gastos: R\$\s?50,00/);
  const dia = await handlePanelMessage(tenantId, "meu dia");
  assert.match(dia.replies[0]!, /Meu dia/);
  const semPendencia = await handlePanelMessage(tenantId, "sim");
  assert.match(semPendencia.replies[0]!, /nada aguardando/i);

  // Desfazer: o último registro criado foi a tarefa → arquivada.
  const undo = await handlePanelMessage(tenantId, "desfazer");
  assert.match(undo.replies[0]!, /Desfeito/);
  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, tasks[0]!.id));
  assert.equal(task!.isArchived, true);
});

test("aviso de lembrete vencido sai pelo WhatsApp e 'feito' conclui", async () => {
  const [r] = await db.insert(gerenteRemindersTable).values({
    tenantId, title: "mandar o relatório", dueAt: new Date(Date.now() - 60_000), urgent: true,
  }).returning();
  bridgeSends.length = 0;
  await runGerenteNotifications();
  const sent = bridgeSends.find((s) => /mandar o relatório/.test(s.text));
  assert.ok(sent, "aviso não saiu pelo bridge");
  assert.equal(sent.to, OWNER_PHONE_CANONICAL);
  assert.equal(sent.session, sessionKey);
  const [after1] = await db.select().from(gerenteRemindersTable).where(eq(gerenteRemindersTable.id, r!.id));
  assert.ok(after1!.sentAt, "sentAt deveria estar preenchido");

  // Segunda rodada não reenvia.
  bridgeSends.length = 0;
  await runGerenteNotifications();
  assert.equal(bridgeSends.filter((s) => /mandar o relatório/.test(s.text)).length, 0);

  const done = await handlePanelMessage(tenantId, "feito");
  assert.match(done.replies[0]!, /mandar o relatório/);
  const [after2] = await db.select().from(gerenteRemindersTable).where(eq(gerenteRemindersTable.id, r!.id));
  assert.equal(after2!.status, "concluido");
});

test("Gerente desligado: mensagem do dono volta a ser atendimento comum", async () => {
  await db.update(gerenteSettingsTable).set({ enabled: false }).where(eq(gerenteSettingsTable.tenantId, tenantId));
  invalidateGerenteCache(tenantId);
  await inbound("oi", OWNER_PHONE_JID, "msg-dono-desligado");
  const convs = await db.select().from(conversationsTable).where(and(eq(conversationsTable.tenantId, tenantId), eq(conversationsTable.phone, OWNER_PHONE_CANONICAL)));
  assert.equal(convs.length, 1);
  await db.update(gerenteSettingsTable).set({ enabled: true }).where(eq(gerenteSettingsTable.tenantId, tenantId));
  invalidateGerenteCache(tenantId);
});
