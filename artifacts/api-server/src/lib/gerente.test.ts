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
  gerenteEventsTable, gerentePendingActionsTable, gerenteTaskDispatchesTable, employeesTable, taskCommentsTable, gerenteTeamPhonesTable, gerenteErpActionsTable, tenantErpIntegrationsTable, gerenteLinksTable, gerenteRecurrencesTable, gerenteTeamDigestsTable, storesTable, gerenteChatRoomsTable, internalConversationsTable, internalMessagesTable, gerenteMembersTable, gerenteChatFollowupsTable, internalConversationMembersTable,
} = await import("@workspace/db");
const { eq, and, desc } = await import("drizzle-orm");
const { processInboundWA } = await import("./whatsappInbound.ts");
const { tryConsumeTaskProof } = await import("./gerenteDispatch.ts");
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
const erpPosts: { auth: string; body: Record<string, any> }[] = [];

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
    await db.delete(gerenteTaskDispatchesTable).where(eq(gerenteTaskDispatchesTable.tenantId, id));
    await db.delete(gerenteTeamPhonesTable).where(eq(gerenteTeamPhonesTable.tenantId, id));
    await db.delete(gerenteErpActionsTable).where(eq(gerenteErpActionsTable.tenantId, id));
    await db.delete(gerenteLinksTable).where(eq(gerenteLinksTable.tenantId, id));
    await db.delete(gerenteRecurrencesTable).where(eq(gerenteRecurrencesTable.tenantId, id));
    await db.delete(gerenteTeamDigestsTable).where(eq(gerenteTeamDigestsTable.tenantId, id));
    await db.delete(gerenteChatRoomsTable).where(eq(gerenteChatRoomsTable.tenantId, id));
    await db.delete(gerenteMembersTable).where(eq(gerenteMembersTable.tenantId, id));
    await db.delete(gerenteChatFollowupsTable).where(eq(gerenteChatFollowupsTable.tenantId, id));
    await db.delete(internalConversationsTable).where(eq(internalConversationsTable.tenantId, id));
    await db.delete(tenantErpIntegrationsTable).where(eq(tenantErpIntegrationsTable.tenantId, id));
    await db.delete(taskCommentsTable).where(eq(taskCommentsTable.tenantId, id));
    await db.delete(employeesTable).where(eq(employeesTable.tenantId, id));
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
    await db.delete(storesTable).where(eq(storesTable.tenantId, id));
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
      if (req.url === "/erp/agent/actions" && req.method === "POST") {
        const j = JSON.parse(body);
        erpPosts.push({ auth: String(req.headers["authorization"] ?? ""), body: j });
        if (j.payload?.personName === "Fornecedor Inexistente") {
          res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "Não achei a pessoa \"Fornecedor Inexistente\"." }));
          return;
        }
        res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ id: `act-${erpPosts.length}`, status: "PENDENTE", message: "Recebido. Está aguardando aprovação no ERP." }));
        return;
      }
      if (req.url?.startsWith("/erp/agent/actions/") && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "APROVADA", message: "Aprovado por Fulano. Já está lançado no ERP." }));
        return;
      }
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
  await db.insert(employeesTable).values({ tenantId, userId, name: "Nilmar Souza", phone: "(33) 98877-6655" });
  await db.insert(gerenteSettingsTable).values({ tenantId, authorizedPhones: [OWNER_PHONE_CANONICAL], teamChannel: "both" });
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
  assert.match(t.replies[0]!, /para \*Nilmar\*/);
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

test("'feito' solto não conclui lembrete que nunca foi avisado", async () => {
  const [r] = await db.insert(gerenteRemindersTable).values({
    tenantId, title: "lembrete futuro", dueAt: new Date(Date.now() + 3 * 3_600_000),
  }).returning();
  const reply = await handlePanelMessage(tenantId, "feito");
  assert.match(reply.replies[0]!, /Nenhum lembrete avisado/);
  const [after] = await db.select().from(gerenteRemindersTable).where(eq(gerenteRemindersTable.id, r!.id));
  assert.equal(after!.status, "pendente");
  await db.delete(gerenteRemindersTable).where(eq(gerenteRemindersTable.id, r!.id));
});

test("'paguei 1500 aluguel' com conta aberta oferece a baixa; 'sim' quita e lança; 'desfazer' reabre", async () => {
  const offer = await handlePanelMessage(tenantId, "paguei 1.500 aluguel");
  assert.match(offer.replies[0]!, /quita a conta/);
  const [still] = await db.select().from(gerenteBillsTable).where(and(eq(gerenteBillsTable.tenantId, tenantId), eq(gerenteBillsTable.description, "aluguel")));
  assert.equal(still!.status, "aberta");
  const yes = await handlePanelMessage(tenantId, "sim");
  assert.match(yes.replies[0]!, /Baixa dada/);
  assert.match(yes.replies[0]!, /Gasto lançado/);
  const [paid] = await db.select().from(gerenteBillsTable).where(eq(gerenteBillsTable.id, still!.id));
  assert.equal(paid!.status, "paga");
  const entries = await db.select().from(gerenteEntriesTable).where(and(eq(gerenteEntriesTable.tenantId, tenantId), eq(gerenteEntriesTable.description, "aluguel")));
  assert.equal(entries.length, 1);
  const undo = await handlePanelMessage(tenantId, "desfazer");
  assert.match(undo.replies[0]!, /reaberta/);
  const [reopened] = await db.select().from(gerenteBillsTable).where(eq(gerenteBillsTable.id, still!.id));
  assert.equal(reopened!.status, "aberta");
  const entriesAfter = await db.select().from(gerenteEntriesTable).where(and(eq(gerenteEntriesTable.tenantId, tenantId), eq(gerenteEntriesTable.description, "aluguel")));
  assert.equal(entriesAfter.length, 0);
});

