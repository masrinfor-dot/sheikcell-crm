import { test, before, after } from "node:test";
import assert from "node:assert/strict";

process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";
process.env["SESSION_SECRET"] ??= "isolation-test-secret";
process.env["OPENAI_API_KEY"] ??= "sk-fake-isolation-test";
process.env["WHATSAPP_BRIDGE_URL"] ??= "http://localhost:3002";
process.env["NODE_ENV"] ??= "development";

const {
  db, tenantsTable, sectorsTable, conversationsTable, messagesTable, whatsappSessionsTable,
  attendanceLogsTable, crmContactsTable, whatsappContactsTable, usersTable,
} = await import("@workspace/db");
const { eq, and, asc } = await import("drizzle-orm");
const { processWAHistoryBatch, processWAHistoryArchived, historyConversationKey, pickHistoryName } = await import("./whatsappHistory.ts");
const { processInboundWA, processInboundWAContacts } = await import("./whatsappInbound.ts");

const MARK = "__TEST_WA_HISTORY__";
const rnd = Math.random().toString(36).slice(2, 10);
const keyAtivos = `test-hist-ativos-${rnd}`;
const keyOff = `test-hist-off-${rnd}`;
const keySemDono = `test-hist-semdono-${rnd}`;
let tenantId: number;
let userId: number;

before(async () => {
  await db.delete(tenantsTable).where(eq(tenantsTable.name, MARK));
  const [tenant] = await db.insert(tenantsTable).values({ name: MARK }).returning();
  tenantId = tenant!.id;
  await db.insert(sectorsTable).values({ tenantId, name: "Compras", isActive: true });
  const [u] = await db.insert(usersTable).values({
    tenantId, name: "Responsável Compras", email: `compras-${rnd}@hist.invalid`, passwordHash: "x", role: "vendedor", isActive: true,
  }).returning();
  userId = u!.id;
  await db.insert(whatsappSessionsTable).values([
    { tenantId, sessionKey: keyAtivos, displayName: "Compras", status: "connected", historyImportEnabled: true, directAssigneeId: userId },
    { tenantId, sessionKey: keyOff, status: "connected", historyImportEnabled: false },
    { tenantId, sessionKey: keySemDono, status: "connected", historyImportEnabled: true },
  ]);
  // Nome salvo na agenda da linha de Compras.
  await db.insert(whatsappContactsTable).values({
    tenantId, sessionKey: keyAtivos, jid: "5533988887777@s.whatsapp.net", phone: "5533988887777", name: "Fornecedor Peças BH", pushName: "Zé",
  });
});

after(async () => {
  await db.delete(messagesTable).where(eq(messagesTable.tenantId, tenantId));
  await db.delete(attendanceLogsTable).where(eq(attendanceLogsTable.tenantId, tenantId));
  await db.delete(conversationsTable).where(eq(conversationsTable.tenantId, tenantId));
  await db.delete(crmContactsTable).where(eq(crmContactsTable.tenantId, tenantId));
  await db.delete(whatsappContactsTable).where(eq(whatsappContactsTable.tenantId, tenantId));
  await db.delete(whatsappSessionsTable).where(eq(whatsappSessionsTable.tenantId, tenantId));
  await db.delete(usersTable).where(eq(usersTable.tenantId, tenantId));
  await db.delete(sectorsTable).where(eq(sectorsTable.tenantId, tenantId));
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
});

test("chave da conversa: telefone para 1:1, JID para grupo, @lid sem telefone é ignorado", () => {
  assert.equal(historyConversationKey("5533988887777@s.whatsapp.net", false), "5533988887777");
  assert.equal(historyConversationKey("5533988887777:12@s.whatsapp.net", false), "5533988887777");
  assert.equal(historyConversationKey("1203630@g.us", true), "1203630@g.us");
  assert.equal(historyConversationKey("123456789@lid", false), null);
});

test("nome: agenda → nome do chat → perfil → telefone; grupo usa o nome do grupo", () => {
  assert.equal(pickHistoryName({ isGroup: false, phone: "5533", agendaName: "Agenda", chatName: "Chat", pushName: "Perfil" }), "Agenda");
  assert.equal(pickHistoryName({ isGroup: false, phone: "5533", chatName: "Chat", pushName: "Perfil" }), "Chat");
  assert.equal(pickHistoryName({ isGroup: false, phone: "5533", pushName: "Perfil" }), "Perfil");
  assert.equal(pickHistoryName({ isGroup: false, phone: "5533" }), "5533");
  assert.equal(pickHistoryName({ isGroup: true, phone: "x@g.us", chatName: "Equipe Compras" }), "Equipe Compras");
  assert.equal(pickHistoryName({ isGroup: true, phone: "x@g.us" }), "Grupo do WhatsApp");
});

