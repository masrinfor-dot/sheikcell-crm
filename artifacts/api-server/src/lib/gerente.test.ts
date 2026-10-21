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
  gerenteEventsTable, gerentePendingActionsTable, gerenteTaskDispatchesTable, employeesTable, taskCommentsTable, gerenteTeamPhonesTable, gerenteErpActionsTable, tenantErpIntegrationsTable, gerenteLinksTable, gerenteRecurrencesTable,
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