test("aviso que o bridge recusa não entra no histórico e tenta de novo depois", async () => {
  const [r] = await db.insert(gerenteRemindersTable).values({
    tenantId, title: "aviso com bridge fora", dueAt: new Date(Date.now() - 60_000), urgent: true,
  }).returning();
  const saved = process.env["WHATSAPP_BRIDGE_URL"];
  process.env["WHATSAPP_BRIDGE_URL"] = "http://127.0.0.1:1"; // porta fechada → recusa na hora
  try {
    await runGerenteNotifications();
  } finally {
    process.env["WHATSAPP_BRIDGE_URL"] = saved;
  }
  const outs = await db.select().from(gerenteMessagesTable).where(and(eq(gerenteMessagesTable.tenantId, tenantId), eq(gerenteMessagesTable.direction, "out")));
  assert.equal(outs.filter((m) => /aviso com bridge fora/.test(m.content)).length, 0, "não pode gravar aviso que não saiu");
  const [after] = await db.select().from(gerenteRemindersTable).where(eq(gerenteRemindersTable.id, r!.id));
  assert.equal(after!.sentAt, null);
  // Bridge de volta: sai e grava uma vez.
  bridgeSends.length = 0;
  await runGerenteNotifications();
  assert.equal(bridgeSends.filter((s) => /aviso com bridge fora/.test(s.text)).length, 1);
  await db.update(gerenteRemindersTable).set({ status: "concluido" }).where(eq(gerenteRemindersTable.id, r!.id));
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

test("tarefa vai pro WhatsApp do vendedor; 'feito' pede foto; foto fecha a tarefa com prova e avisa o dono", async () => {
  bridgeSends.length = 0;
  const r = await handlePanelMessage(tenantId, "tarefa pro Nilmar: limpar a vitrine até 18h");
  assert.match(r.replies[0]!, /Enviada no WhatsApp de Nilmar/);
  const sellerPhone = "5533988776655";
  const sent = bridgeSends.find((s) => s.to === sellerPhone);
  assert.ok(sent, "tarefa não saiu pro vendedor");
  assert.match(sent.text, /limpar a vitrine/);
  const [d] = await db.select().from(gerenteTaskDispatchesTable).where(eq(gerenteTaskDispatchesTable.tenantId, tenantId)).orderBy(desc(gerenteTaskDispatchesTable.id)).limit(1);
  assert.equal(d!.status, "enviada");

  // Mensagem comum do vendedor segue o fluxo normal.
  assert.equal(await tryConsumeTaskProof({ tenantId, sessionKey, phone: sellerPhone, text: "bom dia", msgType: "text", mediaUrl: null }), false);
  // Foto sem "feito" antes: não é prova.
  assert.equal(await tryConsumeTaskProof({ tenantId, sessionKey, phone: sellerPhone, text: "", msgType: "image", mediaUrl: "/api/chat/media/x.jpg" }), false);

  assert.equal(await tryConsumeTaskProof({ tenantId, sessionKey, phone: sellerPhone, text: "feito", msgType: "text", mediaUrl: null }), true);
  const [d2] = await db.select().from(gerenteTaskDispatchesTable).where(eq(gerenteTaskDispatchesTable.id, d!.id));
  assert.equal(d2!.status, "aguardando_prova");

  bridgeSends.length = 0;
  assert.equal(await tryConsumeTaskProof({ tenantId, sessionKey, phone: sellerPhone, text: "", msgType: "image", mediaUrl: "/api/chat/media/11111111-1111-1111-1111-111111111111.jpg" }), true);
  const [d3] = await db.select().from(gerenteTaskDispatchesTable).where(eq(gerenteTaskDispatchesTable.id, d!.id));
  assert.equal(d3!.status, "concluida");
  assert.ok(d3!.proofUrl);
  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, d!.taskId));
  assert.equal(task!.status, "done");
  const comments = await db.select().from(taskCommentsTable).where(eq(taskCommentsTable.taskId, d!.taskId));
  assert.equal(comments.length, 1);
  assert.equal(comments[0]!.mediaType, "image");
  await waitFor(async () => bridgeSends.find((s) => s.to === OWNER_PHONE_CANONICAL && /concluiu/.test(s.text)));
});

test("número da Equipe no WhatsApp tem prioridade sobre o telefone antigo do RH", async () => {
  await db.insert(gerenteTeamPhonesTable).values({ tenantId, userId, phone: "5533977776666" });
  bridgeSends.length = 0;
  const r = await handlePanelMessage(tenantId, "tarefa pro Nilmar: repor películas até 17h");
  assert.match(r.replies[0]!, /Enviada no WhatsApp de Nilmar/);
  assert.ok(bridgeSends.find((s) => s.to === "5533977776666" && /repor películas/.test(s.text)));
  assert.equal(bridgeSends.filter((s) => s.to === "5533988776655").length, 0);
});

test("linha ADM: conta vai pra fila de aprovação do ERP (não é lançada local); beneficiário desconhecido vai nas observações; aprovação avisa o dono", async () => {
  const { encryptErpSecret } = await import("./erpCrypto.ts");
  const { saveAgentKey } = await import("./gerenteErp.ts");
  const port = Number(new URL(process.env["WHATSAPP_BRIDGE_URL"]!).port);
  const enc = encryptErpSecret("erp_test_key_123");
  await db.insert(tenantErpIntegrationsTable).values({ tenantId, baseUrl: `http://127.0.0.1:${port}/erp`, encryptedApiKey: enc.ciphertext, iv: enc.iv, authTag: enc.authTag, keyVersion: enc.keyVersion, last4: "0123" });
  await saveAgentKey(tenantId, "agk_testkey_abcdefghij");
  await db.update(gerenteSettingsTable).set({ admSessionKey: sessionKey }).where(eq(gerenteSettingsTable.tenantId, tenantId));
  invalidateGerenteCache(tenantId);
  const billsBefore = (await db.select().from(gerenteBillsTable).where(eq(gerenteBillsTable.tenantId, tenantId))).length;

  erpPosts.length = 0; bridgeSends.length = 0;
  await inbound("pagar 350 energia dia 25/12", OWNER_PHONE_JID, "msg-adm-1");
  await waitFor(async () => bridgeSends.find((s) => /aguardando aprovação/.test(s.text)));
  assert.equal(erpPosts.length, 1);
  assert.equal(erpPosts[0]!.auth, "Bearer agk_testkey_abcdefghij");
  assert.equal(erpPosts[0]!.body.type, "CREATE_PAYABLE");
  assert.equal(erpPosts[0]!.body.payload.totalAmount, 350);
  assert.match(erpPosts[0]!.body.payload.dueDate, /-12-25$/);
  const billsAfter = (await db.select().from(gerenteBillsTable).where(eq(gerenteBillsTable.tenantId, tenantId))).length;
  assert.equal(billsAfter, billsBefore, "na linha ADM não lança conta local");

  // Beneficiário que o ERP não conhece: reenvia sem a pessoa, nome nas observações.
  const { submitErpAction } = await import("./gerenteErp.ts");
  const { getGerenteSettings } = await import("./gerente.ts");
  erpPosts.length = 0;
  const reply = await submitErpAction(await getGerenteSettings(tenantId), {
    type: "CREATE_PAYABLE", summary: "Peças", senderPhone: OWNER_PHONE_CANONICAL, messageText: "boleto",
    payload: { description: "Peças", totalAmount: 120, dueDate: "2026-12-01", personName: "Fornecedor Inexistente" },
  });
  assert.match(reply, /aguardando aprovação/);
  assert.equal(erpPosts.length, 2);
  assert.equal(erpPosts[1]!.body.payload.personName, undefined);
  assert.match(erpPosts[1]!.body.payload.notes, /Fornecedor Inexistente/);

  // Job: aprovado no ERP → avisa o dono uma vez.
  bridgeSends.length = 0;
  await runGerenteNotifications();
  assert.ok(bridgeSends.find((s) => s.to === OWNER_PHONE_CANONICAL && /ERP — Conta a pagar/.test(s.text) && /Aprovado/.test(s.text)));
  const rows = await db.select().from(gerenteErpActionsTable).where(eq(gerenteErpActionsTable.tenantId, tenantId));
  assert.ok(rows.every((r) => r.status === "APROVADA"));
  bridgeSends.length = 0;
  await runGerenteNotifications();
  assert.equal(bridgeSends.filter((s) => /ERP —/.test(s.text)).length, 0, "não avisa duas vezes");
});

