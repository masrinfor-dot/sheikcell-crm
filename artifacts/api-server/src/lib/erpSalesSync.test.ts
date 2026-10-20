import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";
process.env["SESSION_SECRET"] ??= "isolation-test-secret";
process.env["OPENAI_API_KEY"] ??= "sk-fake-isolation-test";
process.env["WHATSAPP_BRIDGE_URL"] ??= "http://localhost:3002";
process.env["NODE_ENV"] ??= "development";

const {
  db, tenantsTable, usersTable, conversationsTable, attendanceLogsTable, sectorsTable, storesTable,
  tenantErpIntegrationsTable, erpSalesSyncTable,
} = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const { collectAttendances, syncTenantSales, phoneForErp, erpPeriod, SALES_HISTORY_DAYS } = await import("./erpSalesSync.ts");
const { encryptErpSecret } = await import("./erpCrypto.ts");

// Vendas do atendimento (19/10/2026): o CRM manda os atendimentos ao ERP
// (telefone, atendente, setor, loja, último contato, conversa), em lotes com
// cursor — rodar de novo não manda o que já foi.

const MARK = "__TEST_ERP_SALES__";
const rnd = Math.random().toString(36).slice(2, 10);
let tenantId: number;
let anaId: number;
let biaId: number;
let convAssigned: number;
let convResolved: number;
const now = new Date();
const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 3600_000);

before(async () => {
  await db.delete(tenantsTable).where(eq(tenantsTable.name, MARK));
  const [tenant] = await db.insert(tenantsTable).values({ name: MARK }).returning();
  tenantId = tenant!.id;
  const [ana] = await db.insert(usersTable).values({
    tenantId, name: "Ana Vendas", email: `ana-${rnd}@vendas.invalid`, passwordHash: "x", role: "vendedor", isActive: true, storeName: "PP",
  }).returning();
  const [bia] = await db.insert(usersTable).values({
    tenantId, name: "Bia", email: `bia-${rnd}@vendas.invalid`, passwordHash: "x", role: "vendedor", isActive: false,
  }).returning();
  anaId = ana!.id; biaId = bia!.id;
  const [sector] = await db.insert(sectorsTable).values({ tenantId, name: "Vendas" }).returning();
  const [store] = await db.insert(storesTable).values({ tenantId, name: "Loja SJ" }).returning();

  // 1) Em atendimento com a Ana (responsável atual).
  const [c1] = await db.insert(conversationsTable).values({
    tenantId, phone: "5533999991234", name: "Maria", channel: "whatsapp", sectorId: sector!.id, assigneeId: anaId,
    storeId: store!.id, status: "open", lastMessageAt: daysAgo(2), updatedAt: daysAgo(2),
  }).returning();
  convAssigned = c1!.id;
  // 2) Finalizada (sem responsável): atendente vem do último atendimento.
  const [c2] = await db.insert(conversationsTable).values({
    tenantId, phone: "5533988887777@s.whatsapp.net", name: "João", channel: "whatsapp", status: "resolved",
    lastMessageAt: daysAgo(3), updatedAt: daysAgo(3),
  }).returning();
  convResolved = c2!.id;
  await db.insert(attendanceLogsTable).values({
    tenantId, queueEntryId: 0, clientName: "João", sectorId: sector!.id, sectorName: "Vendas",
    attendantId: biaId, attendantName: "Bia", conversationId: convResolved, storeId: store!.id,
  });
  // Não vão: grupo, Instagram, sem atendente, velha demais.
  await db.insert(conversationsTable).values([
    { tenantId, phone: "120363@g.us", name: "Grupo", channel: "whatsapp", assigneeId: anaId, lastMessageAt: daysAgo(1), updatedAt: daysAgo(1) },
    { tenantId, phone: "17841400000", name: "Insta", channel: "instagram", assigneeId: anaId, lastMessageAt: daysAgo(1), updatedAt: daysAgo(1) },
    { tenantId, phone: "5533911112222", name: "Sem dono", channel: "whatsapp", lastMessageAt: daysAgo(1), updatedAt: daysAgo(1) },
    { tenantId, phone: "5533933334444", name: "Antigo", channel: "whatsapp", assigneeId: anaId, lastMessageAt: daysAgo(SALES_HISTORY_DAYS + 5), updatedAt: daysAgo(SALES_HISTORY_DAYS + 5) },
  ]);
  const enc = encryptErpSecret("erp_0123456789ab_SEGREDO-DE-TESTE-1234567890");
  await db.insert(tenantErpIntegrationsTable).values({
    tenantId, baseUrl: "https://erp.invalid/api/v1", encryptedApiKey: enc.ciphertext, iv: enc.iv, authTag: enc.authTag,
    keyVersion: enc.keyVersion, last4: "7890",
  });
  await db.insert(erpSalesSyncTable).values({ tenantId, enabled: true });
});

