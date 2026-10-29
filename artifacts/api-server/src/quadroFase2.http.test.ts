// Quadro do atendimento, fase 2 (29/10/2026): prazo de atraso por linha,
// limite por vendedor e horário da loja nas configurações, e números de cada
// vendedor para a visão Equipe.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";

process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";
process.env["SESSION_SECRET"] ??= "quadro-fase2-test-secret";
process.env["OPENAI_API_KEY"] ??= "sk-fake-test";
process.env["WHATSAPP_BRIDGE_URL"] ??= "http://localhost:3002";
process.env["NODE_ENV"] ??= "development";
if (process.env["DATABASE_URL"]!.includes("prod")) throw new Error("DATABASE_URL parece de produção — abortando.");

const { db, tenantsTable, usersTable, conversationsTable, whatsappSessionsTable, appSettingsTable, attendanceLogsTable, OPTIONAL_MODULES } = await import("@workspace/db");
const { eq, inArray } = await import("drizzle-orm");
const { default: app } = await import("./app.ts");
const { parseAttendHours } = await import("./routes/settings.ts");

const MARK = "__QUADRO_FASE2_TEST__";
const rnd = Math.random().toString(36).slice(2, 8);
const VAREJO = `q2-varejo-${rnd}`;
const ATACADO = `q2-atacado-${rnd}`;
let server: import("node:http").Server;
let baseUrl: string;
let tenantId: number;
let adminId: number;
let vendId: number;

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
  const tids = t.map((x) => x.id);
  if (!tids.length) return;
  await db.delete(attendanceLogsTable).where(inArray(attendanceLogsTable.tenantId, tids));
  await db.delete(appSettingsTable).where(inArray(appSettingsTable.tenantId, tids));
  await db.delete(conversationsTable).where(inArray(conversationsTable.tenantId, tids));
  await db.delete(whatsappSessionsTable).where(inArray(whatsappSessionsTable.tenantId, tids));
  await db.delete(usersTable).where(inArray(usersTable.tenantId, tids));
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, tids));
}

const admin = client();
const vend = client();
const minAgo = (n: number) => new Date(Date.now() - n * 60_000);

