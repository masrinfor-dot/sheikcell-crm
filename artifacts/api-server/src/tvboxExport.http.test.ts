// TV Box → ERP (17/10/2026): exportação e "Desligar no CRM", de ponta a ponta
// pela API (banco de dev). Depois de desligar, o painel é só consulta e o
// arquivo passa a dizer `crmBillingDisabled: true` (é o que libera a
// cobrança automática no ERP — nunca cobrar em dobro).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";

process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";
process.env["SESSION_SECRET"] ??= "tvbox-export-test-secret";
process.env["OPENAI_API_KEY"] ??= "sk-fake-test";
process.env["WHATSAPP_BRIDGE_URL"] ??= "http://localhost:3002";
process.env["NODE_ENV"] ??= "development";
if (process.env["DATABASE_URL"]!.includes("prod")) throw new Error("DATABASE_URL parece de produção — abortando.");

const { db, tenantsTable, usersTable, appSettingsTable, tvBoxClientsTable, tvBoxInvoicesTable, OPTIONAL_MODULES } = await import("@workspace/db");
const { eq, inArray } = await import("drizzle-orm");
const { default: app } = await import("./app.ts");

const MARK = "__TVBOX_EXPORT_TEST__";
let server: import("node:http").Server;
let baseUrl: string;
let tenantId: number;
let clientId: number;
let invoiceId: number;

function client() {
  let cookie = "";
  return async (method: string, p: string, body?: unknown) => {
    const res = await fetch(baseUrl + p, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0]!;
    let json: any = null;
    try { json = await res.json(); } catch { /* sem json */ }
    return { status: res.status, body: json };
  };
}

async function wipe() {
  const t = await db.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.name, MARK));
  const ids = t.map((x) => x.id);
  if (!ids.length) return;
  await db.delete(tvBoxInvoicesTable).where(inArray(tvBoxInvoicesTable.tenantId, ids));
  await db.delete(tvBoxClientsTable).where(inArray(tvBoxClientsTable.tenantId, ids));
  await db.delete(appSettingsTable).where(inArray(appSettingsTable.tenantId, ids));
  await db.delete(usersTable).where(inArray(usersTable.tenantId, ids));
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
}

const admin = client();
const seller = client();

before(async () => {
  await wipe();
  const [tenant] = await db.insert(tenantsTable).values({ name: MARK, enabledModules: [...OPTIONAL_MODULES] }).returning();
  tenantId = tenant!.id;
  const hash = await bcrypt.hash("SenhaForte123!", 10);
  await db.insert(usersTable).values([
    { tenantId, name: "Admin", email: "admin@tvbox-export.invalid", passwordHash: hash, role: "admin", isActive: true },
    { tenantId, name: "Vendedor", email: "vend@tvbox-export.invalid", passwordHash: hash, role: "supervisor", isActive: true },
  ]);
  // Suspenso de propósito: os testes de geração de faturas rodam sobre todas
  // as lojas e não podem contar este cliente.
  const [c] = await db.insert(tvBoxClientsTable).values({
    tenantId, name: "Maria TV", phone: "5533999990000", monthlyValueCents: 3990, dueDay: 5, status: "suspenso", notes: "box na sala",
  }).returning();
  clientId = c!.id;
  const [inv] = await db.insert(tvBoxInvoicesTable).values({
    tenantId, clientId, amountCents: 3990, dueDate: "2026-09-05", billingMonth: "2026-09", status: "pago", paidAt: new Date("2026-09-04T12:00:00Z"),
  }).returning();
  invoiceId = inv!.id;
  await db.insert(tvBoxInvoicesTable).values({ tenantId, clientId, amountCents: 3990, dueDate: "2026-10-05", billingMonth: "2026-10" });
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const addr = server.address() as import("node:net").AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}/api`;
  assert.equal((await admin("POST", "/auth/login", { email: "admin@tvbox-export.invalid", password: "SenhaForte123!" })).status, 200);
  assert.equal((await seller("POST", "/auth/login", { email: "vend@tvbox-export.invalid", password: "SenhaForte123!" })).status, 200);
});

after(async () => {
  server?.close();
  await wipe();
  const { pool } = await import("@workspace/db");
  await pool.end().catch(() => {});
});

test("exporta clientes e faturas com os ids do CRM", async () => {
  const r = await admin("GET", "/tvbox/export");
  assert.equal(r.status, 200);
  assert.equal(r.body.version, 1);
  assert.equal(r.body.kind, "tv-box");
  assert.equal(r.body.crmBillingDisabled, false);
  assert.equal(r.body.clients.length, 1);
  assert.deepEqual(
    { id: r.body.clients[0].id, phone: r.body.clients[0].phone, monthlyValueCents: r.body.clients[0].monthlyValueCents, dueDay: r.body.clients[0].dueDay },
    { id: clientId, phone: "5533999990000", monthlyValueCents: 3990, dueDay: 5 },
  );
  assert.equal(r.body.invoices.length, 2);
  const paid = r.body.invoices.find((i: any) => i.id === invoiceId);
  assert.equal(paid.status, "pago");
  assert.equal(paid.clientId, clientId);
  assert.ok(r.body.settings.reminderMessageTemplate);
});

test("só admin exporta e desliga", async () => {
  assert.equal((await seller("GET", "/tvbox/export")).status, 403);
  assert.equal((await seller("PUT", "/tvbox/moved", { moved: true })).status, 403);
});

test("desligado no CRM: painel só consulta, nada de cobrar/gerar, e o arquivo libera o ERP", async () => {
  const r = await admin("PUT", "/tvbox/moved", { moved: true, erpUrl: "https://erp.exemplo.com.br" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { moved: true, erpUrl: "https://erp.exemplo.com.br" });
  assert.equal((await admin("GET", "/tvbox/moved")).body.moved, true);

  const writes = [
    await admin("POST", "/tvbox/clients", { name: "Novo", phone: "33999998888", monthlyValueCents: 3000, dueDay: 10 }),
    await admin("PATCH", `/tvbox/clients/${clientId}`, { status: "ativo" }),
    await admin("PATCH", `/tvbox/invoices/${invoiceId}`, { status: "pendente" }),
    await admin("POST", "/tvbox/invoices/generate"),
    await admin("PATCH", "/tvbox/settings", { enabled: true }),
  ];
  for (const w of writes) {
    assert.equal(w.status, 410);
    assert.match(w.body.error, /ERP/);
  }
  assert.equal((await admin("GET", "/tvbox/clients")).status, 200); // consulta continua
  assert.equal((await admin("GET", `/tvbox/invoices?clientId=${clientId}`)).body.length, 2);

  const exp = await admin("GET", "/tvbox/export");
  assert.equal(exp.body.crmBillingDisabled, true);

  assert.equal((await admin("PUT", "/tvbox/moved", { erpUrl: "javascript:alert(1)" })).status, 400);
  await admin("PUT", "/tvbox/moved", { moved: false });
  assert.equal((await admin("GET", "/tvbox/moved")).body.moved, false);
});
