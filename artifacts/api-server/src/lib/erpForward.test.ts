import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";
process.env["SESSION_SECRET"] ??= "isolation-test-secret";
process.env["OPENAI_API_KEY"] ??= "sk-fake-isolation-test";
process.env["WHATSAPP_BRIDGE_URL"] ??= "http://localhost:3002";
process.env["NODE_ENV"] ??= "development";

// ERP de mentira: guarda o que recebe e responde o que o teste mandar.
type Received = { path: string; apiKey: string | undefined; body: Record<string, unknown> };
const received: Received[] = [];
let respondWith: { status: number; body: unknown } = { status: 200, body: { lists: [{ id: "lista-1", status: "PENDING", duplicate: false }] } };
const erp: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    received.push({ path: req.url ?? "", apiKey: req.headers["x-api-key"] as string | undefined, body: raw ? JSON.parse(raw) : {} });
    res.writeHead(respondWith.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(respondWith.body));
  });
});
await new Promise<void>((r) => erp.listen(0, "127.0.0.1", () => r()));
const port = (erp.address() as AddressInfo).port;
// Sem integração gravada para a loja de teste, o módulo cai nas variáveis do
// servidor — definidas ANTES do import (são lidas ao carregar o módulo).
process.env["ERP_API_URL"] = `http://127.0.0.1:${port}/api/v1/`;
process.env["ERP_API_KEY"] = "erp_teste_chave";

const { db, tenantsTable, whatsappSessionsTable, erpForwardQueueTable, conversationsTable, messagesTable } = await import("@workspace/db");
const { eq, and, inArray } = await import("drizzle-orm");
const {
  enqueueErpForward, sessionForwardsToErp, erpForwardConfigured, resolveErpCredentials, runErpForwardQueue,
  erpForwardSummary, enqueueErpForwardHistory, retryFailedErpForward,
} = await import("./erpForward.ts");

const MARK = "__TEST_ERP_FORWARD__";
const rnd = Math.random().toString(36).slice(2, 10);
const keyCompras = `test-erp-compras-${rnd}`;
/** Segunda conexão, só para as conversas anteriores (fila própria, contagens exatas). */
const keyHist = `test-erp-hist-${rnd}`;
let tenantId: number;
const convIds: number[] = [];

async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 5_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v != null) return v;
    if (Date.now() > until) throw new Error("waitFor: tempo esgotado");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function rowByExternalId(externalId: string) {
  const [row] = await db.select().from(erpForwardQueueTable).where(eq(erpForwardQueueTable.externalId, externalId)).limit(1);
  return row ?? null;
}

/** Espera a linha sair de pending/processing (o envio é disparado sem esperar). */
async function settled(externalId: string) {
  return waitFor(async () => {
    const row = await rowByExternalId(externalId);
    return row && row.status !== "processing" && (row.status !== "pending" || row.attempts > 0) ? row : null;
  });
}

const baseInput = (externalId: string) => ({
  tenantId, sessionKey: keyCompras, externalId, conversationId: 123,
  senderPhone: "5533988887777", senderName: "Fornecedor Peças", receivedAt: new Date("2026-10-19T12:00:00Z"),
  text: null as string | null, fileName: null as string | null, mimeType: null as string | null,
  mediaUrl: null as string | null, mediaBase64: null as string | null,
});

before(async () => {
  await db.delete(tenantsTable).where(eq(tenantsTable.name, MARK));
  const [tenant] = await db.insert(tenantsTable).values({ name: MARK }).returning();
  tenantId = tenant!.id;
  await db.insert(whatsappSessionsTable).values([
    { tenantId, sessionKey: keyCompras, displayName: "Compras", status: "connected" },
    { tenantId, sessionKey: keyHist, displayName: "Compras (histórico)", status: "connected", forwardToErp: true },
  ]);
});

after(async () => {
  if (convIds.length) {
    await db.delete(messagesTable).where(inArray(messagesTable.conversationId, convIds));
    await db.delete(conversationsTable).where(inArray(conversationsTable.id, convIds));
  }
  await db.delete(erpForwardQueueTable).where(eq(erpForwardQueueTable.tenantId, tenantId));
  await db.delete(whatsappSessionsTable).where(eq(whatsappSessionsTable.tenantId, tenantId));
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
  await new Promise<void>((r) => erp.close(() => r()));
});