after(async () => {
  await db.delete(erpSalesSyncTable).where(eq(erpSalesSyncTable.tenantId, tenantId));
  await db.delete(tenantErpIntegrationsTable).where(eq(tenantErpIntegrationsTable.tenantId, tenantId));
  await db.delete(attendanceLogsTable).where(eq(attendanceLogsTable.tenantId, tenantId));
  await db.delete(conversationsTable).where(eq(conversationsTable.tenantId, tenantId));
  await db.delete(sectorsTable).where(eq(sectorsTable.tenantId, tenantId));
  await db.delete(storesTable).where(eq(storesTable.tenantId, tenantId));
  await db.delete(usersTable).where(eq(usersTable.tenantId, tenantId));
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
});

type Call = { url: string; body: any };
let calls: Call[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; });

test("phoneForErp: só celular/fixo com DDD; grupo e @lid não vão", () => {
  assert.equal(phoneForErp("5533999991234@s.whatsapp.net"), "5533999991234");
  assert.equal(phoneForErp("(33) 99999-1234"), "33999991234");
  assert.equal(phoneForErp("120363@g.us"), null);
  assert.equal(phoneForErp("12345@lid"), null);
  assert.equal(phoneForErp("99991234"), null);
});

test("collectAttendances: atendente atual ou o do último atendimento; pula grupo, Instagram e sem atendente", async () => {
  const { items, next, scanned } = await collectAttendances(tenantId, daysAgo(SALES_HISTORY_DAYS), 0);
  assert.equal(scanned, 5); // a antiga fica fora do período
  assert.ok(next);
  const byId = new Map(items.map((i) => [i.externalId, i]));
  assert.equal(items.length, 2);
  assert.deepEqual(
    { ...byId.get(String(convAssigned))!, lastContactAt: undefined },
    {
      externalId: String(convAssigned), phone: "5533999991234", customerName: "Maria",
      attendantExternalId: String(anaId), attendantName: "Ana Vendas", attendantEmail: `ana-${rnd}@vendas.invalid`,
      sectorName: "Vendas", storeName: "Loja SJ", lastContactAt: undefined,
    },
  );
  const resolved = byId.get(String(convResolved))!;
  assert.equal(resolved.attendantExternalId, String(biaId));
  assert.equal(resolved.phone, "5533988887777");
  assert.equal(resolved.storeName, "Loja SJ");
});

test("syncTenantSales: manda atendentes e atendimentos; 2ª rodada não manda de novo (cursor)", async () => {
  const first = await syncTenantSales(tenantId, now);
  assert.equal(first.error, null);
  assert.equal(first.sent, 2);
  const attendantsCall = calls.find((c) => c.url.endsWith("/integrations/crm-attendance/attendants"));
  assert.ok(attendantsCall);
  assert.equal(attendantsCall.body.full, true);
  assert.deepEqual(attendantsCall.body.items.map((a: any) => a.name).sort(), ["Ana Vendas", "Bia"]);
  const sent = calls.filter((c) => c.url.endsWith("/integrations/crm-attendance/attendances"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.body.items.length, 2);

  calls = [];
  const second = await syncTenantSales(tenantId, new Date(now.getTime() + 60_000));
  assert.equal(second.sent, 0);
  assert.equal(calls.length, 0, "nada novo: nem atendentes (1x por hora) nem atendimentos");

  // Mensagem nova na conversa da Maria: só ela vai de novo.
  await db.update(conversationsTable).set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(conversationsTable.id, convAssigned));
  const third = await syncTenantSales(tenantId, new Date(now.getTime() + 120_000));
  assert.equal(third.sent, 1);
  const again = calls.find((c) => c.url.endsWith("/attendances"))!;
  assert.equal(again.body.items[0].externalId, String(convAssigned));

  const [row] = await db.select().from(erpSalesSyncTable).where(eq(erpSalesSyncTable.tenantId, tenantId));
  assert.equal(row!.sentCount, 3);
  assert.equal(row!.lastError, null);
});

test("syncTenantSales: ERP fora — cursor não avança e o erro fica gravado", async () => {
  await db.update(conversationsTable).set({ updatedAt: new Date(Date.now() + 5_000) })
    .where(eq(conversationsTable.id, convResolved));
  const [before] = await db.select().from(erpSalesSyncTable).where(eq(erpSalesSyncTable.tenantId, tenantId));
  globalThis.fetch = (async () => new Response("fora", { status: 503 })) as typeof fetch;
  const r = await syncTenantSales(tenantId, new Date(now.getTime() + 180_000));
  assert.match(r.error ?? "", /ERP respondeu 503/);
  const [after1] = await db.select().from(erpSalesSyncTable).where(eq(erpSalesSyncTable.tenantId, tenantId));
  assert.equal(after1!.cursorId, before!.cursorId);
  assert.equal(after1!.cursorAt?.getTime(), before!.cursorAt?.getTime());
  assert.match(after1!.lastError ?? "", /503/);
});

test("erpPeriod: datas locais (Brasília) dos últimos N dias", () => {
  assert.deepEqual(erpPeriod(30, new Date("2026-10-19T02:00:00Z")), { from: "2026-09-18", to: "2026-10-18" });
});
