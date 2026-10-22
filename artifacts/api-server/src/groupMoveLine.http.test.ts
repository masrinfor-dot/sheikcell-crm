// Grupo nos dois números da loja (22/10/2026): o admin escolhe por qual linha
// o grupo fica. Só grupo muda de linha; conversa individual fica onde o
// cliente chamou; linha de outra loja é recusada.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";

process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";
process.env["SESSION_SECRET"] ??= "group-move-line-test-secret";
process.env["OPENAI_API_KEY"] ??= "sk-fake-test";
process.env["WHATSAPP_BRIDGE_URL"] ??= "http://localhost:3002";
process.env["NODE_ENV"] ??= "development";
if (process.env["DATABASE_URL"]!.includes("prod")) throw new Error("DATABASE_URL parece de produção — abortando.");

const { db, tenantsTable, usersTable, conversationsTable, whatsappSessionsTable, OPTIONAL_MODULES } = await import("@workspace/db");
const { eq, inArray } = await import("drizzle-orm");
const { default: app } = await import("./app.ts");

const MARK = "__GROUP_MOVE_LINE_TEST__";
const rnd = Math.random().toString(36).slice(2, 8);
const varejo = `test-varejo-${rnd}`;
const atacado = `test-atacado-${rnd}`;
const outraLoja = `test-outra-${rnd}`;
let server: import("node:http").Server;
let baseUrl: string;
let tenantId: number;
let otherTenantId: number;
let groupId: number;
let directId: number;

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
  const t = await db.select({ id: tenantsTable.id }).from(tenantsTable).where(inArray(tenantsTable.name, [MARK, `${MARK}2`]));
  const ids = t.map((x) => x.id);
  if (!ids.length) return;
  await db.delete(conversationsTable).where(inArray(conversationsTable.tenantId, ids));
  await db.delete(whatsappSessionsTable).where(inArray(whatsappSessionsTable.tenantId, ids));
  await db.delete(usersTable).where(inArray(usersTable.tenantId, ids));
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
}

const admin = client();
const vendedor = client();

before(async () => {
  await wipe();
  const [tenant] = await db.insert(tenantsTable).values({ name: MARK, enabledModules: [...OPTIONAL_MODULES] }).returning();
  tenantId = tenant!.id;
  const [other] = await db.insert(tenantsTable).values({ name: `${MARK}2` }).returning();
  otherTenantId = other!.id;
  const hash = await bcrypt.hash("SenhaForte123!", 10);
  await db.insert(usersTable).values([
    { tenantId, name: "Admin", email: `admin-${rnd}@group-move.invalid`, passwordHash: hash, role: "admin", isActive: true },
    { tenantId, name: "Vendedor", email: `vend-${rnd}@group-move.invalid`, passwordHash: hash, role: "vendedor", isActive: true },
  ]);
  await db.insert(whatsappSessionsTable).values([
    { tenantId, sessionKey: varejo, displayName: "VAREJO OFICIAL", status: "connected" },
    { tenantId, sessionKey: atacado, displayName: "ATACADO", status: "connected" },
    { tenantId: otherTenantId, sessionKey: outraLoja, status: "connected" },
  ]);
  const [g] = await db.insert(conversationsTable).values({ tenantId, phone: `120363${rnd}@g.us`, name: "Técnicos T.O", channel: "whatsapp", sessionKey: varejo }).returning();
  groupId = g!.id;
  const [d] = await db.insert(conversationsTable).values({ tenantId, phone: "5533988880000", name: "Silas", channel: "whatsapp", sessionKey: varejo }).returning();
  directId = d!.id;
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const addr = server.address() as import("node:net").AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}/api`;
  assert.equal((await admin("POST", "/auth/login", { email: `admin-${rnd}@group-move.invalid`, password: "SenhaForte123!" })).status, 200);
  assert.equal((await vendedor("POST", "/auth/login", { email: `vend-${rnd}@group-move.invalid`, password: "SenhaForte123!" })).status, 200);
});

after(async () => {
  server?.close();
  await wipe();
  const { pool } = await import("@workspace/db");
  await pool.end().catch(() => {});
});

test("admin move o grupo para a linha do atacado", async () => {
  const r = await admin("POST", `/chat/conversations/${groupId}/move-line`, { sessionKey: atacado });
  assert.equal(r.status, 200);
  assert.equal(r.body.sessionKey, atacado);
  const [row] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, groupId));
  assert.equal(row!.sessionKey, atacado);
});

test("conversa individual não muda de linha; linha de outra loja é recusada; vendedor não pode", async () => {
  assert.equal((await admin("POST", `/chat/conversations/${directId}/move-line`, { sessionKey: atacado })).status, 400);
  assert.equal((await admin("POST", `/chat/conversations/${groupId}/move-line`, { sessionKey: outraLoja })).status, 404);
  assert.equal((await vendedor("POST", `/chat/conversations/${groupId}/move-line`, { sessionKey: varejo })).status, 403);
  const [row] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, groupId));
  assert.equal(row!.sessionKey, atacado);
});