test("credenciais: sem integração gravada, usa ERP_API_URL/ERP_API_KEY (sem barra no fim)", async () => {
  const creds = await resolveErpCredentials(tenantId);
  assert.ok(creds);
  assert.equal(creds.source, "env");
  assert.equal(creds.baseUrl, `http://127.0.0.1:${port}/api/v1`);
  assert.equal(creds.apiKey, "erp_teste_chave");
  assert.equal(await erpForwardConfigured(tenantId), true);
});

test("só a conexão marcada encaminha; marcar liga a flag", async () => {
  assert.equal(await sessionForwardsToErp(keyCompras, tenantId), false);
  await db.update(whatsappSessionsTable).set({ forwardToErp: true })
    .where(and(eq(whatsappSessionsTable.sessionKey, keyCompras), eq(whatsappSessionsTable.tenantId, tenantId)));
  assert.equal(await sessionForwardsToErp(keyCompras, tenantId), true);
  // Outra loja com a mesma chave não vê a flag (isolamento).
  assert.equal(await sessionForwardsToErp(keyCompras, tenantId + 1), false);
});

test("texto vai ao ERP com a chave no X-Api-Key e a linha fica 'sent' (idempotente por externalId)", async () => {
  const externalId = `MSG-TXT-${rnd}`;
  await enqueueErpForward({ ...baseInput(externalId), text: "iPhone 13 128GB R$ 2.500 — tela A12 R$ 90" });
  const row = await settled(externalId);
  assert.equal(row.status, "sent");
  assert.equal(row.erpListId, "lista-1");
  assert.equal(row.lastError, null);
  const call = received.find((r) => r.body["externalId"] === externalId);
  assert.ok(call, "ERP recebeu a chamada");
  assert.equal(call.path, "/api/v1/integrations/supplier-price-lists");
  assert.equal(call.apiKey, "erp_teste_chave");
  assert.equal(call.body["senderPhone"], "5533988887777");
  assert.equal(call.body["senderName"], "Fornecedor Peças");
  assert.equal(call.body["sessionKey"], keyCompras);
  assert.equal(call.body["conversationRef"], "123");
  assert.equal(call.body["text"], "iPhone 13 128GB R$ 2.500 — tela A12 R$ 90");
  assert.equal(call.body["attachments"], undefined);
  // Reentrega da mesma mensagem: não duplica a linha nem chama o ERP de novo.
  const before = received.length;
  await enqueueErpForward({ ...baseInput(externalId), text: "repetida" });
  const rows = await db.select().from(erpForwardQueueTable).where(eq(erpForwardQueueTable.externalId, externalId));
  assert.equal(rows.length, 1);
  assert.equal(received.length, before);
});

test("planilha que o CRM não guardou vai inline como anexo (nome e tipo)", async () => {
  const externalId = `MSG-XLSX-${rnd}`;
  const b64 = Buffer.from("fake-xlsx").toString("base64");
  await enqueueErpForward({
    ...baseInput(externalId), fileName: "lista-outubro.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; charset=binary", mediaBase64: b64,
  });
  const row = await settled(externalId);
  assert.equal(row.status, "sent");
  const call = received.find((r) => r.body["externalId"] === externalId)!;
  const att = (call.body["attachments"] as Array<Record<string, string>>)[0]!;
  assert.equal(att["fileName"], "lista-outubro.xlsx");
  assert.equal(att["mimeType"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(att["dataBase64"], b64);
});

test("sem texto nem arquivo: nada entra na fila", async () => {
  const externalId = `MSG-VAZIA-${rnd}`;
  await enqueueErpForward(baseInput(externalId));
  assert.equal(await rowByExternalId(externalId), null);
});

test("ERP fora do ar: volta para 'pending' com espera; o tick reenvia quando vence", async () => {
  const externalId = `MSG-RETRY-${rnd}`;
  respondWith = { status: 503, body: { message: "indisponível" } };
  await enqueueErpForward({ ...baseInput(externalId), text: "lista" });
  let row = await settled(externalId);
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 1);
  assert.match(row.lastError ?? "", /503/);
  assert.ok(row.nextAttemptAt.getTime() > Date.now() + 30_000, "espera antes de tentar de novo");
  // Ainda não venceu: o tick não mexe.
  respondWith = { status: 200, body: { lists: [{ id: "lista-2", status: "PENDING", duplicate: false }] } };
  await runErpForwardQueue();
  row = (await rowByExternalId(externalId))!;
  assert.equal(row.status, "pending");
  // Venceu: o tick manda e marca 'sent'.
  await db.update(erpForwardQueueTable).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(erpForwardQueueTable.id, row.id));
  await runErpForwardQueue();
  row = (await rowByExternalId(externalId))!;
  assert.equal(row.status, "sent");
  assert.equal(row.erpListId, "lista-2");
  assert.equal(row.attempts, 1);
});