const t0 = 1_760_000_000; // segundos
const batch = () => ({
  sessionKey: keyAtivos,
  messages: [
    { remoteJid: "5533988887777@s.whatsapp.net", id: `H1-${rnd}`, fromMe: false, isGroup: false, pushName: "Zé", timestamp: t0, message: { conversation: "Tem tela do A12?" } },
    { remoteJid: "5533988887777@s.whatsapp.net", id: `H2-${rnd}`, fromMe: true, isGroup: false, timestamp: t0 + 60, message: { conversation: "Manda 10 unidades" } },
    { remoteJid: "5533988887777@s.whatsapp.net", id: `H3-${rnd}`, fromMe: false, isGroup: false, pushName: "Zé", timestamp: t0 + 120, mediaType: "image" as const, mediaMimeType: "image/jpeg", message: { imageMessage: { caption: "nota" } } },
    { remoteJid: "1203630999@g.us", id: `G1-${rnd}`, fromMe: false, isGroup: true, participant: "5533911112222@s.whatsapp.net", pushName: "Maria", chatName: "Compras Sheikcell", timestamp: t0 + 30, message: { conversation: "Pedido fechado" } },
  ],
});

test("histórico: cria conversa em Ativos com o responsável, nome da agenda, mensagens nos dois sentidos com a data original", async () => {
  const r = await processWAHistoryBatch(batch());
  assert.equal(r.skipped, undefined);
  assert.equal(r.conversationsCreated, 2);
  assert.equal(r.messagesInserted, 4);

  const [conv] = await db.select().from(conversationsTable)
    .where(and(eq(conversationsTable.tenantId, tenantId), eq(conversationsTable.phone, "5533988887777")));
  assert.ok(conv);
  assert.equal(conv.name, "Fornecedor Peças BH");
  assert.equal(conv.status, "open");
  assert.equal(conv.assigneeId, userId);
  assert.equal(conv.unreadCount, 0);
  assert.equal(conv.lastMessage, "nota");
  assert.equal(conv.lastMessageAt?.getTime(), (t0 + 120) * 1000);

  const msgs = await db.select().from(messagesTable).where(eq(messagesTable.conversationId, conv.id)).orderBy(asc(messagesTable.createdAt));
  assert.deepEqual(msgs.map((m) => m.direction), ["inbound", "outbound", "inbound"]);
  assert.equal(msgs[0]!.createdAt.getTime(), t0 * 1000);
  assert.equal(msgs[1]!.senderName, "Compras");
  assert.equal(msgs[2]!.type, "image");
  assert.equal(msgs[2]!.mediaUrl, null);

  const [group] = await db.select().from(conversationsTable)
    .where(and(eq(conversationsTable.tenantId, tenantId), eq(conversationsTable.phone, "1203630999@g.us")));
  assert.equal(group?.name, "Compras Sheikcell");
  assert.equal(group?.assigneeId, userId);
  const [gmsg] = await db.select().from(messagesTable).where(eq(messagesTable.conversationId, group!.id));
  assert.equal(gmsg?.senderPhone, "5533911112222");

  // Ficha do CRM com o mesmo nome, em "Ativo" com o responsável.
  const [crm] = await db.select().from(crmContactsTable)
    .where(and(eq(crmContactsTable.tenantId, tenantId), eq(crmContactsTable.phone, "5533988887777")));
  assert.equal(crm?.name, "Fornecedor Peças BH");
  assert.equal(crm?.status, "active");
  assert.equal(crm?.attendantId, userId);
});

test("histórico reenviado não duplica mensagens nem conversas", async () => {
  const r = await processWAHistoryBatch(batch());
  assert.equal(r.conversationsCreated, 0);
  assert.equal(r.messagesInserted, 0);
  const convs = await db.select().from(conversationsTable).where(eq(conversationsTable.sessionKey, keyAtivos));
  assert.equal(convs.length, 2); // a conversa 1:1 e o grupo
});

test("linha com a opção desligada não importa nada", async () => {
  const r = await processWAHistoryBatch({ ...batch(), sessionKey: keyOff });
  assert.equal(r.skipped, "disabled");
  const convs = await db.select().from(conversationsTable).where(eq(conversationsTable.sessionKey, keyOff));
  assert.equal(convs.length, 0);
});

