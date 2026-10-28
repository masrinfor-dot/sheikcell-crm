// Cargo atualizado sem sair e entrar (28/10/2026): a Lucélia virou admin, mas
// a sessão ainda tinha o cargo de vendedora do login e ela não via todos os
// atendimentos. A sessão relê cargo/setores/linhas do banco.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";

process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";
process.env["SESSION_SECRET"] ??= "sessao-cargo-test-secret";
process.env["OPENAI_API_KEY"] ??= "sk-fake-test";
process.env["WHATSAPP_BRIDGE_URL"] ??= "http://localhost:3002";
process.env["NODE_ENV"] ??= "development";
process.env["SESSION_REFRESH_MS"] = "0";
if (process.env["DATABASE_URL"]!.includes("prod")) throw new Error("DATABASE_URL parece de produção — abortando.");

const { db, tenantsTable, usersTable, conversationsTable, whatsappSessionsTable, OPTIONAL_MODULES } = await import("@workspace/db");
const { eq, inArray } = await import("drizzle-orm");
const { default: app } = await import("./app.ts");

const MARK = "__SESSAO_CARGO_TEST__";
const rnd = Math.random().toString(36).slice(2, 8);
const linha = `test-linha-${rnd}`;
const email = `luc-${rnd}@sessao.invalid`;
let server: import("node:http").Server;
let baseUrl: string;
let tenantId: number;
let groupId: number;
let cookie = "";

async function call(method: string, p: string, body?: unknown) {
  const res = await fetch(baseUrl + p, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0]!;
  return res.status;
}

async function wipe() {
  const t = await db.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.name, MARK));
  const ids = t.map((x) => x.id);
  if (!ids.length) return;
  await db.delete(conversationsTable).where(inArray(conversationsTable.tenantId, ids));
  await db.delete(whatsappSessionsTable).where(inArray(whatsappSessionsTable.tenantId, ids));
  await db.delete(usersTable).where(inArray(usersTable.tenantId, ids));
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
}

before(async () => {
  await wipe();
  const [tenant] = await db.insert(tenantsTable).values({ name: MARK, enabledModules: [...OPTIONAL_MODULES] }).returning();
  tenantId = tenant!.id;
  const hash = await bcrypt.hash("SenhaForte123!", 10);
  await db.insert(usersTable).values({ tenantId, name: "Lucélia", email, passwordHash: hash, role: "vendedor", isActive: true });
  await db.insert(whatsappSessionsTable).values({ tenantId, sessionKey: linha, status: "connected" });
  const [g] = await db.insert(conversationsTable).values({ tenantId, phone: `120363${rnd}@g.us`, name: "Grupo", channel: "whatsapp", sessionKey: linha }).returning();
  groupId = g!.id;
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api`;
  assert.equal(await call("POST", "/auth/login", { email, password: "SenhaForte123!" }), 200);
});

after(async () => {
  server?.close();
  await wipe();
  const { pool } = await import("@workspace/db");
  await pool.end().catch(() => {});
});

test("vendedora promovida a admin ganha acesso de admin sem sair e entrar", async () => {
  assert.equal(await call("POST", `/chat/conversations/${groupId}/move-line`, { sessionKey: linha }), 403);
  await db.update(usersTable).set({ role: "admin" }).where(eq(usersTable.email, email));
  assert.equal(await call("POST", `/chat/conversations/${groupId}/move-line`, { sessionKey: linha }), 200);
});

test("usuário desativado perde a sessão", async () => {
  await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.email, email));
  assert.equal(await call("GET", "/chat/conversations"), 401);
});