test("ERP recusou o conteúdo (400): marca 'failed' sem insistir", async () => {
  const externalId = `MSG-400-${rnd}`;
  respondWith = { status: 400, body: { message: "sem anexo legível" } };
  await enqueueErpForward({ ...baseInput(externalId), text: "???" });
  const row = await settled(externalId);
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 1);
  assert.match(row.lastError ?? "", /400/);
  respondWith = { status: 200, body: { lists: [] } };
});

// ─── Conversas anteriores (histórico já no CRM) ─────────────────────────────

type Conv = typeof conversationsTable.$inferSelect;
let seq = 0;

async function mkConv(input: { phone: string; name: string; sessionKey?: string; tenant?: number; isCommunity?: boolean }): Promise<Conv> {
  const [c] = await db.insert(conversationsTable).values({
    tenantId: input.tenant ?? tenantId, phone: input.phone, name: input.name,
    sessionKey: input.sessionKey ?? keyHist, isCommunity: input.isCommunity ?? false,
  }).returning();
  convIds.push(c!.id);
  return c!;
}

async function mkMsg(conv: Conv, input: {
  direction?: string; type?: string; content?: string; externalId?: string | null; mediaUrl?: string | null;
  metadata?: { fileName?: string; mimeType?: string } | null; createdAt?: Date; deletedAt?: Date | null;
}) {
  const [m] = await db.insert(messagesTable).values({
    tenantId: conv.tenantId, conversationId: conv.id,
    content: input.content ?? "", direction: input.direction ?? "inbound", type: input.type ?? "text",
    externalId: input.externalId === undefined ? `HIST-${rnd}-${++seq}` : input.externalId,
    mediaUrl: input.mediaUrl ?? null, metadata: input.metadata ?? null,
    createdAt: input.createdAt ?? new Date(), deletedAt: input.deletedAt ?? null,
  }).returning();
  return m!;
}

const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60_000);
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

let convIphone: Conv, convXiaomi: Conv, convGroup: Conv;
let msgText: Awaited<ReturnType<typeof mkMsg>>, msgFoto: typeof msgText, msgXlsx: typeof msgText, msgAntiga: typeof msgText;