before(async () => {
  await wipe();
  const [tenant] = await db.insert(tenantsTable).values({ name: MARK, enabledModules: [...OPTIONAL_MODULES] }).returning();
  tenantId = tenant!.id;
  const hash = await bcrypt.hash("SenhaForte123!", 10);
  const [a] = await db.insert(usersTable).values({ tenantId, name: "Samuel", email: `adm-${rnd}@q2.invalid`, passwordHash: hash, role: "admin", isActive: true }).returning();
  const [v] = await db.insert(usersTable).values({ tenantId, name: "Gabrielly", email: `vend-${rnd}@q2.invalid`, passwordHash: hash, role: "vendedor", isActive: true }).returning();
  adminId = a!.id; vendId = v!.id;
  await db.insert(whatsappSessionsTable).values([
    { tenantId, sessionKey: VAREJO, displayName: "VAREJO", status: "connected" },
    { tenantId, sessionKey: ATACADO, displayName: "ATACADO", status: "connected", lineType: "atacado" },
  ]);
  // Duas conversas esperando 8 min, uma em cada linha. Prazo geral = 5 min.
  await db.insert(conversationsTable).values([
    { tenantId, phone: `55339${rnd}01`, name: "Cliente Varejo", channel: "whatsapp", sessionKey: VAREJO, assigneeId: vendId, status: "active", lastMessageDirection: "inbound", lastMessageAt: minAgo(8) },
    { tenantId, phone: `55339${rnd}02`, name: "Cliente Atacado", channel: "whatsapp", sessionKey: ATACADO, assigneeId: vendId, status: "active", lastMessageDirection: "inbound", lastMessageAt: minAgo(8) },
  ]);
  await db.insert(attendanceLogsTable).values([
    { tenantId, queueEntryId: 0, clientName: "A", sectorId: 0, sectorName: "-", attendantId: vendId, firstResponseSeconds: 60 },
    { tenantId, queueEntryId: 0, clientName: "B", sectorId: 0, sectorName: "-", attendantId: vendId, firstResponseSeconds: 180 },
  ]);
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api`;
  assert.equal((await admin("POST", "/auth/login", { email: `adm-${rnd}@q2.invalid`, password: "SenhaForte123!" })).status, 200);
  assert.equal((await vend("POST", "/auth/login", { email: `vend-${rnd}@q2.invalid`, password: "SenhaForte123!" })).status, 200);
});

after(async () => {
  server?.close();
  await wipe();
  const { pool } = await import("@workspace/db");
  await pool.end().catch(() => {});
});

test("horário da loja: só aceita abertura antes do fechamento e com dias", () => {
  assert.deepEqual(parseAttendHours(JSON.stringify({ open: "08:00", close: "18:00", days: [6, 1, 1] })), { open: "08:00", close: "18:00", days: [1, 6] });
  assert.equal(parseAttendHours(JSON.stringify({ open: "18:00", close: "08:00", days: [1] })), null);
  assert.equal(parseAttendHours(JSON.stringify({ open: "08:00", close: "18:00", days: [] })), null);
  assert.equal(parseAttendHours("lixo"), null);
  assert.equal(parseAttendHours(""), null);
});

test("configurações: limite por vendedor e horário da loja (admin salva, vendedor lê)", async () => {
  let r = await admin("GET", "/settings");
  assert.equal(r.body.boardWipLimit, 8);
  assert.equal(r.body.attendHours, null);
  r = await admin("PATCH", "/settings", { boardWipLimit: 5, attendHours: { open: "08:00", close: "18:00", days: [1, 2, 3, 4, 5, 6] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.boardWipLimit, 5);
  assert.deepEqual(r.body.attendHours, { open: "08:00", close: "18:00", days: [1, 2, 3, 4, 5, 6] });
  assert.equal((await admin("PATCH", "/settings", { attendHours: { open: "19:00", close: "18:00", days: [1] } })).status, 400);
  assert.equal((await admin("PATCH", "/settings", { boardWipLimit: -1 })).status, 400);
  assert.equal((await vend("PATCH", "/settings", { boardWipLimit: 1 })).status, 403);
  r = await vend("GET", "/settings");
  assert.equal(r.body.boardWipLimit, 5);
  r = await admin("PATCH", "/settings", { attendHours: null });
  assert.equal(r.body.attendHours, null);
});

test("prazo por linha: atacado com 10 min não conta como atrasado aos 8 min; varejo (geral 5) conta", async () => {
  let r = await admin("POST", `/whatsapp/sessions/${ATACADO}/channel-settings`, { alertMinutes: 10 });
  assert.equal(r.status, 200);
  assert.equal(r.body.alertMinutes, 10);
  assert.equal((await admin("POST", `/whatsapp/sessions/${ATACADO}/channel-settings`, { alertMinutes: 0 })).status, 400);
  r = await admin("GET", "/chat/channels/overview");
  assert.equal(r.status, 200);
  const at = r.body.channels.find((c: any) => c.sessionKey === ATACADO);
  const va = r.body.channels.find((c: any) => c.sessionKey === VAREJO);
  assert.equal(at.alertMinutes, 10);
  assert.equal(at.atrasados, 0);
  assert.equal(va.alertMinutes, 5);
  assert.equal(va.atrasados, 1);
  r = await admin("GET", "/chat/wa-sessions");
  assert.equal(r.body.find((w: any) => w.sessionKey === ATACADO).alertMinutes, 10);
  // Volta ao geral.
  r = await admin("POST", `/whatsapp/sessions/${ATACADO}/channel-settings`, { alertMinutes: null });
  assert.equal(r.body.alertMinutes, null);
  r = await admin("GET", "/chat/channels/overview");
  assert.equal(r.body.channels.find((c: any) => c.sessionKey === ATACADO).atrasados, 1);
});

test("números da equipe: só quem gerencia; média da 1ª resposta e finalizados", async () => {
  assert.equal((await vend("GET", "/chat/board/team-stats")).status, 403);
  const r = await admin("GET", "/chat/board/team-stats");
  assert.equal(r.status, 200);
  const g = r.body.find((x: any) => x.userId === vendId);
  assert.equal(g.avgFirstResponseSec7d, 120);
  assert.equal(g.finalized7d, 2);
  assert.equal(g.finalizedToday, 2);
  assert.ok(!r.body.some((x: any) => x.userId === adminId));
});