test("documento sem valor: pergunta, e a resposta completa e manda pro ERP", async () => {
  const erp = await import("./gerenteErp.ts");
  const action = erp.actionFromDoc({ tipo: "boleto", descricao: "Internet", valor: null, vencimento: "2026-12-10", data_pagamento: null, linha_digitavel: "123", beneficiario: null, beneficiario_documento: null, pagador: null, observacao: null }, "");
  assert.ok(action && action.missing.includes("valor") && action.type === "CREATE_PAYABLE");
  const { getGerenteSettings } = await import("./gerente.ts");
  const settings = await getGerenteSettings(tenantId);
  await db.insert(gerentePendingActionsTable).values({ tenantId, phone: OWNER_PHONE_CANONICAL, action: { type: "erp_doc", erpType: action.type, payload: action.payload, summary: action.summary, mediaUrl: null, caption: "", missing: action.missing }, summary: action.summary, expiresAt: new Date(Date.now() + 600_000) })
    .onConflictDoUpdate({ target: [gerentePendingActionsTable.tenantId, gerentePendingActionsTable.phone], set: { action: { type: "erp_doc", erpType: action.type, payload: action.payload, summary: action.summary, mediaUrl: null, caption: "", missing: action.missing }, expiresAt: new Date(Date.now() + 600_000) } });
  erpPosts.length = 0;
  void settings;
  const r = await handlePanelMessage(tenantId, "199,90");
  assert.match(r.replies[0]!, /aguardando aprovação/);
  assert.equal(erpPosts.length, 1);
  assert.equal(erpPosts[0]!.body.payload.totalAmount, 199.9);
});

test("link seguro: 'link' e 'link da tarefa N' geram token válido e restrito", async () => {
  const { resolveLink } = await import("./gerenteExtras.ts");
  const r = await handlePanelMessage(tenantId, "link");
  const m = r.replies[0]!.match(/\/g\/([A-Za-z0-9_-]+)/);
  assert.ok(m, r.replies[0]);
  const l = await resolveLink(m[1]!);
  assert.ok(l && l.scope === "dia" && l.tenantId === tenantId);
  assert.match(m[1]!, /^[A-Za-z0-9]{32}$/, "token só com letras e números (sem _ que o WhatsApp formata)");
  const [t] = await db.insert(tasksTable).values({ tenantId, title: "tarefa do link" }).returning();
  const r2 = await handlePanelMessage(tenantId, `link da tarefa ${t!.id}`);
  const m2 = r2.replies[0]!.match(/\/g\/([A-Za-z0-9_-]+)/);
  const l2 = await resolveLink(m2![1]!);
  assert.ok(l2 && l2.scope === "task" && l2.refId === t!.id);
  assert.equal(await resolveLink("token-que-nao-existe-1234567890"), null);
  const r3 = await handlePanelMessage(tenantId, "link da tarefa 99999999");
  assert.match(r3.replies[0]!, /Não achei/);
});

test("rotina: cria, dispara no horário (lembrete) e agenda a próxima; cancelar para", async () => {
  const { runRecurrences } = await import("./gerenteExtras.ts");
  const { getGerenteSettings } = await import("./gerente.ts");
  const r = await handlePanelMessage(tenantId, "todo dia 8h lembra de abrir o caixa");
  assert.match(r.replies[0]!, /Rotina \*(\d+)\* criada/);
  const [rec] = await db.select().from(gerenteRecurrencesTable).where(eq(gerenteRecurrencesTable.tenantId, tenantId)).orderBy(desc(gerenteRecurrencesTable.id)).limit(1);
  assert.equal(rec!.kind, "lembrete");
  assert.equal(rec!.title, "abrir o caixa");
  // Força vencer agora.
  await db.update(gerenteRecurrencesTable).set({ nextAt: new Date(Date.now() - 1000) }).where(eq(gerenteRecurrencesTable.id, rec!.id));
  const before = (await db.select().from(gerenteRemindersTable).where(eq(gerenteRemindersTable.tenantId, tenantId))).length;
  assert.equal(await runRecurrences(await getGerenteSettings(tenantId)), 1);
  assert.equal(await runRecurrences(await getGerenteSettings(tenantId)), 0, "não dispara duas vezes");
  const after = await db.select().from(gerenteRemindersTable).where(eq(gerenteRemindersTable.tenantId, tenantId));
  assert.equal(after.length, before + 1);
  const [rec2] = await db.select().from(gerenteRecurrencesTable).where(eq(gerenteRecurrencesTable.id, rec!.id));
  assert.ok(rec2!.nextAt.getTime() > Date.now());
  const list = await handlePanelMessage(tenantId, "rotinas");
  assert.match(list.replies[0]!, /abrir o caixa/);
  const c = await handlePanelMessage(tenantId, `cancelar rotina ${rec!.id}`);
  assert.match(c.replies[0]!, /cancelada/);
  // tarefa recorrente
  const t = await handlePanelMessage(tenantId, "toda segunda 9h tarefa pro Nilmar: limpar a vitrine");
  assert.match(t.replies[0]!, /tarefa pro Nilmar/);
});

test("fechamento do dia e 'mover'", async () => {
  await db.insert(gerenteRemindersTable).values({ tenantId, title: "pendência de hoje", dueAt: new Date(Date.now() - 60_000) });
  const f = await handlePanelMessage(tenantId, "fechamento");
  assert.match(f.replies[0]!, /Fechamento do dia/);
  assert.match(f.replies[0]!, /pendência de hoje/);
  const m = await handlePanelMessage(tenantId, "mover");
  assert.match(m.replies[0]!, /movido/);
  const rel = await handlePanelMessage(tenantId, "relatorio");
  assert.match(rel.replies[0]!, /Semana da equipe/);
});

