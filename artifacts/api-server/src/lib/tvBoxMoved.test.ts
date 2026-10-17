import { test, before, after } from "node:test";
import assert from "node:assert/strict";

process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";

const { db, tenantsTable, tvBoxClientsTable, tvBoxInvoicesTable, appSettingsTable } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const { generateTvBoxInvoicesForMonth } = await import("./tvBoxBilling.ts");
const { sendTvBoxReminders, sendTvBoxCharges } = await import("./tvBoxMessaging.ts");
const { setTvBoxMovedToErp, tvBoxMovedToErp, tenantsWithTvBoxMoved } = await import("./tvBoxMoved.ts");
const { buildTvBoxExport } = await import("./tvBoxExport.ts");

// TV Box passada para o ERP (17/10/2026): depois do "Desligar no CRM", o CRM
// não gera fatura, não lembra e não cobra — nunca cobrar em dobro com o ERP.
const MARK = "__TEST_TVBOX_MOVED__";
let tenantId: number;
let clientId: number;

before(async () => {
  await db.delete(tenantsTable).where(eq(tenantsTable.name, MARK));
  const [tenant] = await db.insert(tenantsTable).values({ name: MARK }).returning();
  tenantId = tenant!.id;
  const [client] = await db.insert(tvBoxClientsTable).values({
    // Começa suspenso: só fica ativo enquanto a loja está desligada no CRM —
    // assim os outros testes que geram faturas de TODAS as lojas não contam
    // este cliente.
    tenantId, name: "Cliente Mudou", phone: "5533988887777", monthlyValueCents: 4990, dueDay: 10, status: "suspenso",
  }).returning();
  clientId = client!.id;
});

after(async () => {
  await db.delete(tvBoxInvoicesTable).where(eq(tvBoxInvoicesTable.tenantId, tenantId));
  await db.delete(tvBoxClientsTable).where(eq(tvBoxClientsTable.tenantId, tenantId));
  await db.delete(appSettingsTable).where(eq(appSettingsTable.tenantId, tenantId));
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
});

test("começa ligado no CRM e o arquivo diz que a cobrança do CRM está ativa", async () => {
  assert.equal(await tvBoxMovedToErp(tenantId), false);
  const exp = await buildTvBoxExport(tenantId);
  assert.equal(exp.kind, "tv-box");
  assert.equal(exp.version, 1);
  assert.equal(exp.crmBillingDisabled, false);
  assert.equal(exp.clients.length, 1);
  assert.equal(exp.clients[0]!.id, clientId);
});

test("desligado no CRM: não gera a mensalidade do mês (o ERP é quem gera)", async () => {
  await setTvBoxMovedToErp(tenantId, true);
  assert.equal(await tvBoxMovedToErp(tenantId), true);
  assert.ok((await tenantsWithTvBoxMoved()).has(tenantId));
  await db.update(tvBoxClientsTable).set({ status: "ativo" }).where(eq(tvBoxClientsTable.id, clientId));
  await generateTvBoxInvoicesForMonth("2026-05");
  const rows = await db.select().from(tvBoxInvoicesTable).where(eq(tvBoxInvoicesTable.clientId, clientId));
  assert.equal(rows.length, 0, "CRM desligado não pode gerar fatura — o ERP cobraria em dobro");
});

test("desligado no CRM: não manda lembrete nem cobrança pelo WhatsApp", async () => {
  const now = new Date();
  const inTwoDays = new Date(now.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
  const tenDaysAgo = new Date(now.getTime() - 10 * 86_400_000).toISOString().slice(0, 10);
  const [upcoming] = await db.insert(tvBoxInvoicesTable).values({
    tenantId, clientId, amountCents: 4990, dueDate: inTwoDays,
  }).returning();
  const [overdue] = await db.insert(tvBoxInvoicesTable).values({
    tenantId, clientId, amountCents: 4990, dueDate: tenDaysAgo,
  }).returning();

  await sendTvBoxReminders(now, tenantId);
  await sendTvBoxCharges(now, tenantId);

  const [u] = await db.select().from(tvBoxInvoicesTable).where(eq(tvBoxInvoicesTable.id, upcoming!.id));
  const [o] = await db.select().from(tvBoxInvoicesTable).where(eq(tvBoxInvoicesTable.id, overdue!.id));
  assert.equal(u!.reminderSentAt, null, "lembrete não pode sair do CRM desligado");
  assert.equal(o!.lastChargeSentAt, null, "cobrança não pode sair do CRM desligado");
});

test("o arquivo exportado depois de desligar libera o ERP (crmBillingDisabled = true) e leva as faturas", async () => {
  const exp = await buildTvBoxExport(tenantId);
  assert.equal(exp.crmBillingDisabled, true);
  assert.equal(exp.invoices.length, 2);
  assert.ok(exp.invoices.every((i) => i.clientId === clientId));
});

test("religado no CRM: o agendador volta a considerar a loja e o arquivo volta a travar o ERP", async () => {
  await db.update(tvBoxClientsTable).set({ status: "suspenso" }).where(eq(tvBoxClientsTable.id, clientId));
  await setTvBoxMovedToErp(tenantId, false);
  assert.equal((await tenantsWithTvBoxMoved()).has(tenantId), false);
  const exp = await buildTvBoxExport(tenantId);
  assert.equal(exp.crmBillingDisabled, false);
});
