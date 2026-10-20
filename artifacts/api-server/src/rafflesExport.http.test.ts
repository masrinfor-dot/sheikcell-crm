// Sorteios → ERP (17/10/2026): exportação (sorteios + resultados) e
// "desligar no CRM", de ponta a ponta pela API (banco de dev).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";

process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";
process.env["SESSION_SECRET"] ??= "raffles-export-test-secret";
process.env["OPENAI_API_KEY"] ??= "sk-fake-test";
process.env["WHATSAPP_BRIDGE_URL"] ??= "http://localhost:3002";
process.env["NODE_ENV"] ??= "development";
if (process.env["DATABASE_URL"]!.includes("prod")) throw new Error("DATABASE_URL parece de produção — abortando.");

const { db, tenantsTable, usersTable, rafflesTable, raffleDrawsTable, sectorsTable, appSettingsTable, OPTIONAL_MODULES } = await import("@workspace/db");
const { eq, inArray } = await import("drizzle-orm");
const { default: app } = await import("./app.ts");

const MARK = "__RAFFLES_EXPORT_TEST__";
let server: import("node:http").Server;
let baseUrl: string;
let tenantId: number;
let raffleId: number;

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
    return { status: res.status, body: json, headers: res.headers };
  };
}

async function wipe() {
  const t = await db.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.name, MARK));
  const ids = t.map((x) => x.id);
  if (!ids.length) return;
  await db.delete(raffleDrawsTable).where(inArray(raffleDrawsTable.tenantId, ids));
  await db.delete(rafflesTable).where(inArray(rafflesTable.tenantId, ids));
  await db.delete(sectorsTable).where(inArray(sectorsTable.tenantId, ids));
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
  const [adm] = await db.insert(usersTable).values([
    { tenantId, name: "Samuel", email: "admin@raffles-export.invalid", passwordHash: hash, role: "admin", isActive: true },
    { tenantId, name: "Vendedor", email: "vend@raffles-export.invalid", passwordHash: hash, role: "vendedor", isActive: true },
  ]).returning();
  const [sector] = await db.insert(sectorsTable).values({ tenantId, name: "Vendas" }).returning();
  const [raffle] = await db.insert(rafflesTable).values({
    tenantId, name: "Sorteio de sexta", prize: "Capinha", messageTemplate: "Parabéns {nome}!",
    storeName: "PADRE PARAISO", sectorIds: [sector!.id], recurrence: "weekly", dayOfWeek: 5,
    clientTypes: ["comprou"], createdById: adm!.id,
  }).returning();
  raffleId = raffle!.id;
  await db.insert(raffleDrawsTable).values({
    tenantId, raffleId, periodKey: "2026-10-10", eligibleCount: 12,
    winners: [{ phone: "5533999990001", name: "Ana", conversationId: 1, sent: true, attempts: 1 }],
  });
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const addr = server.address() as import("node:net").AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}/api`;
  assert.equal((await admin("POST", "/auth/login", { email: "admin@raffles-export.invalid", password: "SenhaForte123!" })).status, 200);
  assert.equal((await seller("POST", "/auth/login", { email: "vend@raffles-export.invalid", password: "SenhaForte123!" })).status, 200);
});

after(async () => {
  server?.close();
  await wipe();
  const { pool } = await import("@workspace/db");
  await pool.end().catch(() => {});
});

test("exporta os sorteios com os resultados, nomes no lugar dos ids", async () => {
  const r = await admin("GET", "/raffles/export");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition") ?? "", /sorteios-crm-/);
  assert.equal(r.body.version, 1);
  assert.equal(r.body.kind, "raffles");
  assert.equal(r.body.raffles.length, 1);
  const x = r.body.raffles[0];
  assert.equal(x.id, raffleId);
  assert.deepEqual(x.sectorNames, ["Vendas"]);
  assert.equal(x.createdByName, "Samuel");
  assert.equal(x.recurrence, "weekly");
  assert.equal(r.body.draws.length, 1);
  assert.deepEqual(r.body.draws[0].winners, [{ phone: "5533999990001", name: "Ana", sent: true }]);
});

test("só admin exporta e desliga", async () => {
  assert.equal((await seller("GET", "/raffles/export")).status, 403);
  assert.equal((await seller("PUT", "/raffles/moved", { moved: true })).status, 403);
});

test("desligado no CRM: criar/sortear/excluir devolvem 410, consulta continua", async () => {
  const r = await admin("PUT", "/raffles/moved", { moved: true, erpUrl: "https://erp.exemplo.com.br" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { moved: true, erpUrl: "https://erp.exemplo.com.br" });
  assert.equal((await seller("GET", "/raffles/moved")).body.moved, true);
  const created = await admin("POST", "/raffles", { name: "Novo", prize: "X", messageTemplate: "Oi" });
  assert.equal(created.status, 410);
  assert.equal(created.body.movedTo, "https://erp.exemplo.com.br/sorteios");
  assert.equal((await admin("POST", `/raffles/${raffleId}/run`, {})).status, 410);
  assert.equal((await admin("DELETE", `/raffles/${raffleId}`)).status, 410);
  assert.equal((await admin("GET", "/raffles")).status, 200);
  assert.equal((await admin("GET", `/raffles/${raffleId}/draws`)).body.length, 1);
  assert.equal((await admin("PUT", "/raffles/moved", { erpUrl: "javascript:alert(1)" })).status, 400);
  await admin("PUT", "/raffles/moved", { moved: false });
  assert.equal((await seller("GET", "/raffles/moved")).body.moved, false);
  assert.equal((await admin("POST", "/raffles", { name: "Novo", prize: "X", messageTemplate: "Oi" })).status, 201);
});