test("WhatsApp: 'tarefa estorno concluída' acha 'EXTORNOS', fecha e avisa o responsável; ativar, comentar e avisar", async () => {
  const [t] = await db.insert(tasksTable).values({ tenantId, title: "EXTORNOS" }).returning();
  await db.insert(taskAssigneesTable).values({ tenantId, taskId: t!.id, userId });
  bridgeSends.length = 0;
  const r = await handlePanelMessage(tenantId, "tarefa estorno concluída");
  assert.match(r.replies[0]!, /EXTORNOS/);
  assert.match(r.replies[0]!, /concluída/);
  assert.match(r.replies[0]!, /Avisei: Nilmar/);
  const [after] = await db.select().from(tasksTable).where(eq(tasksTable.id, t!.id));
  assert.equal(after!.status, "done");
  assert.ok(bridgeSends.find((s) => /EXTORNOS/.test(s.text) && /concluída/.test(s.text)), "responsável não foi avisado");

  const re = await handlePanelMessage(tenantId, `reabrir tarefa ${t!.id}`);
  assert.match(re.replies[0]!, /a fazer/);
  const at = await handlePanelMessage(tenantId, `ativar tarefa ${t!.id}`);
  assert.match(at.replies[0]!, /em andamento/);
  bridgeSends.length = 0;
  const c = await handlePanelMessage(tenantId, `comentar tarefa ${t!.id}: Já falei com o banco`);
  assert.match(c.replies[0]!, /Comentário/);
  assert.ok(bridgeSends.find((s) => /Já falei com o banco/.test(s.text)));
  const comments = await db.select().from(taskCommentsTable).where(eq(taskCommentsTable.taskId, t!.id));
  assert.ok(comments.some((x) => x.content === "Já falei com o banco"));
  bridgeSends.length = 0;
  const a = await handlePanelMessage(tenantId, "avisa o Nilmar: passa no banco antes das 15h");
  assert.match(a.replies[0]!, /Mandei o recado pra \*Nilmar\*/);
  assert.ok(bridgeSends.find((s) => /passa no banco antes das 15h/.test(s.text)));
  const none = await handlePanelMessage(tenantId, "concluir tarefa tarefa-que-nao-existe-xyz");
  assert.match(none.replies[0]!, /Não achei/);
});

test("link do vendedor é só leitura; link do dono pode editar", async () => {
  const { createLink, resolveLink } = await import("./gerenteExtras.ts");
  const { getGerenteSettings } = await import("./gerente.ts");
  const s = await getGerenteSettings(tenantId);
  const ro = (await createLink(s, "task", 1, 1, false)).split("/g/")[1]!;
  const rw = (await createLink(s, "dia", null, 1)).split("/g/")[1]!;
  assert.equal((await resolveLink(ro))!.canEdit, false);
  assert.equal((await resolveLink(rw))!.canEdit, true);
});

test("tarefas v2: não duplica, vários responsáveis numa tarefa só, categoria, edição avisa quem entrou, juntar duplicadas", async () => {
  const { createTask } = await import("./gerente.ts");
  const { updateTask, mergeDuplicateTasks, addSubtask, toggleSubtask } = await import("./gerenteTaskOps.ts");
  const { gerenteTaskMetaTable, taskSubtasksTable } = await import("@workspace/db");
  const [davi] = await db.insert(usersTable).values({ tenantId, name: "Davi Teste", email: `davi-${sessionKey}@test.local`, passwordHash: "x", role: "vendedor" }).returning();
  await db.insert(employeesTable).values({ tenantId, userId: davi!.id, name: "Davi Teste", phone: "(33) 99875-4887" });

  bridgeSends.length = 0;
  const r1 = await createTask(tenantId, { title: "Conferir estoque de capinhas", assigneeNames: ["Nilmar", "Davi"], category: "Loja PP" });
  const taskId = r1.ref!.id;
  const assignees = await db.select().from(taskAssigneesTable).where(eq(taskAssigneesTable.taskId, taskId));
  assert.equal(assignees.length, 2, "uma tarefa só com os dois responsáveis");
  assert.ok(bridgeSends.some((s) => s.to === "5533977776666"), "Nilmar recebeu");
  assert.ok(bridgeSends.some((s) => s.to === "5533998754887"), "Davi recebeu");
  const [meta] = await db.select().from(gerenteTaskMetaTable).where(eq(gerenteTaskMetaTable.taskId, taskId));
  assert.equal(meta!.category, "Loja PP");

  // Mesmo título com outra grafia → não cria outra.
  const r2 = await createTask(tenantId, { title: "conferir estoque de capinha!" });
  assert.match(r2.text, /Já existe a tarefa/);
  assert.equal((await db.select().from(tasksTable).where(and(eq(tasksTable.tenantId, tenantId), eq(tasksTable.title, "conferir estoque de capinha!")))).length, 0);

  // Edição: tira o Davi, troca prioridade/categoria; ninguém novo → sem envio.
  bridgeSends.length = 0;
  await updateTask(tenantId, taskId, { priority: "alta", category: "Compras", assigneeIds: [userId] });
  const [t] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
  assert.equal(t!.priority, "alta");
  assert.equal((await db.select().from(taskAssigneesTable).where(eq(taskAssigneesTable.taskId, taskId))).length, 1);
  assert.equal(bridgeSends.filter((s) => s.to === "5533998754887").length, 0);
  // Davi volta → recebe a tarefa no WhatsApp.
  await updateTask(tenantId, taskId, { assigneeIds: [userId, davi!.id] });
  await waitFor(async () => bridgeSends.find((s) => s.to === "5533998754887"));

  // Checklist.
  await addSubtask(tenantId, taskId, "Contar Loja PP");
  const [st] = await db.select().from(taskSubtasksTable).where(eq(taskSubtasksTable.taskId, taskId));
  await toggleSubtask(tenantId, taskId, st!.id, true);
  const [st2] = await db.select().from(taskSubtasksTable).where(eq(taskSubtasksTable.id, st!.id));
  assert.equal(st2!.isDone, true);

  // Duplicadas antigas (criadas direto no banco, como as de produção) são juntadas.
  const [a] = await db.insert(tasksTable).values({ tenantId, title: "Letreiro PP" }).returning();
  const [b] = await db.insert(tasksTable).values({ tenantId, title: "letreiro pp." }).returning();
  await db.insert(taskAssigneesTable).values({ tenantId, taskId: b!.id, userId: davi!.id });
  const merged = await mergeDuplicateTasks(tenantId);
  const g = merged.find((m) => m.kept === a!.id);
  assert.ok(g, "manteve a mais antiga");
  assert.deepEqual(g.archived.map((x) => x.id), [b!.id]);
  const [bb] = await db.select().from(tasksTable).where(eq(tasksTable.id, b!.id));
  assert.equal(bb!.isArchived, true);
  const keptAssignees = await db.select().from(taskAssigneesTable).where(eq(taskAssigneesTable.taskId, a!.id));
  assert.ok(keptAssignees.some((x) => x.userId === davi!.id), "responsável da duplicada passa pra que ficou");
});

