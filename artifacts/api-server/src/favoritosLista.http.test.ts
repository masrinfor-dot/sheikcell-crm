// Favoritos (26/10/2026): a aba mostrava "4" e a lista vazia — as favoritas
// resolvidas há tempo ficavam fora dos 500 mais recentes de Resolvidas.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";

process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";
process.env["SESSION_SECRET"] ??= "favoritos-test-secret";
process.env["OPENAI_API_KEY"] ??= "sk-fake-test";
process.env["WHATSAPP_BRIDGE_URL"] ??= "http://localhost:3002";
process.env["NODE_ENV"] ??= "development";
if (process.env["DATABASE_URL"]!.includes("prod")) throw new Error("DATABASE_URL parece de produção — abortando.");

const { db, tenantsTable, usersTable, conversationsTable, conversationPinsTable, OPTIONAL_MODULES } = await import("@workspace/db");
const { eq, inArray } = await import("drizzle-orm");
const { default: app } = await import("./app.ts");

const MARK = "__FAVORITOS_LISTA_TEST__";
const rnd = Math.random().toString(36).slice(2, 8);
let server: import("node:http").Server;
let baseUrl: string;
let tenantId: number;
let favId: number;
let adminCookie = "";

async function wipe() {
  const t = await db.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.name, MARK));
  const ids = t.map((x) => x.id);
  if (!ids.length) return;
  await db.delete(conversationsTable).where(inArray(conversationsTable.tenantId, ids));
  await db.delete(usersTable).where(inArray(usersTable.tenantId, ids));
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
}

before(async () => {
  await wipe();
  const [tenant] = await db.insert(tenantsTable).values({ name: MARK, enabledModules: [...OPTIONAL_MODULES] }).returning();
  tenantId = tenant!.id;
  const hash = await bcrypt.hash("SenhaForte123!", 10);
  const [adm] = await db.insert(usersTable).values({ tenantId, name: "Admin", email: `admin-${rnd}@favoritos.invalid`, passwordHash: hash, role: "admin", isActive: true }).returning();
  // A favorita é a resolvida mais ANTIGA; 505 resolvidas mais novas na frente.
  const [fav] = await db.insert(conversationsTable).values({ tenantId, phone: "5533900000000", name: "Favorita antiga", channel: "whatsapp", status: "resolved", lastMessageAt: new Date("2025-01-01T00:00:00Z") }).returning();
  favId = fav!.id;
  await db.insert(conversationsTable).values(Array.from({ length: 505 }, (_, i) => ({
    tenantId, phone: `55339${String(i).padStart(8, "0")}`, name: `Resolvida ${i}`, channel: "whatsapp", status: "resolved", lastMessageAt: new Date(Date.now() - i * 1000),
  })));
  await db.insert(conversationPinsTable).values({ tenantId, conversationId: favId, userId: adm!.id });
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const addr = server.address() as import("node:net").AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}/api`;
  const r = await fetch(baseUrl + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `admin-${rnd}@favoritos.invalid`, password: "SenhaForte123!" }) });
  assert.equal(r.status, 200);
  const sc = r.headers.get("set-cookie")!;
  adminCookie = sc.split(";")[0]!;
});

after(async () => {
  server?.close();
  await wipe();
  const { pool } = await import("@workspace/db");
  await pool.end().catch(() => {});
});

test("a favorita antiga vem na lista, uma vez só, e bate com o contador", async () => {
  const list = await fetch(baseUrl + "/chat/conversations", { headers: { Cookie: adminCookie } });
  assert.equal(list.status, 200);
  const rows = await list.json() as { id: number; pinned: boolean }[];
  const favs = rows.filter((c) => c.pinned);
  assert.deepEqual(favs.map((c) => c.id), [favId]);
  assert.equal(rows.filter((c) => c.id === favId).length, 1);
  const counts = await (await fetch(baseUrl + "/chat/conversations/counts", { headers: { Cookie: adminCookie } })).json() as { favoritos: number };
  assert.equal(counts.favoritos, favs.length);
});