test("resumo: conta só o que iria ao ERP (recebida, texto/foto/documento, não apagada, fora de grupo, da conexão e da loja)", async () => {
  convIphone = await mkConv({ phone: "5533911112222", name: "Fornecedor iPhone" });
  msgText = await mkMsg(convIphone, { content: "iPhone 15 128GB R$ 3.900 / iPhone 14 R$ 2.800" });
  msgFoto = await mkMsg(convIphone, { type: "image", content: "📷 Foto", mediaUrl: "/api/chat/media/foto-lista.jpg" });
  msgXlsx = await mkMsg(convIphone, { type: "doc", content: "📄 lista.xlsx", mediaUrl: "/api/chat/media/planilha.xlsx", metadata: { fileName: "lista.xlsx", mimeType: XLSX } });
  msgAntiga = await mkMsg(convIphone, { content: "lista de setembro", createdAt: daysAgo(40) });
  // Não contam:
  await mkMsg(convIphone, { type: "audio", content: "🎵 Áudio", mediaUrl: "/api/chat/media/a.ogg" });
  await mkMsg(convIphone, { type: "sticker", content: "🙂 Figurinha", mediaUrl: "/api/chat/media/s.webp" });
  await mkMsg(convIphone, { direction: "outbound", content: "pode mandar a lista?", externalId: null });
  await mkMsg(convIphone, { content: "apagada", deletedAt: new Date() });
  await mkMsg(convIphone, { content: "sem id do WhatsApp", externalId: null });
  await mkMsg(convIphone, { type: "image", content: "📷 Foto", mediaUrl: null }); // histórico sem o arquivo: nada para ler
  await mkMsg(convIphone, { content: "" });
  convXiaomi = await mkConv({ phone: "5533933334444", name: "Fornecedor Xiaomi" });
  await mkMsg(convXiaomi, { content: "Redmi Note 13 R$ 1.100" });
  convGroup = await mkConv({ phone: `1203630000${rnd}@g.us`, name: "Grupo Fornecedores" });
  await mkMsg(convGroup, { content: "lista no grupo" });
  const convComunidade = await mkConv({ phone: "5533955556666", name: "Comunidade", isCommunity: true });
  await mkMsg(convComunidade, { content: "lista na comunidade" });
  const convOutraConexao = await mkConv({ phone: "5533977778888", name: "Outra conexão", sessionKey: keyCompras });
  await mkMsg(convOutraConexao, { content: "lista em outra conexão" });
  const convOutraLoja = await mkConv({ phone: "5533999990000", name: "Outra loja", tenant: tenantId + 1 });
  await mkMsg(convOutraLoja, { content: "lista de outra loja" });

  const s = await erpForwardSummary(tenantId, keyHist, 30);
  assert.equal(s.configured, true);
  assert.equal(s.forwardToErp, true);
  assert.equal(s.days, 30);
  assert.deepEqual(s.queue, { pending: 0, processing: 0, sent: 0, failed: 0 });
  assert.deepEqual(
    s.conversations.map((c) => ({ id: c.id, phone: c.phone, name: c.name, messages: c.messages })),
    [
      { id: convIphone.id, phone: "5533911112222", name: "Fornecedor iPhone", messages: 3 },
      { id: convXiaomi.id, phone: "5533933334444", name: "Fornecedor Xiaomi", messages: 1 },
    ],
  );
  assert.equal(s.conversations[0]!.lastMessageAt, msgXlsx.createdAt.toISOString());
  // Período maior pega a mensagem antiga.
  const s60 = await erpForwardSummary(tenantId, keyHist, 60);
  assert.equal(s60.conversations.find((c) => c.id === convIphone.id)?.messages, 4);
  // Outra conexão / outra loja: nada da conexão de histórico vaza.
  const sCompras = await erpForwardSummary(tenantId, keyCompras, 30);
  assert.deepEqual(sCompras.conversations.map((c) => c.id), [convOutraConexao.id]);
  assert.equal(sCompras.queue.sent >= 1, true, "fila da conexão de compras é a dos testes acima");
  const sOutraLoja = await erpForwardSummary(tenantId + 1, keyHist, 30);
  assert.equal(sOutraLoja.forwardToErp, false);
  assert.deepEqual(sOutraLoja.conversations.map((c) => c.id), [convOutraLoja.id]);
});