test("vendedor: 2 adia pra amanhã, 3 manda dúvida pro dono, 1 pede a foto; '149' solto não é resposta", async () => {
  const { createTask } = await import("./gerente.ts");
  const seller = "5533977776666"; // número da Equipe no WhatsApp do Nilmar (teste anterior)
  const due = new Date(Date.now() + 3 * 3_600_000);
  const r = await createTask(tenantId, { title: "Trocar etiqueta de preço da vitrine", assigneeNames: ["Nilmar"], dueAt: due });
  const taskId = r.ref!.id;
  const msg = bridgeSends.filter((s) => s.to === seller).pop()!;
  assert.match(msg.text, new RegExp(`\\*1 ${taskId}\\* ✅`));
  const proof = (text: string, msgType = "text") => tryConsumeTaskProof({ tenantId, sessionKey, phone: seller, text, msgType, mediaUrl: null });

  assert.equal(await proof("149"), false);

  bridgeSends.length = 0;
  assert.equal(await proof(`2 ${taskId}`), true);
  const [t1] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
  assert.ok(t1!.dueDate!.getTime() - due.getTime() > 23 * 3_600_000, "prazo foi pra amanhã");
  await waitFor(async () => bridgeSends.find((s) => s.to === OWNER_PHONE_CANONICAL && /adiou/.test(s.text)));

  bridgeSends.length = 0;
  assert.equal(await proof(`3 ${taskId}`), true);
  assert.equal(await proof("Qual etiqueta? A amarela ou a branca?"), true);
  const ownerMsg = await waitFor(async () => bridgeSends.find((s) => s.to === OWNER_PHONE_CANONICAL && /dúvida/.test(s.text)));
  assert.match(ownerMsg.text, /A amarela ou a branca\?/);
  const cs = await db.select().from(taskCommentsTable).where(eq(taskCommentsTable.taskId, taskId));
  assert.ok(cs.some((c) => c.content.startsWith("❓ Dúvida: Qual etiqueta")));
  // Depois de encaminhada, mensagem comum volta a seguir o fluxo normal.
  assert.equal(await proof("bom dia pessoal"), false);

  // Dúvida já com o texto, numa mensagem só (acentos preservados).
  bridgeSends.length = 0;
  assert.equal(await proof(`3 ${taskId} Não achei a impressora`), true);
  await waitFor(async () => bridgeSends.find((s) => s.to === OWNER_PHONE_CANONICAL && /Não achei a impressora/.test(s.text)));

  assert.equal(await proof(`1 ${taskId}`), true);
  const [d] = await db.select().from(gerenteTaskDispatchesTable).where(and(eq(gerenteTaskDispatchesTable.taskId, taskId), eq(gerenteTaskDispatchesTable.phone, seller)));
  assert.equal(d!.status, "aguardando_prova");
});

test("bom dia da equipe: cada um recebe só as suas tarefas, uma vez por dia; domingo não", async () => {
  const { runTeamDigests } = await import("./gerenteDispatch.ts");
  const settings = { tenantId, teamDigestEnabled: true, teamMorningTime: "08:00", teamEveningTime: "18:00", lastSessionKey: sessionKey };
  // Segunda-feira 08:05 em São Paulo.
  const monday = new Date("2026-11-02T08:05:00-03:00");
  bridgeSends.length = 0;
  const n = await runTeamDigests(settings, monday);
  assert.ok(n >= 1, "mandou pra alguém");
  // O teste anterior manda um aviso ao Nilmar sem esperar ("👍 Ótimo! Agora
  // manda uma foto…"); às vezes ele chega depois do reset acima. Procura a
  // mensagem do bom dia, não a primeira que chegou para ele.
  const nil = bridgeSends.find((s) => s.to === "5533977776666" && /Bom dia/.test(s.text));
  assert.ok(nil, "Nilmar recebeu o bom dia");
  assert.match(nil.text, /Bom dia, Nilmar/);
  assert.match(nil.text, /Responda:/);
  assert.equal(await runTeamDigests(settings, new Date("2026-11-02T08:30:00-03:00")), 0, "não repete no mesmo dia");
  assert.equal(await runTeamDigests(settings, new Date("2026-11-01T08:05:00-03:00")), 0, "domingo não manda");
  assert.equal(await runTeamDigests(settings, new Date("2026-11-03T07:30:00-03:00")), 0, "antes do horário não manda");
});

test("'arrumar tarefas': propõe categoria e prazo novo; 'sim' aplica", async () => {
  const { buildOrganizePlan, guessCategory } = await import("./gerenteOrganize.ts");
  const { gerenteTaskMetaTable } = await import("@workspace/db");
  assert.equal(guessCategory("Pedidos de frontal A51 LCD e OLED"), "Compras");
  assert.equal(guessCategory("Negociar Sicoob"), "Financeiro");
  assert.equal(guessCategory("Lona letreiro SC"), "Loja SC");
  const [late] = await db.insert(tasksTable).values({ tenantId, title: "Pedido de bateria iPhone 11", dueDate: new Date(Date.now() - 2 * 86_400_000), priority: "alta" }).returning();
  const plan = await buildOrganizePlan(tenantId);
  const it = plan.find((i) => i.taskId === late!.id);
  assert.ok(it, "tarefa atrasada entrou no plano");
  assert.ok(new Date(it.dueAt!).getTime() > Date.now(), "prazo novo no futuro");
  assert.equal(it.category, "Compras");

  const r = await handlePanelMessage(tenantId, "arrumar tarefas");
  assert.match(r.replies[0]!, /Aplico\?/);
  const ok = await handlePanelMessage(tenantId, "sim");
  assert.match(ok.replies[0]!, /Arrumei/);
  const [t] = await db.select().from(tasksTable).where(eq(tasksTable.id, late!.id));
  assert.ok(t!.dueDate!.getTime() > Date.now());
  const [m] = await db.select().from(gerenteTaskMetaTable).where(eq(gerenteTaskMetaTable.taskId, late!.id));
  assert.equal(m!.category, "Compras");
});

test("apelidos e lojas: Gabi, Cris, Lu; 'meninos de São Cristóvão'", async () => {
  const { matchPerson, parseTargets } = await import("./gerenteComms.ts");
  const people = [
    { id: 1, name: "Gabrielly Rosa", storeId: null }, { id: 2, name: "Christian Colares", storeId: null },
    { id: 3, name: "Lucelia", storeId: null }, { id: 4, name: "Alan David", storeId: null }, { id: 5, name: "Ana Paula", storeId: null },
  ];
  assert.equal(matchPerson(people, "Gabi")?.id, 1);
  assert.equal(matchPerson(people, "Cris")?.id, 2);
  assert.equal(matchPerson(people, "Lu")?.id, 3);
  assert.equal(matchPerson(people, "a Lu")?.id, 3);
  assert.equal(matchPerson(people, "Paula")?.id, 5);
  assert.equal(matchPerson(people, "Aldo"), null);
  assert.deepEqual(parseTargets("os meninos de São Cristóvão, por favor"), { names: [], loja: "São Cristóvão" });
  assert.deepEqual(parseTargets("loja SC"), { names: [], loja: "SC" });
  assert.deepEqual(parseTargets("Alan e Davi"), { names: ["Alan", "Davi"], loja: null });
});