test("sem responsável, conversas antigas vão para Resolvidas (não enchem Potenciais)", async () => {
  await processWAHistoryBatch({
    sessionKey: keySemDono,
    messages: [{ remoteJid: "5533977776666@s.whatsapp.net", id: `S1-${rnd}`, fromMe: false, isGroup: false, pushName: "Cliente", timestamp: t0, message: { conversation: "oi" } }],
  });
  const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.sessionKey, keySemDono));
  assert.equal(conv?.status, "resolved");
  assert.equal(conv?.assigneeId, null);
});

test("arquivada no celular vai para Resolvidas, mesmo com responsável fixo (só as abertas viram Ativos)", async () => {
  await processWAHistoryBatch({
    sessionKey: keyAtivos,
    messages: [
      { remoteJid: "5533977776666@s.whatsapp.net", id: `ARQ1-${rnd}`, fromMe: false, isGroup: false, pushName: "Antigo", chatArchived: true, timestamp: t0, message: { conversation: "oi, faz tempo" } },
    ],
  });
  const [conv] = await db.select().from(conversationsTable)
    .where(and(eq(conversationsTable.tenantId, tenantId), eq(conversationsTable.phone, "5533977776666")));
  assert.equal(conv?.status, "resolved");
  assert.equal(conv?.assigneeId, null);
});

test("aviso de arquivada que chega depois fecha só a conversa recém-importada e intocada", async () => {
  await processWAHistoryBatch({
    sessionKey: keyAtivos,
    messages: [
      { remoteJid: "5533922221111@s.whatsapp.net", id: `ARQ2-${rnd}`, fromMe: false, isGroup: false, pushName: "Tardio", timestamp: t0, message: { conversation: "pedido antigo" } },
      { remoteJid: "5533922220000@s.whatsapp.net", id: `ARQ3-${rnd}`, fromMe: false, isGroup: false, pushName: "Vivo", timestamp: t0, message: { conversation: "pedido antigo 2" } },
    ],
  });
  // A segunda recebeu mensagem nova depois da importação: atendimento de verdade.
  await db.update(conversationsTable).set({ lastMessageAt: new Date(Date.now() + 60_000) })
    .where(and(eq(conversationsTable.tenantId, tenantId), eq(conversationsTable.phone, "5533922220000")));

  const r = await processWAHistoryArchived({ sessionKey: keyAtivos, jids: ["5533922221111@s.whatsapp.net", "5533922220000@s.whatsapp.net"] });
  assert.equal(r.resolved, 1);
  const rows = await db.select().from(conversationsTable)
    .where(and(eq(conversationsTable.tenantId, tenantId), eq(conversationsTable.sessionKey, keyAtivos)));
  const byPhone = new Map(rows.map((c) => [c.phone, c]));
  assert.equal(byPhone.get("5533922221111")?.status, "resolved");
  assert.equal(byPhone.get("5533922221111")?.assigneeId, null);
  assert.equal(byPhone.get("5533922220000")?.status, "open");
  assert.equal(byPhone.get("5533922220000")?.assigneeId, userId);

  // Linha sem a opção ligada: ignora.
  assert.equal((await processWAHistoryArchived({ sessionKey: keyOff, jids: ["5533922220000@s.whatsapp.net"] })).resolved, 0);
});

test("mensagem ao vivo numa linha com responsável fixo já nasce em Ativos com ele", async () => {
  await processInboundWA({
    sessionKey: keyAtivos,
    isGroupMsg: false,
    data: {
      key: { remoteJid: "5533955554444@s.whatsapp.net", fromMe: false, id: `L1-${rnd}` },
      message: { conversation: "Bom dia, chegou o pedido?" },
      pushName: "Transportadora",
    },
  });
  const [conv] = await db.select().from(conversationsTable)
    .where(and(eq(conversationsTable.tenantId, tenantId), eq(conversationsTable.phone, "5533955554444")));
  assert.equal(conv?.assigneeId, userId);
  assert.equal(conv?.status, "open");
  assert.ok(conv?.attendanceStartedAt);
});

