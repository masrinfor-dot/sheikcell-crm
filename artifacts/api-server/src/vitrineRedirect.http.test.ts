// "Redirecionar a vitrine pública para o ERP" (17/10/2026): desligado por
// padrão; ligado, /vitrine/<slug> e /avaliar/<slug> vão para <erp>/loja/<slug>.
// De ponta a ponta pela API (banco de dev).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";

process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";
process.env["SESSION_SECRET"] ??= "vitrine-redirect-test-secret";
process.env["OPENAI_API_KEY"] ??= "sk-fake-test";
process.env["WHATSAPP_BRIDGE_URL"] ??= "http://localhost:3002";
process.env["NODE_ENV"] ??= "development";
if (process.env["DATABASE_URL"]!.includes("prod")) throw new Error("DATABASE_URL parece de produção — abortando.");

const { db, tenantsTable, usersTable, appSettingsTable, tenantErpIntegrationsTable, OPTIONAL_MODULES } = await import("@workspace/db");
const { eq, inArray } = await import("drizzle-orm");
const { buildErpLojaUrl } = await import("./lib/vitrineRedirect");
const { default: app } = await import("./app.ts");

const MARK = "__VITRINE_REDIRECT_TEST__";
const SLUG = `vitrine-redirect-test-${process.pid}`;
let server: import("node:http").Server;
let root: string;
let tenantId: number;

function client() {
  let cookie = "";
  return async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${root}/api${p}`, {
      method,
      redirect: "manual",
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0]!;
    let json: any = null;
    try { json = await res.json(); } catch { /* sem json */ }
    return { status: res.status, body: json, location: res.headers.get("location") };
  };
}

async function wipe() {
  const t = await db.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.name, MARK));
  const ids = t.map((x) => x.id);
  if (!ids.length) return;
  await db.delete(tenantErpIntegrationsTable).where(inArray(tenantErpIntegrationsTable.tenantId, ids));
  await db.delete(appSettingsTable).where(inArray(appSettingsTable.tenantId, ids));
  await db.delete(usersTable).where(inArray(usersTable.tenantId, ids));
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
}

const admin = client();
const seller = client();
const visitor = client();

before(async () => {
  await wipe();
  const [tenant] = await db.insert(tenantsTable)
    .values({ name: MARK, enabledModules: [...OPTIONAL_MODULES], catalogSlug: SLUG }).returning();
  tenantId = tenant!.id;
  const hash = await bcrypt.hash("SenhaForte123!", 10);
  await db.insert(usersTable).values([
    { tenantId, name: "Admin", email: "admin@vitrine-redirect.invalid", passwordHash: hash, role: "admin", isActive: true },
    { tenantId, name: "Vendedor", email: "vend@vitrine-redirect.invalid", passwordHash: hash, role: "supervisor", isActive: true },
  ]);
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  root = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  assert.equal((await admin("POST", "/auth/login", { email: "admin@vitrine-redirect.invalid", password: "SenhaForte123!" })).status, 200);
  assert.equal((await seller("POST", "/auth/login", { email: "vend@vitrine-redirect.invalid", password: "SenhaForte123!" })).status, 200);
});

after(async () => {
  server?.close();
  await wipe();
  const { pool } = await import("@workspace/db");
  await pool.end().catch(() => {});
});

test("monta o endereço da loja no ERP só com endereço e slug válidos", () => {
  assert.equal(buildErpLojaUrl("https://erp.sheikcell.com.br/", "sheikcell"), "https://erp.sheikcell.com.br/loja/sheikcell");
  assert.equal(buildErpLojaUrl("https://erp.sheikcell.com.br", "SheikCell", "avaliar"), "https://erp.sheikcell.com.br/loja/sheikcell/avaliar");
  assert.equal(buildErpLojaUrl("javascript:alert(1)", "sheikcell"), null);
  assert.equal(buildErpLojaUrl(null, "sheikcell"), null);
  assert.equal(buildErpLojaUrl("https://erp.x.com", "../admin"), null);
});

test("desligado por padrão: a vitrine do CRM segue igual (sem 302, sem redirectTo)", async () => {
  const st = await admin("GET", "/catalog/erp-redirect");
  assert.equal(st.status, 200);
  assert.deepEqual(st.body, { enabled: false, erpWebUrl: null });
  assert.equal((await visitor("GET", `/public-redirect/vitrine/${SLUG}`)).status, 404);
  const pub = await visitor("GET", `/catalog-public/${SLUG}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.body.redirectTo, null);
});

test("sem o endereço do ERP não liga; só admin mexe", async () => {
  const r = await admin("PUT", "/catalog/erp-redirect", { enabled: true });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Testar/);
  assert.equal((await seller("PUT", "/catalog/erp-redirect", { enabled: true })).status, 403);
  assert.equal((await admin("PUT", "/catalog/erp-redirect", { enabled: "sim" })).status, 400);
});

test("ligado: /vitrine e /avaliar respondem 302 para a loja no ERP (mantém ?troca=1)", async () => {
  await db.insert(tenantErpIntegrationsTable).values({
    tenantId, baseUrl: "https://api.exemplo.com.br/api/v1", encryptedApiKey: "x", iv: "x", authTag: "x", last4: "abcd",
    erpWebUrl: "https://erp.exemplo.com.br",
  });
  const on = await admin("PUT", "/catalog/erp-redirect", { enabled: true });
  assert.equal(on.status, 200);
  assert.deepEqual(on.body, { enabled: true, erpWebUrl: "https://erp.exemplo.com.br" });

  const v = await visitor("GET", `/public-redirect/vitrine/${SLUG}`);
  assert.equal(v.status, 302);
  assert.equal(v.location, `https://erp.exemplo.com.br/loja/${SLUG}`);
  const a = await visitor("GET", `/public-redirect/avaliar/${SLUG}?troca=1`);
  assert.equal(a.status, 302);
  assert.equal(a.location, `https://erp.exemplo.com.br/loja/${SLUG}/avaliar?troca=1`);
  assert.equal((await visitor("GET", `/public-redirect/admin/${SLUG}`)).status, 404);
  assert.equal((await visitor("GET", "/public-redirect/vitrine/slug-que-nao-existe")).status, 404);

  // Reserva na própria página (app em cache que não passa pelo nginx).
  assert.equal((await visitor("GET", `/catalog-public/${SLUG}`)).body.redirectTo, `https://erp.exemplo.com.br/loja/${SLUG}`);

  const off = await admin("PUT", "/catalog/erp-redirect", { enabled: false });
  assert.equal(off.body.enabled, false);
  assert.equal((await visitor("GET", `/public-redirect/vitrine/${SLUG}`)).status, 404);
  assert.equal((await visitor("GET", `/catalog-public/${SLUG}`)).body.redirectTo, null);
});