test("recado e encaminhamento direto: 'avisa o Nilmar que…', 'manda isso pro Nilmar', 'fala pros meninos de SC: …'", async () => {
  const { tryDirectCommand } = await import("./gerenteComms.ts");
  const seller = "5533977776666";
  const newIn = async (content: string, payload: Record<string, unknown> | null = null) => (await db.insert(gerenteMessagesTable).values({ tenantId, phone: OWNER_PHONE_CANONICAL, direction: "in", source: "whatsapp", content, payload }).returning())[0]!.id;

  bridgeSends.length = 0;
  let id = await newIn("avisa o Nilmar que a reunião é às 18h");
  let r = await tryDirectCommand(tenantId, OWNER_PHONE_CANONICAL, id, "avisa o Nilmar que a reunião é às 18h");
  assert.match(r!, /Mandei o recado pra \*Nilmar\*/);
  assert.ok(bridgeSends.find((s) => s.to === seller && /a reunião é às 18h/.test(s.text)));

  // Contato compartilhado e depois "manda isso pro Nilmar".
  bridgeSends.length = 0;
  await newIn("👤 Contato compartilhado: João Peças — 5533988880000", { msgType: "contact", mediaUrl: null });
  id = await newIn("manda isso pro Nilmar");
  r = await tryDirectCommand(tenantId, OWNER_PHONE_CANONICAL, id, "manda isso pro Nilmar");
  assert.match(r!, /Mandei o contato/);
  assert.ok(bridgeSends.find((s) => s.to === seller && /João Peças — 5533988880000/.test(s.text)));

  // Loja: Nilmar é de São Cristóvão.
  const [st] = await db.insert(storesTable).values({ tenantId, name: "SÃO CRISTOVÃO - 03" }).returning();
  await db.update(usersTable).set({ storeId: st!.id }).where(eq(usersTable.id, userId));
  bridgeSends.length = 0;
  id = await newIn("fala pros meninos de SC: abram 8h amanhã");
  r = await tryDirectCommand(tenantId, OWNER_PHONE_CANONICAL, id, "fala pros meninos de SC: abram 8h amanhã");
  assert.match(r!, /SÃO CRISTOVÃO/);
  assert.ok(bridgeSends.find((s) => s.to === seller && /abram 8h amanhã/.test(s.text)));

  // Ninguém da equipe com esse nome: não é atalho (a IA trata).
  assert.equal(await tryDirectCommand(tenantId, OWNER_PHONE_CANONICAL, id, "manda pra frente o pedido"), null);
});

