// Avaliação de usados → ERP (07/10/2026): exportação, foto por link assinado
// e "desligar no CRM", de ponta a ponta pela API (banco de dev).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";

process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";
process.env["SESSION_SECRET"] ??= "tradein-export-test-secret";
process.env["OPENAI_API_KEY"] ??= "sk-fake-test";
process.env["WHATSAPP_BRIDGE_URL"] ??= "http://localhost:3002";
process.env["NODE_ENV"] ??= "development";
if (process.env["DATABASE_URL"]!.includes("prod")) throw new Error("DATABASE_URL parece de produção — abortando.");

const { db, tenantsTable, usersTable, tradeInEvaluationsTable, appSettingsTable, OPTIONAL_MODULES } = await import("@workspace/db");
const { eq, inArray } = await import("drizzle-orm");
const { MEDIA_DIR } = await import("./lib/whatsappInbound");
const { default: app } = await import("./app.ts");

const MARK = "__TRADEIN_EXPORT_TEST__";
const PHOTO = `tradein-export-test-${process.pid}.jpg`;
let server: import("node:http").Server;
let baseUrl: string;
let tenantId: number;

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
  await db.delete(tradeInEvaluationsTable).where(inArray(tradeInEvaluationsTable.tenantId, ids));
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
    { tenantId, name: "Admin", email: "admin@tradein-export.invalid", passwordHash: hash, role: "admin", isActive: true },
    { tenantId, name: "Vendedor", email: "vend@tradein-export.invalid", passwordHash: hash, role: "supervisor", isActive: true },
  ]);
  await mkdir(MEDIA_DIR, { recursive: true });
  await writeFile(path.join(MEDIA_DIR, PHOTO), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]));
  await db.insert(tradeInEvaluationsTable).values([
    {
      tenantId, source: "staff", device: "Apple iPhone 12 128GB", brand: "Apple", model: "iPhone 12", memory: "128GB",
      answers: { Tela: "Perfeita" }, suggestedPrice: "R$ 1.200", customerName: "Maria", storeName: "PADRE PARAISO -02",
      sellerCustomerName: "Maria Silva", sellerCpf: "123.456.789-09", finalAgreedPrice: "R$ 1.150", closedAt: new Date(),
      documentPhotos: [`/api/chat/media/${PHOTO}`],
    },
    { tenantId, source: "public_lead", device: "Samsung S21", brand: "Samsung", model: "S21", answers: {}, sellerPhone: "33999990000" },
  ]);
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const addr = server.address() as import("node:net").AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}/api`;
  assert.equal((await admin("POST", "/auth/login", { email: "admin@tradein-export.invalid", password: "SenhaForte123!" })).status, 200);
  assert.equal((await seller("POST", "/auth/login", { email: "vend@tradein-export.invalid", password: "SenhaForte123!" })).status, 200);
});

after(async () => {
  server?.close();
  await rm(path.join(MEDIA_DIR, PHOTO), { force: true });
  await wipe();
  const { pool } = await import("@workspace/db");
  await pool.end().catch(() => {});
});

test("exporta todas as avaliações com fotos por link assinado", async () => {
  const r = await admin("GET", "/trade-in/export");
  assert.equal(r.status, 200);
  assert.equal(r.body.version, 1);
  assert.equal(r.body.kind, "trade-in");
  assert.equal(r.body.evaluations.length, 2);
  const closed = r.body.evaluations.find((e: any) => e.closedAt);
  assert.equal(closed.sellerCpf, "123.456.789-09");
  assert.equal(closed.storeName, "PADRE PARAISO -02");
  assert.equal(closed.documentPhotos.length, 1);
  const photoPath = new URL(closed.documentPhotos[0]).pathname + new URL(closed.documentPhotos[0]).search;
  const photo = await fetch(`http://127.0.0.1:${(server.address() as any).port}${photoPath}`);
  assert.equal(photo.status, 200);
  assert.equal((await photo.arrayBuffer()).byteLength, 12);
  const forged = await fetch(`http://127.0.0.1:${(server.address() as any).port}${photoPath.replace(/sig=[0-9a-f]+/, "sig=00")}`);
  assert.equal(forged.status, 404);
  assert.ok(r.body.settings.margins && r.body.settings.questions);
});

test("só admin exporta e desliga", async () => {
  assert.equal((await seller("GET", "/trade-in/export")).status, 403);
  assert.equal((await seller("PUT", "/trade-in/moved", { moved: true })).status, 403);
});

test("desligado no CRM: avaliar devolve 410 e a tela sabe", async () => {
  const r = await admin("PUT", "/trade-in/moved", { moved: true, erpUrl: "https://erp.exemplo.com.br" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { moved: true, erpUrl: "https://erp.exemplo.com.br" });
  assert.equal((await seller("GET", "/trade-in/moved")).body.moved, true);
  const ev = await admin("POST", "/trade-in/evaluate", { brand: "Apple", model: "iPhone 12", answers: { Tela: "Perfeita" } });
  assert.equal(ev.status, 410);
  assert.match(ev.body.error, /ERP/);
  assert.equal((await admin("GET", "/trade-in")).status, 200); // histórico continua
  assert.equal((await admin("PUT", "/trade-in/moved", { erpUrl: "javascript:alert(1)" })).status, 400);
  await admin("PUT", "/trade-in/moved", { moved: false });
  assert.equal((await seller("GET", "/trade-in/moved")).body.moved, false);
});
