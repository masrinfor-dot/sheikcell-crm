import { test, before, after } from "node:test";
import assert from "node:assert/strict";

process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";

const { db, tenantsTable, tvBoxClientsTable, tvBoxInvoicesTable } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const { generateTvBoxInvoicesForMonth } = await import("./tvBoxBilling.ts");

const MARK = "__TEST_TVBOX_BILLING__";
let tenantId: number;
let clientId: number;

before(async () => {
  await db.delete(tenantsTable).where(eq(tenantsTable.name, MARK));
  const [tenant] = await db.insert(tenantsTable).values({ name: MARK }).returning();
  tenantId = tenant!.id;
  const [client] = await db.insert(tvBoxClientsTable).values({
    tenantId, name: "Cliente Teste", phone: "5511987776002", monthlyValueCents: 3990, dueDay: 15,
  }).returning();
  clientId = client!.id;
});

after(async () => {
  await db.delete(tvBoxInvoicesTable).where(eq(tvBoxInvoicesTable.tenantId, tenantId));
  await db.delete(tvBoxClientsTable).where(eq(tvBoxClientsTable.tenantId, tenantId));
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
});

test("gera a fatura do mês com o vencimento no due_day do cliente", async () => {
  const created = await generateTvBoxInvoicesForMonth("2026-03");
  assert.equal(created, 1);
  const [inv] = await db.select().from(tvBoxInvoicesTable).where(eq(tvBoxInvoicesTable.clientId, clientId));
  assert.ok(inv, "fatura deveria ter sido criada");
  assert.equal(inv!.dueDate, "2026-03-15");
  assert.equal(inv!.amountCents, 3990);
  assert.equal(inv!.billingMonth, "2026-03");
  assert.equal(inv!.status, "pendente");
});

test("rodar de novo pro mesmo mês não duplica (idempotente)", async () => {
  const created = await generateTvBoxInvoicesForMonth("2026-03");
  assert.equal(created, 0);
  const rows = await db.select().from(tvBoxInvoicesTable).where(eq(tvBoxInvoicesTable.clientId, clientId));
  assert.equal(rows.length, 1);
});

test("ajusta o vencimento pra fevereiro curto (due_day 15 continua válido, mas due_day alto seria truncado)", async () => {
  await db.update(tvBoxClientsTable).set({ dueDay: 30 }).where(eq(tvBoxClientsTable.id, clientId));
  const created = await generateTvBoxInvoicesForMonth("2026-02");
  assert.equal(created, 1);
  const [inv] = await db.select().from(tvBoxInvoicesTable)
    .where(eq(tvBoxInvoicesTable.billingMonth, "2026-02"));
  assert.ok(inv);
  assert.equal(inv!.dueDate, "2026-02-28", "fevereiro de 2026 (não bissexto) tem 28 dias");
});

test("cliente suspenso não recebe fatura nova", async () => {
  await db.update(tvBoxClientsTable).set({ status: "suspenso" }).where(eq(tvBoxClientsTable.id, clientId));
  const created = await generateTvBoxInvoicesForMonth("2026-04");
  assert.equal(created, 0);
});
