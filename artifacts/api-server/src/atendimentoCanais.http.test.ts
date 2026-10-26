// Atendimento por canais (26/10/2026): filtro por linha/Instagram no servidor,
// linha interna fora do "Todos" e dos indicadores, "Responder agora" x
// "Aguardando cliente", "Não precisa responder", "Retomar depois" e canal
// lembrado por pessoa.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";

process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";
process.env["SESSION_SECRET"] ??= "atendimento-canais-test-secret";
process.env["OPENAI_API_KEY"] ??= "sk-fake-test";
process.env["WHATSAPP_BRIDGE_URL"] ??= "http://localhost:3002";
process.env["NODE_ENV"] ??= "development";
if (process.env["DATABASE_URL"]!.includes("prod")) throw new Error("DATABASE_URL parece de produção — abortando.");

const {
  db, tenantsTable, usersTable, conversationsTable, whatsappSessionsTable, sectorsTable,
  chatNotificationsTable, sensitiveActionLogTable, OPTIONAL_MODULES,
} = await import("@workspace/db");
const { eq, inArray } = await import("drizzle-orm");
const { default: app } = await import("./app.ts");
const { runSnoozeReminders } = await import("./lib/snoozeReminders.ts");

const MARK = "__ATENDIMENTO_CANAIS_TEST__";
const rnd = Math.random().toString(36).slice(2, 8);
const VAREJO = `cv-varejo-${rnd}`;
const ATACADO = `cv-atacado-${rnd}`;
const COMPRAS = `cv-compras-${rnd}`;
let server: import("node:http").Server;
let baseUrl: string;
let tenantId: number;
let adminId: number;
let vendId: number;
const ids: Record<string, number> = {};

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
  await db.delete(chatNotificationsTable).where(inArray(chatNotificationsTable.tenantId, tids));
  await db.delete(sensitiveActionLogTable).where(inArray(sensitiveActionLogTable.tenantId, tids));
  await db.delete(conversationsTable).where(inArray(conversationsTable.tenantId, tids));
  await db.delete(whatsappSessionsTable).where(inArray(whatsappSessionsTable.tenantId, tids));
  await db.delete(usersTable).where(inArray(usersTable.tenantId, tids));
  await db.delete(sectorsTable).where(inArray(sectorsTable.tenantId, tids));
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, tids));
}

const admin = client();
const vend = client();
const minAgo = (n: number) => new Date(Date.now() - n * 60_000);
// Mensagem nova do cliente "agora" (um instante depois da última ação).
const later = async () => { await new Promise((r) => setTimeout(r, 20)); return new Date(); };
const names = (list: { name: string }[]) => list.map((c) => c.name).sort();

