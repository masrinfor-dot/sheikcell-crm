import { test, before, after } from "node:test";
import assert from "node:assert/strict";

process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";
process.env["SESSION_SECRET"] ??= "isolation-test-secret";
process.env["OPENAI_API_KEY"] ??= "sk-fake-isolation-test";
process.env["WHATSAPP_BRIDGE_URL"] ??= "http://localhost:3002";
process.env["NODE_ENV"] ??= "development";

const { db, tenantsTable, conversationsTable, messagesTable, erpDemandCursorsTable } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const { usefulText, collectBatch, DEMAND_HISTORY_DAYS } = await import("./erpDemandSync.ts");

// Pedidos de clientes sem estoque (16/10/2026): só as mensagens DO CLIENTE da
// linha de atacado, últimos 90 dias na 1ª vez, depois só o que é novo.

const MARK = "__TEST_ERP_DEMAND__";
const rnd = Math.random().toString(36).slice(2, 10);
const keyAtacado = `test-atacado-${rnd}`;
const keyOutra = `test-outra-${rnd}`;
let tenantId: number;
let convId: number;
let lastInboundId: number;
const now = new Date("2026-10-16T12:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 3600_000);

before(async () => {
  await db.delete(tenantsTable).where(eq(tenantsTable.name, MARK));
  const [tenant] = await db.insert(tenantsTable).values({ name: MARK }).returning();
  tenantId = tenant!.id;
  const [c1] = await db.insert(conversationsTable).values({
    tenantId, phone: "5533988887777", name: "Loja do Zé", channel: "whatsapp", sessionKey: keyAtacado, lastMessageAt: daysAgo(1),
  }).returning();
  convId = c1!.id;
  // Grupo, outra linha e conversa velha: nenhuma deve entrar.
  const [grp] = await db.insert(conversationsTable).values({
    tenantId, phone: "1203630@g.us", name: "Grupo atacado", channel: "whatsapp", sessionKey: keyAtacado, lastMessageAt: daysAgo(1),
  }).returning();
  const [outra] = await db.insert(conversationsTable).values({
    tenantId, phone: "5533911112222", name: "Varejo", channel: "whatsapp", sessionKey: keyOutra, lastMessageAt: daysAgo(1),
  }).returning();
  await db.insert(conversationsTable).values({
    tenantId, phone: "5533933334444", name: "Antigo", channel: "whatsapp", sessionKey: keyAtacado, lastMessageAt: daysAgo(DEMAND_HISTORY_DAYS + 10),
  });
  const rows = await db.insert(messagesTable).values([
    { tenantId, conversationId: convId, content: "tem película iphone 11? quero 20", direction: "inbound", type: "text", createdAt: daysAgo(DEMAND_HISTORY_DAYS + 5) }, // velha demais
    { tenantId, conversationId: convId, content: "bom dia, tem capa a12?", direction: "inbound", type: "text", createdAt: daysAgo(3) },
    { tenantId, conversationId: convId, content: "Temos sim, 10 na loja", direction: "outbound", type: "text", createdAt: daysAgo(3) }, // vendedor: não vai
    { tenantId, conversationId: convId, content: "📷 Foto", direction: "inbound", type: "image", createdAt: daysAgo(2) }, // só mídia: não vai
    { tenantId, conversationId: convId, content: "e carregador tipo c, uns 30", direction: "inbound", type: "text", createdAt: daysAgo(1) },
    { tenantId, conversationId: grp!.id, content: "alguém tem fone?", direction: "inbound", type: "text", createdAt: daysAgo(1) },
    { tenantId, conversationId: outra!.id, content: "quero uma capa", direction: "inbound", type: "text", createdAt: daysAgo(1) },
  ]).returning({ id: messagesTable.id });
  lastInboundId = rows[4]!.id;
});

after(async () => {
  await db.delete(erpDemandCursorsTable).where(eq(erpDemandCursorsTable.tenantId, tenantId));
  await db.delete(messagesTable).where(eq(messagesTable.tenantId, tenantId));
  await db.delete(conversationsTable).where(eq(conversationsTable.tenantId, tenantId));
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
});

test("usefulText: ignora vazio, curto e marcador de mídia; limpa espaços", () => {
  assert.equal(usefulText(null), null);
  assert.equal(usefulText("ok"), null);
  assert.equal(usefulText("📷 Foto"), null);
  assert.equal(usefulText("🎤 Áudio (0:12)"), null);
  assert.equal(usefulText("  tem   capa   a12?  "), "tem capa a12?");
});

test("1ª rodada: só cliente, só 90 dias, só a linha de atacado, sem grupo", async () => {
  const { batch, cursors } = await collectBatch(tenantId, keyAtacado, 20, now);
  assert.equal(batch.length, 1);
  const c = batch[0]!;
  assert.equal(c.externalId, String(convId));
  assert.equal(c.customerName, "Loja do Zé");
  assert.equal(c.customerPhone, "5533988887777");
  assert.deepEqual(c.messages.map((m) => m.text), ["bom dia, tem capa a12?", "e carregador tipo c, uns 30"]);
  assert.equal(cursors.get(convId), lastInboundId);
});

test("depois do cursor: nada novo → lote vazio; mensagem nova → só ela", async () => {
  await db.insert(erpDemandCursorsTable).values({ conversationId: convId, tenantId, lastMessageId: lastInboundId, syncedAt: now });
  let r = await collectBatch(tenantId, keyAtacado, 20, now);
  assert.equal(r.batch.length, 0);
  assert.equal(r.cursors.size, 0);

  const [nova] = await db.insert(messagesTable).values({
    tenantId, conversationId: convId, content: "e fone bluetooth, 5", direction: "inbound", type: "text", createdAt: now,
  }).returning({ id: messagesTable.id });
  r = await collectBatch(tenantId, keyAtacado, 20, now);
  assert.equal(r.batch.length, 1);
  assert.deepEqual(r.batch[0]!.messages.map((m) => m.text), ["e fone bluetooth, 5"]);
  assert.equal(r.cursors.get(convId), nova!.id);
});