test("link, resumo e equipe em linguagem natural", async () => {
  const l = await handlePanelMessage(tenantId, "Mande o link para acessar as tarefas");
  assert.match(l.replies[0]!, /\/g\/[A-Za-z0-9]{32}/);
  const r = await handlePanelMessage(tenantId, "me dá um resumo");
  assert.match(r.replies[0]!, /Equipe agora/);
  assert.match(r.replies[0]!, /\/g\//);
  const e = await handlePanelMessage(tenantId, "como está a equipe?");
  assert.match(e.replies[0]!, /Nilmar — \d+ aberta/);
});

test("histórico: resposta da mensagem anterior entra mesmo gravada depois da atual", async () => {
  const { loadHistory } = await import("./gerente.ts");
  const ph = "5533900000001";
  const ins = async (direction: "in" | "out", content: string) => (await db.insert(gerenteMessagesTable).values({ tenantId, phone: ph, direction, source: "whatsapp", content }).returning())[0]!.id;
  await ins("in", "criar tarefa A");
  const b = await ins("in", "criar tarefa B");
  await ins("out", "Tarefa A criada");
  const h = await loadHistory(tenantId, ph, b);
  assert.deepEqual(h.map((m) => m.content), ["criar tarefa A", "Tarefa A criada"]);
});

test("contato compartilhado sozinho: pergunta pra quem mandar (não vira atendimento)", async () => {
  bridgeSends.length = 0;
  await processInboundWA({
    sessionKey, isGroupMsg: false,
    data: { key: { remoteJid: `${OWNER_PHONE_JID}@s.whatsapp.net`, fromMe: false, id: `ct-${Date.now()}` }, pushName: "Dono", message: { contactMessage: { displayName: "Fornecedor X", vcard: "BEGIN:VCARD\nTEL;waid=5531999990000:+55 31 99999-0000\nEND:VCARD" } } },
  } as Parameters<typeof processInboundWA>[0]);
  await waitFor(async () => bridgeSends.find((s) => /Pra quem eu mando/.test(s.text)));
  const [m] = await db.select().from(gerenteMessagesTable).where(and(eq(gerenteMessagesTable.tenantId, tenantId), eq(gerenteMessagesTable.intent, "anexo_recebido"))).orderBy(desc(gerenteMessagesTable.id)).limit(1);
  assert.match(m!.content, /Fornecedor X/);
});

test("só a linha ADM atende o dono: em outra linha vira atendimento e ele é avisado pelo ADM", async () => {
  const other = `${sessionKey}-varejo`;
  await db.insert(whatsappSessionsTable).values({ tenantId, sessionKey: other, status: "connected" });
  await db.update(gerenteSettingsTable).set({ admSessionKey: sessionKey }).where(eq(gerenteSettingsTable.tenantId, tenantId));
  invalidateGerenteCache(tenantId);
  bridgeSends.length = 0;
  await processInboundWA({
    sessionKey: other, isGroupMsg: false,
    data: { key: { remoteJid: `${OWNER_PHONE_JID}@s.whatsapp.net`, fromMe: false, id: `oth-${Date.now()}` }, pushName: "Dono", message: { conversation: "lembra de ligar pro banco amanhã 9h" } },
  } as Parameters<typeof processInboundWA>[0]);
  const tip = await waitFor(async () => bridgeSends.find((s) => s.session === sessionKey && /só por \*este número \(ADM\)\*/.test(s.text)));
  assert.ok(tip);
  const conv = await db.select().from(conversationsTable).where(and(eq(conversationsTable.tenantId, tenantId), eq(conversationsTable.sessionKey, other)));
  assert.equal(conv.length, 1, "na outra linha vira atendimento normal");
  const rem = await db.select().from(gerenteRemindersTable).where(and(eq(gerenteRemindersTable.tenantId, tenantId), eq(gerenteRemindersTable.title, "ligar pro banco")));
  assert.equal(rem.length, 0, "não virou lembrete");

  // ADM desconectada: volta a atender em qualquer linha (nada se perde).
  await db.update(whatsappSessionsTable).set({ status: "disconnected" }).where(eq(whatsappSessionsTable.sessionKey, sessionKey));
  const { gerenteLine, getGerenteSettings } = await import("./gerente.ts");
  assert.equal(await gerenteLine(await getGerenteSettings(tenantId)), null);
  await db.update(whatsappSessionsTable).set({ status: "connected" }).where(eq(whatsappSessionsTable.sessionKey, sessionKey));
  assert.equal(await gerenteLine(await getGerenteSettings(tenantId)), sessionKey);
});

test("link do vendedor: comecei, adiar, dúvida e foto que conclui (só na tarefa dele)", async () => {
  const { createTask, getGerenteSettings } = await import("./gerente.ts");
  const { createLink, resolveLink } = await import("./gerenteExtras.ts");
  const { sellerAction, sellerProof } = await import("./gerenteDispatch.ts");
  const { saveMedia } = await import("./whatsappInbound.ts");
  bridgeSends.length = 0;
  const r = await createTask(tenantId, { title: "Limpar o balcão da loja", assigneeNames: ["Nilmar"] });
  const taskId = r.ref!.id;
  const sent = bridgeSends.find((s) => s.to === "5533977776666" && /Limpar o balcão/.test(s.text));
  assert.match(sent!.text, /Abrir a tarefa \(comecei/);
  const token = sent!.text.match(/\/g\/([A-Za-z0-9]{32})/)![1]!;
  const link = await resolveLink(token);
  assert.equal(link!.userId, userId);
  assert.equal(link!.canEdit, false);

  assert.match(await sellerAction(tenantId, taskId, userId, "doing"), /em andamento/);
  const [t1] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
  assert.equal(t1!.status, "doing");
  assert.match(await sellerAction(tenantId, taskId, userId, "question", "Uso qual produto?"), /Mandei sua dúvida/);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const url = await saveMedia(png, "image/png");
  assert.match(await sellerProof(tenantId, taskId, userId, url, null), /concluída/);
  const [t2] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
  assert.equal(t2!.status, "done");
  void getGerenteSettings; void createLink;
});

test("chat interno: sala do Gerente responde o dono; tarefa chega na sala da pessoa; '1 N' + foto conclui; recado de loja vai pra sala da loja", async () => {
  const { mirrorToGerenteRoom, onInternalMessage, botUserId } = await import("./gerenteInternal.ts");
  const { createTask } = await import("./gerente.ts");
  const { sendToTeam } = await import("./gerenteComms.ts");
  const { saveMedia } = await import("./whatsappInbound.ts");
  const [owner] = await db.insert(usersTable).values({ tenantId, name: "Samuel Teste", email: `samuel-${sessionKey}@test.local`, passwordHash: "x", role: "admin" }).returning();
  const bot = await botUserId(tenantId);
  const roomOf = async (kind: string, refId = 0) => (await db.select().from(gerenteChatRoomsTable).where(and(eq(gerenteChatRoomsTable.tenantId, tenantId), eq(gerenteChatRoomsTable.kind, kind), eq(gerenteChatRoomsTable.refId, refId))))[0];
  const msgs = async (conv: number) => db.select().from(internalMessagesTable).where(eq(internalMessagesTable.conversationId, conv)).orderBy(internalMessagesTable.id);

  // Sala do Gerente: o dono escreve "resumo" no chat e o bot responde lá.
  await mirrorToGerenteRoom(tenantId, "out", "teste");
  const g = await roomOf("gerente");
  assert.ok(g, "sala do Gerente criada");
  await onInternalMessage({ tenantId, conversationId: g.conversationId, senderId: owner!.id, text: "como está a equipe?", type: "text", mediaUrl: null });
  const gm = await msgs(g.conversationId);
  assert.ok(gm.some((m) => m.senderId === bot && /Equipe agora/.test(m.content)), "bot respondeu no chat");

  // Tarefa pra pessoa: chega na sala dela.
  const r = await createTask(tenantId, { title: "Separar capinhas da vitrine", assigneeNames: ["Nilmar"] });
  const taskId = r.ref!.id;
  assert.match(r.text, /e no chat do CRM/);
  const pr = await roomOf("pessoa", userId);
  assert.ok(pr, "sala da pessoa criada");
  assert.ok((await msgs(pr.conversationId)).some((m) => m.senderId === bot && m.content.includes(`Nova tarefa #${taskId}`)));

  // Vendedor responde "1 N" e manda a foto na sala.
  await onInternalMessage({ tenantId, conversationId: pr.conversationId, senderId: userId, text: `1 ${taskId}`, type: "text", mediaUrl: null });
  assert.ok((await msgs(pr.conversationId)).some((m) => /manda aqui uma foto/.test(m.content)));
  const url = await saveMedia("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "image/png");
  await onInternalMessage({ tenantId, conversationId: pr.conversationId, senderId: userId, text: "", type: "image", mediaUrl: url });
  const [t] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
  assert.equal(t!.status, "done");

  // Recado pra loja: uma mensagem na sala da loja.
  const out = await sendToTeam(tenantId, { names: [], loja: "SC", message: "Fechar 18h hoje", item: null });
  assert.match(out, /Mandei o recado/);
  const [st] = await db.select().from(storesTable).where(eq(storesTable.tenantId, tenantId));
  const lr = await roomOf("loja", st!.id);
  assert.ok(lr, "sala da loja criada");
  assert.ok((await msgs(lr.conversationId)).some((m) => /Fechar 18h hoje/.test(m.content)));
});

test("gestor (2º número): tarefas e recados como o dono, lembretes próprios, financeiro bloqueado, recebe avisos da equipe", async () => {
  const GESTOR = "5533977770000";
  await db.insert(gerenteMembersTable).values({ tenantId, phone: GESTOR, name: "Maria Gestora" });
  invalidateGerenteCache(tenantId);
  const fromGestor = async (text: string) => processInboundWA({
    sessionKey, isGroupMsg: false,
    data: { key: { remoteJid: `${GESTOR}@s.whatsapp.net`, fromMe: false, id: `g-${Math.random().toString(36).slice(2)}` }, pushName: "Maria", message: { conversation: text } },
  } as Parameters<typeof processInboundWA>[0]);

  bridgeSends.length = 0;
  await fromGestor("lembra de ligar pro fornecedor amanhã às 9h");
  const rem = await waitFor(async () => (await db.select().from(gerenteRemindersTable).where(and(eq(gerenteRemindersTable.tenantId, tenantId), eq(gerenteRemindersTable.memberPhone, GESTOR))))[0]);
  assert.equal(rem.title, "ligar pro fornecedor");
  const owner = await handlePanelMessage(tenantId, "lembretes");
  assert.doesNotMatch(owner.replies[0]!, /ligar pro fornecedor/, "lembrete do gestor não aparece pro dono");

  bridgeSends.length = 0;
  await fromGestor("gastei 80 no motoboy");
  await waitFor(async () => bridgeSends.find((s) => s.to === GESTOR && /Financeiro, contas e ERP ficam só com o dono/.test(s.text)));
  const entries = await db.select().from(gerenteEntriesTable).where(and(eq(gerenteEntriesTable.tenantId, tenantId), eq(gerenteEntriesTable.description, "motoboy")));
  assert.equal(entries.length, 0);

  bridgeSends.length = 0;
  await fromGestor("avisa o Nilmar que o caminhão chega às 14h");
  const rec = await waitFor(async () => bridgeSends.find((s) => s.to === "5533977776666" && /caminhão chega às 14h/.test(s.text)));
  assert.match(rec.text, /Maria:/, "recado sai no nome do gestor");

  // Aviso da equipe vai pro dono E pro gestor.
  bridgeSends.length = 0;
  const { notifyTeamLeads } = await import("./gerente.ts");
  await notifyTeamLeads(tenantId, "✅ Nilmar concluiu: teste");
  assert.ok(bridgeSends.find((s) => s.to === GESTOR && /Nilmar concluiu/.test(s.text)));
  assert.ok(bridgeSends.find((s) => s.to === OWNER_PHONE_CANONICAL && /Nilmar concluiu/.test(s.text)));
});

test("mensagem pra cliente: mostra antes, só envia no 'sim'", async () => {
  const { prepareClientMessage, getGerenteSettings } = await import("./gerente.ts");
  await db.insert(crmContactsTable).values({ tenantId, name: "João Cliente Teste", phone: "5533955554444", contact: "(33) 95555-4444" });
  const settings = await getGerenteSettings(tenantId);
  const phone = settings.lastPhone ?? settings.authorizedPhones[0]!;
  bridgeSends.length = 0;
  const preview = await prepareClientMessage(tenantId, phone, "João Cliente", "Olá João! Seu aparelho está pronto. 😊");
  assert.match(preview, /Mensagem pra \*João Cliente Teste\*/);
  assert.match(preview, /Confirma\?/);
  assert.equal(bridgeSends.filter((s) => s.to === "5533955554444").length, 0, "nada sai antes do sim");
  const ok = await handlePanelMessage(tenantId, "sim");
  assert.match(ok.replies[0]!, /Enviado pra \*João Cliente Teste\*/);
  assert.ok(bridgeSends.find((s) => s.to === "5533955554444" && /aparelho está pronto/.test(s.text)));
});

test("gestora no chat interno: sala própria do Gerente e 'tarefa: …' na sala do vendedor vira tarefa dele", async () => {
  const { onInternalMessage, mirrorToGerenteRoom, botUserId } = await import("./gerenteInternal.ts");
  const [luc] = await db.insert(usersTable).values({ tenantId, name: "Lucelia Gestora", email: `luc-${sessionKey}@test.local`, passwordHash: "x", role: "vendedor" }).returning();
  const LUC = "5533987100000";
  await db.insert(gerenteMembersTable).values({ tenantId, phone: LUC, name: "Lucelia", userId: luc!.id });
  invalidateGerenteCache(tenantId);
  const bot = await botUserId(tenantId);

  // Sala "🤖 Gerente IA · Lucelia": ela pede resumo da equipe.
  await mirrorToGerenteRoom(tenantId, "out", "oi", LUC);
  const [gr] = await db.select().from(gerenteChatRoomsTable).where(and(eq(gerenteChatRoomsTable.tenantId, tenantId), eq(gerenteChatRoomsTable.kind, "gerente"), eq(gerenteChatRoomsTable.refId, luc!.id)));
  assert.ok(gr, "sala da gestora criada");
  await onInternalMessage({ tenantId, conversationId: gr!.conversationId, senderId: luc!.id, text: "como está a equipe?", type: "text", mediaUrl: null });
  const gm = await db.select().from(internalMessagesTable).where(eq(internalMessagesTable.conversationId, gr!.conversationId));
  assert.ok(gm.some((m) => m.senderId === bot && /Equipe agora/.test(m.content)));

  // Sala do Nilmar: a gestora entra como membro e "tarefa: …" cria a tarefa pra ele.
  const [pr] = await db.select().from(gerenteChatRoomsTable).where(and(eq(gerenteChatRoomsTable.tenantId, tenantId), eq(gerenteChatRoomsTable.kind, "pessoa"), eq(gerenteChatRoomsTable.refId, userId)));
  const { postToPerson } = await import("./gerenteInternal.ts");
  await postToPerson(tenantId, userId, "teste de membros");
  const members = await db.select().from((await import("@workspace/db")).internalConversationMembersTable).where(eq((await import("@workspace/db")).internalConversationMembersTable.conversationId, pr!.conversationId));
  assert.ok(members.some((m) => m.userId === luc!.id), "gestora está na sala do vendedor");
  await onInternalMessage({ tenantId, conversationId: pr!.conversationId, senderId: luc!.id, text: "tarefa: repor capas de iPhone 13 na vitrine", type: "text", mediaUrl: null });
  const [t] = await db.select().from(tasksTable).where(and(eq(tasksTable.tenantId, tenantId), eq(tasksTable.title, "repor capas de iPhone 13 na vitrine")));
  assert.ok(t, "tarefa criada");
  assert.equal(t!.createdById, luc!.id, "criada pela gestora");
  const asg = await db.select().from(taskAssigneesTable).where(eq(taskAssigneesTable.taskId, t!.id));
  assert.deepEqual(asg.map((a) => a.userId), [userId]);
});

test("chat primeiro: tarefa vai só pro chat; sem abrir em X min vai pro WhatsApp pessoal e alerta os gerentes; quem abriu não é cobrado", async () => {
  const { createTask } = await import("./gerente.ts");
  const { runChatFollowups } = await import("./gerenteInternal.ts");
  await db.update(gerenteSettingsTable).set({ teamChannel: "chat_first", chatFallbackMinutes: 30 }).where(eq(gerenteSettingsTable.tenantId, tenantId));
  const seller = "5533977776666";
  bridgeSends.length = 0;
  const r = await createTask(tenantId, { title: "Conferir garantia do Moto G", assigneeNames: ["Nilmar"] });
  assert.match(r.text, /no chat do CRM\. Se não abrir em 30 min/);
  assert.equal(bridgeSends.filter((s) => s.to === seller && /Moto G/.test(s.text)).length, 0, "WhatsApp ainda não");

  // 10 min depois: nada. 31 min depois: WhatsApp + alerta.
  assert.equal(await runChatFollowups(tenantId, new Date(Date.now() + 10 * 60_000)), 0);
  assert.equal(await runChatFollowups(tenantId, new Date(Date.now() + 31 * 60_000)), 1);
  assert.ok(bridgeSends.find((s) => s.to === seller && /Moto G/.test(s.text)), "foi pro WhatsApp pessoal");
  assert.ok(bridgeSends.find((s) => s.to === OWNER_PHONE_CANONICAL && /não abriu o chat do CRM em 30 min/.test(s.text)), "alerta pro dono");
  assert.equal(await runChatFollowups(tenantId, new Date(Date.now() + 60 * 60_000)), 0, "só uma vez");

  // Segunda tarefa: ele abre a sala (lastReadAt) — não é cobrado.
  bridgeSends.length = 0;
  const r2 = await createTask(tenantId, { title: "Limpar a bancada de teste", assigneeNames: ["Nilmar"] });
  void r2;
  const [f] = await db.select().from(gerenteChatFollowupsTable).where(eq(gerenteChatFollowupsTable.tenantId, tenantId)).orderBy(desc(gerenteChatFollowupsTable.id)).limit(1);
  await db.update(internalConversationMembersTable).set({ lastReadAt: new Date(Date.now() + 1000) }).where(and(eq(internalConversationMembersTable.conversationId, f!.conversationId), eq(internalConversationMembersTable.userId, userId)));
  assert.equal(await runChatFollowups(tenantId, new Date(Date.now() + 31 * 60_000)), 0);
  assert.equal(bridgeSends.filter((s) => s.to === seller).length, 0);
  await db.update(gerenteSettingsTable).set({ teamChannel: "both" }).where(eq(gerenteSettingsTable.tenantId, tenantId));
});