before(async () => {
  await wipe();
  const [tenant] = await db.insert(tenantsTable).values({ name: MARK, enabledModules: [...OPTIONAL_MODULES] }).returning();
  tenantId = tenant!.id;
  const [sector] = await db.insert(sectorsTable).values({ tenantId, name: "Vendas" }).returning();
  const hash = await bcrypt.hash("SenhaForte123!", 10);
  const [a] = await db.insert(usersTable).values({ tenantId, name: "Samuel", email: `adm-${rnd}@canais.invalid`, passwordHash: hash, role: "admin", isActive: true }).returning();
  const [v] = await db.insert(usersTable).values({
    tenantId, name: "Gabriel", email: `vend-${rnd}@canais.invalid`, passwordHash: hash, role: "vendedor", isActive: true,
    sectorId: sector!.id, sectorIds: [sector!.id], allowedSessionKeys: [VAREJO],
  }).returning();
  adminId = a!.id; vendId = v!.id;
  await db.insert(whatsappSessionsTable).values([
    { tenantId, sessionKey: VAREJO, displayName: "Varejo Oficial", status: "connected", color: "#16a34a" },
    { tenantId, sessionKey: ATACADO, displayName: "Atacado", status: "connected", lineType: "atacado" },
    { tenantId, sessionKey: COMPRAS, displayName: "Compras", status: "connected", lineType: "interna", alertsEnabled: false },
  ]);
  const mk = async (key: string, v: Partial<typeof conversationsTable.$inferInsert>) => {
    const [row] = await db.insert(conversationsTable).values({ tenantId, phone: `55339${Math.floor(Math.random() * 1e8)}`, name: key, channel: "whatsapp", status: "open", sectorId: sector!.id, ...v }).returning();
    ids[key] = row!.id;
  };
  // Varejo: cliente esperando há 10 min com o vendedor (atrasado: limite 5 min)
  await mk("Mariana", { sessionKey: VAREJO, assigneeId: vendId, lastMessageDirection: "inbound", lastMessageAt: minAgo(10) });
  // Varejo: na fila (sem vendedor)
  await mk("Fila Varejo", { sessionKey: VAREJO, status: "pending", lastMessageDirection: "inbound", lastMessageAt: minAgo(2) });
  // Atacado: nós respondemos por último
  await mk("Loja do Zé", { sessionKey: ATACADO, assigneeId: adminId, lastMessageDirection: "outbound", lastMessageAt: minAgo(3) });
  // Compras (interna): fornecedor esperando
  await mk("Distribuidora", { sessionKey: COMPRAS, assigneeId: adminId, lastMessageDirection: "inbound", lastMessageAt: minAgo(40) });
  // Instagram
  await mk("@ana", { sessionKey: "instagram", channel: "instagram", phone: `ig:${rnd}`, assigneeId: adminId, lastMessageDirection: "inbound", lastMessageAt: minAgo(1) });

  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const addr = server.address() as import("node:net").AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}/api`;
  assert.equal((await admin("POST", "/auth/login", { email: `adm-${rnd}@canais.invalid`, password: "SenhaForte123!" })).status, 200);
  assert.equal((await vend("POST", "/auth/login", { email: `vend-${rnd}@canais.invalid`, password: "SenhaForte123!" })).status, 200);
});

after(async () => {
  server?.close();
  await wipe();
  const { pool } = await import("@workspace/db");
  await pool.end().catch(() => {});
});

test("filtro por linha e por Instagram no servidor (lista e contagens)", async () => {
  const l = await admin("GET", `/chat/conversations?sessionKey=${VAREJO}`);
  assert.equal(l.status, 200);
  assert.deepEqual(names(l.body), ["Fila Varejo", "Mariana"]);
  const c = await admin("GET", `/chat/conversations/counts?sessionKey=${VAREJO}`);
  assert.equal(c.body.responder, 1);
  assert.equal(c.body.aguardando, 0);
  assert.equal(c.body.pendentes, 1);
  assert.equal(c.body.ativos, 1);

  const ig = await admin("GET", "/chat/conversations?channel=instagram");
  assert.deepEqual(names(ig.body), ["@ana"]);
  const at = await admin("GET", `/chat/conversations/counts?sessionKey=${ATACADO}`);
  assert.equal(at.body.responder, 0);
  assert.equal(at.body.aguardando, 1);
});

test("linha interna fica fora do Todos (excludeInternal) e das contagens", async () => {
  const all = await admin("GET", "/chat/conversations");
  assert.ok(names(all.body).includes("Distribuidora"));
  const semInternas = await admin("GET", "/chat/conversations?excludeInternal=1");
  assert.ok(!names(semInternas.body).includes("Distribuidora"));
  assert.ok(names(semInternas.body).includes("@ana"));
  const cAll = await admin("GET", "/chat/conversations/counts");
  const cSem = await admin("GET", "/chat/conversations/counts?excludeInternal=1");
  assert.equal(cAll.body.responder, 3); // Mariana, Distribuidora, @ana
  assert.equal(cSem.body.responder, 2);
});

test("vendedor restrito só vê as próprias linhas, mesmo pedindo outro canal", async () => {
  const other = await vend("GET", `/chat/conversations?sessionKey=${ATACADO}`);
  assert.equal(other.status, 200);
  assert.deepEqual(other.body, []);
  const mine = await vend("GET", `/chat/conversations?sessionKey=${VAREJO}`);
  assert.ok(names(mine.body).includes("Mariana"));
  const ov = await vend("GET", "/chat/channels/overview");
  assert.equal(ov.status, 200);
  assert.deepEqual(ov.body.channels.map((c: { id: string }) => c.id), [`wa:${VAREJO}`]);
  assert.equal(ov.body.stuck.length, 0); // só gestor vê a lista de parados
  const sessions = await vend("GET", "/chat/wa-sessions");
  const allowed = sessions.body.filter((s: { allowed: boolean }) => s.allowed).map((s: { sessionKey: string }) => s.sessionKey);
  assert.deepEqual(allowed, [VAREJO]);
});

test("painel do admin por canal: interna marcada e fora dos totais; vendedores parados", async () => {
  const ov = await admin("GET", "/chat/channels/overview");
  assert.equal(ov.status, 200);
  const byId = Object.fromEntries(ov.body.channels.map((c: { id: string }) => [c.id, c]));
  assert.equal(byId[`wa:${COMPRAS}`].internal, true);
  assert.equal(byId[`wa:${COMPRAS}`].responder, 1);
  assert.equal(byId[`wa:${VAREJO}`].responder, 1);
  assert.equal(byId[`wa:${VAREJO}`].atrasados, 1);
  assert.equal(byId[`wa:${VAREJO}`].fila, 1);
  assert.deepEqual(byId[`wa:${VAREJO}`].sellers, ["Gabriel"]);
  assert.equal(byId[`wa:${ATACADO}`].aguardando, 1);
  assert.ok(byId["instagram"]);
  assert.equal(ov.body.totals.responder, 2); // sem a linha interna
  assert.equal(ov.body.totals.atrasados, 1);
  assert.deepEqual(ov.body.stuck.map((s: { name: string }) => s.name), ["Gabriel"]);
});

test("Não precisa responder: vai para Aguardando e volta quando o cliente escreve", async () => {
  const r = await vend("POST", `/chat/conversations/${ids["Mariana"]}/no-reply`);
  assert.equal(r.status, 200);
  const [row] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, ids["Mariana"]!));
  assert.equal(row!.replyDismissedBy, vendId);
  let c = await vend("GET", `/chat/conversations/counts?sessionKey=${VAREJO}`);
  assert.equal(c.body.responder, 0);
  assert.equal(c.body.aguardando, 1);
  // cliente manda mensagem nova
  await db.update(conversationsTable).set({ lastMessageDirection: "inbound", lastMessageAt: await later() })
    .where(eq(conversationsTable.id, ids["Mariana"]!));
  c = await vend("GET", `/chat/conversations/counts?sessionKey=${VAREJO}`);
  assert.equal(c.body.responder, 1);
  assert.equal(c.body.aguardando, 0);
  // vendedor sem acesso à linha não consegue marcar
  assert.equal((await vend("POST", `/chat/conversations/${ids["Loja do Zé"]}/no-reply`)).status, 403);
});

test("Retomar depois: fica aguardando, volta no horário com aviso ao responsável", async () => {
  const id = ids["Mariana"]!;
  assert.equal((await vend("POST", `/chat/conversations/${id}/snooze`, { until: new Date(Date.now() - 60_000).toISOString() })).status, 400);
  const r = await vend("POST", `/chat/conversations/${id}/snooze`, { until: new Date(Date.now() + 3600_000).toISOString() });
  assert.equal(r.status, 200);
  let c = await vend("GET", `/chat/conversations/counts?sessionKey=${VAREJO}`);
  assert.equal(c.body.responder, 0);
  assert.equal(c.body.aguardando, 1);
  assert.equal(await runSnoozeReminders(), 0);
  // chegou a hora (simula o relógio andando)
  await db.update(conversationsTable).set({ snoozeUntil: new Date(Date.now() - 1000) }).where(eq(conversationsTable.id, id));
  c = await vend("GET", `/chat/conversations/counts?sessionKey=${VAREJO}`);
  assert.equal(c.body.responder, 1);
  assert.equal(await runSnoozeReminders(), 1);
  assert.equal(await runSnoozeReminders(), 0); // não avisa duas vezes
  const notes = await db.select().from(chatNotificationsTable).where(eq(chatNotificationsTable.conversationId, id));
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.userId, vendId);
  assert.equal(notes[0]!.kind, "retorno");
});

test("Retomar depois é cancelado se o cliente escrever antes", async () => {
  const id = ids["Loja do Zé"]!;
  const r = await admin("POST", `/chat/conversations/${id}/snooze`, { until: new Date(Date.now() + 3600_000).toISOString() });
  assert.equal(r.status, 200);
  await db.update(conversationsTable).set({ lastMessageDirection: "inbound", lastMessageAt: await later() })
    .where(eq(conversationsTable.id, id));
  const c = await admin("GET", `/chat/conversations/counts?sessionKey=${ATACADO}`);
  assert.equal(c.body.responder, 1);
  await runSnoozeReminders();
  const [row] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, id));
  assert.equal(row!.snoozeUntil, null);
  const notes = await db.select().from(chatNotificationsTable).where(eq(chatNotificationsTable.conversationId, id));
  assert.equal(notes.length, 0);
});

test("canal lembrado por pessoa e canal padrão do cadastro", async () => {
  let p = await vend("GET", "/chat/channel-preference");
  assert.equal(p.body.channel, "todos");
  // admin define o padrão no cadastro
  assert.equal((await admin("PATCH", `/admin/users/${vendId}`, { defaultChannel: `wa:${VAREJO}` })).status, 200);
  p = await vend("GET", "/chat/channel-preference");
  assert.equal(p.body.channel, `wa:${VAREJO}`);
  // a pessoa troca na barra: vale a última escolha
  assert.equal((await vend("PUT", "/chat/channel-preference", { channel: "todos" })).status, 200);
  p = await vend("GET", "/chat/channel-preference");
  assert.equal(p.body.channel, "todos");
  assert.equal(p.body.defaultChannel, `wa:${VAREJO}`);
  assert.equal((await vend("PUT", "/chat/channel-preference", { channel: "wa:../x" })).status, 400);
  const users = await admin("GET", "/admin/users");
  assert.equal(users.body.find((u: { id: number }) => u.id === vendId).defaultChannel, `wa:${VAREJO}`);
});

test("tipo da linha: virar interna desliga som/alarme; voltar para cliente liga", async () => {
  let r = await admin("POST", `/whatsapp/sessions/${ATACADO}/channel-settings`, { lineType: "interna" });
  assert.equal(r.status, 200);
  assert.equal(r.body.alertsEnabled, false);
  r = await admin("POST", `/whatsapp/sessions/${ATACADO}/channel-settings`, { lineType: "atacado" });
  assert.equal(r.body.alertsEnabled, true);
  r = await admin("POST", `/whatsapp/sessions/${ATACADO}/channel-settings`, { alertsEnabled: false });
  assert.equal(r.body.alertsEnabled, false);
  assert.equal((await admin("POST", `/whatsapp/sessions/${ATACADO}/channel-settings`, { lineType: "vip" })).status, 400);
  assert.equal((await vend("POST", `/whatsapp/sessions/${ATACADO}/channel-settings`, { lineType: "varejo" })).status, 403);
});
