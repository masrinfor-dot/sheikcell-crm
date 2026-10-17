// Documentos da loja → ERP (17/10/2026): exportação, arquivo por link
// assinado e "desligar no CRM", de ponta a ponta pela API (banco de dev).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";

process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";
process.env["SESSION_SECRET"] ??= "documents-export-test-secret";
process.env["OPENAI_API_KEY"] ??= "sk-fake-test";
process.env["WHATSAPP_BRIDGE_URL"] ??= "http://localhost:3002";
process.env["NODE_ENV"] ??= "development";
if (process.env["DATABASE_URL"]!.includes("prod")) throw new Error("DATABASE_URL parece de produção — abortando.");

const { db, tenantsTable, usersTable, documentsTable, appSettingsTable, OPTIONAL_MODULES } = await import("@workspace/db");
const { eq, inArray } = await import("drizzle-orm");
const { DOCS_DIR } = await import("./routes/documents");
const { default: app } = await import("./app.ts");

const MARK = "__DOCUMENTS_EXPORT_TEST__";
const FILE = `documents-export-test-${process.pid}.pdf`;
const PDF = Buffer.from("%PDF-1.4\n%teste\n");
let server: import("node:http").Server;
let baseUrl: string;
let tenantId: number;
let docId: number;

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
  await db.delete(documentsTable).where(inArray(documentsTable.tenantId, ids));
  await db.delete(appSettingsTable).where(inArray(appSettingsTable.tenantId, ids));
  await db.delete(usersTable).where(inArray(usersTable.tenantId, ids));
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
}

const admin = client();
const supervisor = client();

before(async () => {
  await wipe();
  const [tenant] = await db.insert(tenantsTable).values({ name: MARK, enabledModules: [...OPTIONAL_MODULES] }).returning();
  tenantId = tenant!.id;
  const hash = await bcrypt.hash("SenhaForte123!", 10);
  const [adm] = await db.insert(usersTable).values([
    { tenantId, name: "Admin Docs", email: "admin@documents-export.invalid", passwordHash: hash, role: "admin", isActive: true },
    { tenantId, name: "Supervisor", email: "sup@documents-export.invalid", passwordHash: hash, role: "supervisor", isActive: true, moduleAccess: { documentos: "edit" } as never },
  ]).returning();
  await mkdir(DOCS_DIR, { recursive: true });
  await writeFile(path.join(DOCS_DIR, FILE), PDF);
  const [doc] = await db.insert(documentsTable).values({
    tenantId, title: "Ata de outubro", category: "ata", description: "Reunião geral",
    fileName: "ata.pdf", storedName: FILE, mimeType: "application/pdf", sizeBytes: PDF.length, uploadedBy: adm!.id,
  }).returning();
  docId = doc!.id;
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const addr = server.address() as import("node:net").AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}/api`;
  assert.equal((await admin("POST", "/auth/login", { email: "admin@documents-export.invalid", password: "SenhaForte123!" })).status, 200);
  assert.equal((await supervisor("POST", "/auth/login", { email: "sup@documents-export.invalid", password: "SenhaForte123!" })).status, 200);
});

after(async () => {
  server?.close();
  await rm(path.join(DOCS_DIR, FILE), { force: true });
  await wipe();
  const { pool } = await import("@workspace/db");
  await pool.end().catch(() => {});
});

test("exporta os documentos com quem enviou e o arquivo por link assinado", async () => {
  const r = await admin("GET", "/documents/export");
  assert.equal(r.status, 200);
  assert.equal(r.body.version, 1);
  assert.equal(r.body.kind, "documents");
  assert.match(r.body.crmApiUrl, /\/api$/);
  assert.equal(r.body.documents.length, 1);
  const d = r.body.documents[0];
  assert.equal(d.id, docId);
  assert.equal(d.title, "Ata de outubro");
  assert.equal(d.notes, "Reunião geral");
  assert.equal(d.uploadedByName, "Admin Docs");
  assert.equal(d.uploadedByEmail, "admin@documents-export.invalid");
  assert.ok(d.fileUrl.startsWith(`${r.body.crmApiUrl}/documents-export/file/${docId}?`));
  const u = new URL(d.fileUrl);
  const port = (server.address() as any).port;
  const file = await fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("content-type"), "application/octet-stream");
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PDF);
  const forged = await fetch(`http://127.0.0.1:${port}${u.pathname}${u.search.replace(/sig=[0-9a-f]+/, "sig=00")}`);
  assert.equal(forged.status, 404);
  const otherDoc = await fetch(`http://127.0.0.1:${port}${u.pathname.replace(`/${docId}`, `/${docId + 1}`)}${u.search}`);
  assert.equal(otherDoc.status, 404);
});

test("só admin exporta e desliga", async () => {
  assert.equal((await supervisor("GET", "/documents/export")).status, 403);
  assert.equal((await supervisor("PUT", "/documents/moved", { moved: true })).status, 403);
});

test("desligado no CRM: enviar e excluir devolvem 410, a lista continua", async () => {
  const r = await admin("PUT", "/documents/moved", { moved: true, erpUrl: "https://erp.exemplo.com.br" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { moved: true, erpUrl: "https://erp.exemplo.com.br" });
  assert.equal((await supervisor("GET", "/documents/moved")).body.moved, true);
  const up = await supervisor("POST", "/documents", { title: "X", category: "ata", fileName: "x.pdf", mimeType: "application/pdf", data: PDF.toString("base64") });
  assert.equal(up.status, 410);
  assert.match(up.body.error, /ERP/);
  assert.equal((await admin("DELETE", `/documents/${docId}`)).status, 410);
  const list = await supervisor("GET", "/documents");
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal((await admin("PUT", "/documents/moved", { erpUrl: "javascript:alert(1)" })).status, 400);
  await admin("PUT", "/documents/moved", { moved: false });
  assert.equal((await supervisor("GET", "/documents/moved")).body.moved, false);
});