test("histórico: enfileira sem mandar na hora, com o conteúdo certo, e é idempotente", async () => {
  const callsBefore = received.length;
  const r1 = await enqueueErpForwardHistory(tenantId, keyHist, 30);
  assert.deepEqual(r1, { queued: 4, alreadyQueued: 0, conversations: 2, skipped: 0 });
  assert.equal(received.length, callsBefore, "não dispara envio em rajada — quem manda é o tick");

  const rowText = (await rowByExternalId(msgText.externalId!))!;
  assert.equal(rowText.status, "pending");
  assert.equal(rowText.attempts, 0);
  assert.equal(rowText.sessionKey, keyHist);
  assert.equal(rowText.tenantId, tenantId);
  assert.equal(rowText.conversationId, convIphone.id);
  assert.equal(rowText.payload.text, "iPhone 15 128GB R$ 3.900 / iPhone 14 R$ 2.800");
  assert.equal(rowText.payload.senderPhone, "5533911112222");
  assert.equal(rowText.payload.senderName, "Fornecedor iPhone");
  assert.equal(rowText.payload.receivedAt, msgText.createdAt.toISOString());
  assert.equal(rowText.payload.mediaPath, null);
  assert.equal(rowText.payload.mediaBase64, null);

  const rowFoto = (await rowByExternalId(msgFoto.externalId!))!;
  assert.equal(rowFoto.payload.text, null, "placeholder '📷 Foto' não vai como texto");
  assert.equal(rowFoto.payload.mimeType, "image/jpeg", "tipo inferido pela extensão do arquivo");
  assert.equal(rowFoto.payload.fileName, null);
  assert.ok(rowFoto.payload.mediaPath?.endsWith("/foto-lista.jpg"));

  const rowXlsx = (await rowByExternalId(msgXlsx.externalId!))!;
  assert.equal(rowXlsx.payload.text, null);
  assert.equal(rowXlsx.payload.fileName, "lista.xlsx");
  assert.equal(rowXlsx.payload.mimeType, XLSX);
  assert.ok(rowXlsx.payload.mediaPath?.endsWith("/planilha.xlsx"));

  assert.equal(await rowByExternalId(msgAntiga.externalId!), null, "fora do período não entra");

  // Segunda chamada: nada duplica.
  const r2 = await enqueueErpForwardHistory(tenantId, keyHist, 30);
  assert.deepEqual(r2, { queued: 0, alreadyQueued: 4, conversations: 2, skipped: 0 });
  // Só alguns contatos, período maior: entra só o que faltava daquele contato.
  const r3 = await enqueueErpForwardHistory(tenantId, keyHist, 60, [convIphone.id]);
  assert.deepEqual(r3, { queued: 1, alreadyQueued: 3, conversations: 1, skipped: 0 });
  assert.equal((await rowByExternalId(msgAntiga.externalId!))?.status, "pending");
  // Grupo escolhido à mão continua fora.
  const r4 = await enqueueErpForwardHistory(tenantId, keyHist, 30, [convGroup.id]);
  assert.deepEqual(r4, { queued: 0, alreadyQueued: 0, conversations: 0, skipped: 0 });

  const s = await erpForwardSummary(tenantId, keyHist, 30);
  assert.deepEqual(s.queue, { pending: 5, processing: 0, sent: 0, failed: 0 });
});

test("tentar de novo: só as 'failed' desta conexão voltam para a fila", async () => {
  await db.update(erpForwardQueueTable).set({ status: "failed", attempts: 7, lastError: "ERP respondeu 400: sem anexo legível" })
    .where(eq(erpForwardQueueTable.externalId, msgText.externalId!));
  await db.update(erpForwardQueueTable).set({ status: "sent", sentAt: new Date() })
    .where(eq(erpForwardQueueTable.externalId, msgFoto.externalId!));
  const before = await erpForwardSummary(tenantId, keyHist, 30);
  assert.deepEqual(before.queue, { pending: 3, processing: 0, sent: 1, failed: 1 });
  const falhaCompras = (await rowByExternalId(`MSG-400-${rnd}`))!;
  assert.equal(falhaCompras.status, "failed", "a falha da outra conexão existe");

  assert.equal(await retryFailedErpForward(tenantId + 1, keyHist), 0, "outra loja não mexe");
  assert.equal(await retryFailedErpForward(tenantId, keyHist), 1);

  const rowText = (await rowByExternalId(msgText.externalId!))!;
  assert.equal(rowText.status, "pending");
  assert.equal(rowText.attempts, 0);
  assert.ok(rowText.nextAttemptAt.getTime() <= Date.now());
  assert.equal((await rowByExternalId(msgFoto.externalId!))?.status, "sent");
  assert.equal((await rowByExternalId(`MSG-400-${rnd}`))?.status, "failed", "falha de outra conexão fica como está");
  const after = await erpForwardSummary(tenantId, keyHist, 30);
  assert.deepEqual(after.queue, { pending: 4, processing: 0, sent: 1, failed: 0 });
  assert.equal(await retryFailedErpForward(tenantId, keyHist), 0);
});
