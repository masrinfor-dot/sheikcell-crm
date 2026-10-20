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

const { db, tenantsTable, whatsappSessionsTable, erpForwardQueueTable } = await import("@workspace/db");
const { eq, and } = await import("drizzle-orm");
const { enqueueErpForward, sessionForwardsToErp, erpForwardConfigured, resolveErpCredentials, runErpForwardQueue } = await import("./erpForward.ts");

const MARK = "__TEST_ERP_FORWARD__";
const rnd = Math.random().toString(36).slice(2, 10);
const keyCompras = `test-erp-compras-${rnd}`;
let tenantId: number;

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
  await db.insert(whatsappSessionsTable).values({ tenantId, sessionKey: keyCompras, displayName: "Compras", status: "connected" });
});

after(async () => {
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