test("nome da agenda que chega depois troca o telefone pelo nome, sem mexer em nome editado", async () => {
  await processWAHistoryBatch({
    sessionKey: keyAtivos,
    messages: [
      { remoteJid: "5533944443333@s.whatsapp.net", id: `N1-${rnd}`, fromMe: true, isGroup: false, timestamp: t0, message: { conversation: "Pagamento feito" } },
      { remoteJid: "5533922221111@s.whatsapp.net", id: `N2-${rnd}`, fromMe: true, isGroup: false, timestamp: t0, message: { conversation: "ok" } },
    ],
  });
  const phoneOnly = await db.select().from(conversationsTable)
    .where(and(eq(conversationsTable.tenantId, tenantId), eq(conversationsTable.phone, "5533944443333")));
  assert.equal(phoneOnly[0]?.name, "5533944443333");
  // Alguém renomeou esta à mão no CRM.
  await db.update(conversationsTable).set({ name: "Contador Tales" })
    .where(and(eq(conversationsTable.tenantId, tenantId), eq(conversationsTable.phone, "5533922221111")));

  await processInboundWAContacts({
    sessionKey: keyAtivos,
    contacts: [
      { jid: "5533944443333@s.whatsapp.net", phone: "5533944443333", name: "Banco Boletos" },
      { jid: "5533922221111@s.whatsapp.net", phone: "5533922221111", name: "Escritório" },
    ],
  });
  const [renamed] = await db.select().from(conversationsTable)
    .where(and(eq(conversationsTable.tenantId, tenantId), eq(conversationsTable.phone, "5533944443333")));
  assert.equal(renamed?.name, "Banco Boletos");
  const [kept] = await db.select().from(conversationsTable)
    .where(and(eq(conversationsTable.tenantId, tenantId), eq(conversationsTable.phone, "5533922221111")));
  assert.equal(kept?.name, "Contador Tales");
});

test("mensagem digitada no celular: só grava com a opção ligada, como enviada, sem duplicar", async () => {
  const own = (id: string, text: string) => ({
    sessionKey: keyAtivos,
    isGroupMsg: false,
    data: {
      key: { remoteJid: "5533988887777@s.whatsapp.net", fromMe: true, id },
      message: { conversation: text },
      messageTimestamp: t0 + 600,
    },
  });
  // Desligada (padrão): ignora.
  await processInboundWA(own(`P0-${rnd}`, "não deve aparecer"));
  const [conv] = await db.select().from(conversationsTable)
    .where(and(eq(conversationsTable.tenantId, tenantId), eq(conversationsTable.phone, "5533988887777")));
  let msgs = await db.select().from(messagesTable).where(eq(messagesTable.externalId, `P0-${rnd}`));
  assert.equal(msgs.length, 0);

  await db.update(whatsappSessionsTable).set({ phoneOutboundEnabled: true }).where(eq(whatsappSessionsTable.sessionKey, keyAtivos));
  await processInboundWA(own(`P1-${rnd}`, "Pode mandar pela transportadora"));
  await processInboundWA(own(`P1-${rnd}`, "Pode mandar pela transportadora")); // reentrega
  msgs = await db.select().from(messagesTable).where(eq(messagesTable.externalId, `P1-${rnd}`));
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0]!.direction, "outbound");
  assert.equal(msgs[0]!.conversationId, conv!.id);
  assert.equal(msgs[0]!.senderName, "Celular (Compras)");
  const [after] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, conv!.id));
  assert.equal(after?.lastMessage, "Pode mandar pela transportadora");
  assert.equal(after?.lastMessageDirection, "outbound");
  assert.equal(after?.unreadCount, conv!.unreadCount);

  // Apagar pelo celular atualiza a mensagem no CRM.
  await processInboundWA({
    sessionKey: keyAtivos,
    isGroupMsg: false,
    data: { key: { remoteJid: "5533988887777@s.whatsapp.net", fromMe: true, id: `P2-${rnd}` }, revoke: { targetId: `P1-${rnd}` } },
  });
  const [revoked] = await db.select().from(messagesTable).where(eq(messagesTable.externalId, `P1-${rnd}`));
  assert.ok(revoked?.deletedAt);
});

test("conversa criada pelo celular puxa o nome já cadastrado na ficha do CRM", async () => {
  await db.insert(crmContactsTable).values({ tenantId, name: "Loja Parceira Itambacuri", contact: "5533933332222", phone: "5533933332222" });
  await db.update(whatsappSessionsTable).set({ phoneOutboundEnabled: true }).where(eq(whatsappSessionsTable.sessionKey, keyAtivos));
  await processInboundWA({
    sessionKey: keyAtivos,
    isGroupMsg: false,
    data: { key: { remoteJid: "5533933332222@s.whatsapp.net", fromMe: true, id: `R1-${rnd}` }, message: { conversation: "Bom dia! Por nada" } },
  });
  const [conv] = await db.select().from(conversationsTable)
    .where(and(eq(conversationsTable.tenantId, tenantId), eq(conversationsTable.phone, "5533933332222")));
  assert.equal(conv?.name, "Loja Parceira Itambacuri");
});
