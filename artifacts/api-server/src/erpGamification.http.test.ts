// Pontuação do atendimento → gamificação do ERP e "Clientes esperando
// resposta" na TV das lojas do ERP (27/10/2026), de ponta a ponta: banco de
// dev + um ERP de mentira em memória.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import http from "node:http";

process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";
process.env["SESSION_SECRET"] ??= "gamification-erp-test-secret";
process.env["OPENAI_API_KEY"] ??= "sk-fake-test";
process.env["WHATSAPP_BRIDGE_URL"] ??= "http://localhost:3002";
process.env["NODE_ENV"] ??= "development";
if (process.env["DATABASE_URL"]!.includes("prod")) throw new Error("DATABASE_URL parece de produção — abortando.");

const {
  db, tenantsTable, usersTable, conversationsTable, messagesTable, storesTable, sectorsTable, whatsappSessionsTable,
  tenantErpIntegrationsTable, erpGamificationEventsTable, erpStoreLinksTable, erpExchangeLogsTable, appSettingsTable,
  attendanceStartEventsTable, OPTIONAL_MODULES,
} = await import("@workspace/db");
const { and, eq, inArray } = await import("drizzle-orm");
const { encryptErpSecret } = await import("./lib/erpCrypto");
const g = await import("./lib/erpGamification");
const tv = await import("./lib/erpTvWaiting");
const { default: app } = await import("./app.ts");

const MARK = "__GAMIFICATION_ERP_TEST__";
const KEY = "erp_0123456789ab_TESTE-GAMIFICACAO-CHAVE-012345";
const ERP_STORE_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ERP_STORE_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const SALE_ID = "cccccccc-3333-4333-8333-cccccccccccc";
const SALE_UNKNOWN = "dddddddd-4444-4444-8444-dddddddddddd";

let server: http.Server;
let erp: http.Server;
let baseUrl: string;
let tenantId: number;
let otherTenantId: number;
let anaId: number;
let storeId: number;
let lineKey: string;
let internalKey: string;

// ─── ERP de mentira ─────────────────────────────────────────────────────────
type Mode = "ok" | "403" | "500";
const fake = {
  mode: "ok" as Mode,
  events: [] as any[],
  snapshots: [] as any[],
  attributedCalls: [] as string[],
  attributed: [] as any[],
  statusFor: (_id: string): string => "APLICADO",
};

function startErp(): Promise<number> {
  erp = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url!, "http://x");
    const send = (status: number, data: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.headers["x-api-key"] !== KEY) return send(401, { message: "Chave inválida" });
    if (fake.mode === "403") return send(403, { message: "Sem o acesso" });
    if (fake.mode === "500") return send(500, { message: "caiu" });
    if (req.method === "POST" && url.pathname === "/integrations/gamification/v1/events") {
      fake.events.push(body);
      return send(200, {
        version: 1, received: body.items.length, applied: 0,
        results: body.items.map((i: any) => ({ eventId: i.eventId, status: fake.statusFor(i.eventId), points: fake.statusFor(i.eventId) === "APLICADO" ? 2 : 0 })),
      });
    }
    if (req.method === "GET" && url.pathname === "/integrations/sales/attributed") {
      fake.attributedCalls.push(url.search);
      // Cursor = quantas vendas já foram entregues ("cur-<n>").
      const from = Number((url.searchParams.get("after") ?? "cur-0").slice(4)) || 0;
      const items = fake.attributed.slice(from);
      return send(200, { items, nextCursor: `cur-${from + items.length}` });
    }
    if (req.method === "GET" && url.pathname === "/integrations/stores") {
      return send(200, [{ id: ERP_STORE_A, code: "PP", name: "Loja PP" }, { id: ERP_STORE_B, code: "SJ", name: "Loja SJ" }]);
    }
    if (req.method === "POST" && url.pathname === "/integrations/crm-waiting/v1/snapshot") {
      fake.snapshots.push(body);
      return send(200, { version: 1, received: body.items.length, applied: body.items.length, results: [] });
    }
    return send(404, { message: "rota" });
  });
  return new Promise((r) => erp.listen(0, () => r((erp.address() as import("node:net").AddressInfo).port)));
}

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
  const t = await db.select({ id: tenantsTable.id }).from(tenantsTable).where(inArray(tenantsTable.name, [MARK, `${MARK}-outra`]));
  const ids = t.map((x) => x.id);
  if (!ids.length) return;
  await db.delete(erpGamificationEventsTable).where(inArray(erpGamificationEventsTable.tenantId, ids));
  await db.delete(erpStoreLinksTable).where(inArray(erpStoreLinksTable.tenantId, ids));
  await db.delete(erpExchangeLogsTable).where(inArray(erpExchangeLogsTable.tenantId, ids));
  await db.delete(attendanceStartEventsTable).where(inArray(attendanceStartEventsTable.tenantId, ids));
  await db.delete(messagesTable).where(inArray(messagesTable.tenantId, ids));
  await db.delete(conversationsTable).where(inArray(conversationsTable.tenantId, ids));
  await db.delete(whatsappSessionsTable).where(inArray(whatsappSessionsTable.tenantId, ids));
  await db.delete(tenantErpIntegrationsTable).where(inArray(tenantErpIntegrationsTable.tenantId, ids));
  await db.delete(appSettingsTable).where(inArray(appSettingsTable.tenantId, ids));
  await db.delete(usersTable).where(inArray(usersTable.tenantId, ids));
  await db.delete(sectorsTable).where(inArray(sectorsTable.tenantId, ids));
  await db.delete(storesTable).where(inArray(storesTable.tenantId, ids));
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
}

const admin = client();
const ana = client();
const anon = client();

const ago = (ms: number) => new Date(Date.now() - ms);
const MIN = 60_000;

async function conv(values: Partial<typeof conversationsTable.$inferInsert> & { phone: string; name: string }, tid = tenantId) {
  const [c] = await db.insert(conversationsTable).values({ tenantId: tid, sessionKey: lineKey, status: "open", ...values }).returning();
  return c!;
}
async function msg(conversationId: number, direction: "inbound" | "outbound", at: Date, extra: Partial<typeof messagesTable.$inferInsert> = {}, tid = tenantId) {
  const [m] = await db.insert(messagesTable).values({ tenantId: tid, conversationId, direction, content: "Oi, quero uma película", createdAt: at, ...extra }).returning();
  return m!;
}

before(async () => {
  await wipe();
  const erpPort = await startErp();
  const [tenant] = await db.insert(tenantsTable).values({ name: MARK, enabledModules: [...OPTIONAL_MODULES] }).returning();
  tenantId = tenant!.id;
  const [other] = await db.insert(tenantsTable).values({ name: `${MARK}-outra`, enabledModules: [...OPTIONAL_MODULES] }).returning();
  otherTenantId = other!.id;
  const [st] = await db.insert(storesTable).values({ tenantId, name: "PP" }).returning();
  storeId = st!.id;
  lineKey = `gam-${tenantId}-varejo`;
  internalKey = `gam-${tenantId}-compras`;
  await db.insert(whatsappSessionsTable).values([
    { tenantId, sessionKey: lineKey, displayName: "Varejo", lineType: "varejo" },
    { tenantId, sessionKey: internalKey, displayName: "Compras", lineType: "interna" },
  ]);
  const hash = await bcrypt.hash("SenhaForte123!", 10);
  const [, a] = await db.insert(usersTable).values([
    { tenantId, name: "Admin", email: "admin@gam-erp.invalid", passwordHash: hash, role: "admin", isActive: true },
    { tenantId, name: "Ana", email: "ana@gam-erp.invalid", passwordHash: hash, role: "vendedor", isActive: true, storeId },
    { tenantId: otherTenantId, name: "Outro", email: "outro@gam-erp.invalid", passwordHash: hash, role: "admin", isActive: true },
  ]).returning();
  anaId = a!.id;
  const enc = encryptErpSecret(KEY);
  await db.insert(tenantErpIntegrationsTable).values({
    tenantId, baseUrl: `http://127.0.0.1:${erpPort}/`.replace(/\/$/, ""), encryptedApiKey: enc.ciphertext, iv: enc.iv, authTag: enc.authTag,
    keyVersion: enc.keyVersion, last4: KEY.slice(-4),
    // Ligado há 2 h, começando do zero (cursor 0) — as mensagens de teste são "depois de ligar".
    gamificationSince: ago(120 * MIN), gamificationMsgCursor: 0,
  });
  await db.insert(appSettingsTable).values({ tenantId, key: "alert_unanswered_minutes", value: "5" });
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api`;
  assert.equal((await admin("POST", "/auth/login", { email: "admin@gam-erp.invalid", password: "SenhaForte123!" })).status, 200);
  assert.equal((await ana("POST", "/auth/login", { email: "ana@gam-erp.invalid", password: "SenhaForte123!" })).status, 200);
});

after(async () => {
  await wipe();
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => erp.close(() => r()));
});

beforeEach(() => { fake.mode = "ok"; fake.statusFor = () => "APLICADO"; });

// ─── Funções puras ──────────────────────────────────────────────────────────

test("nome curto (LGPD): primeiro nome + inicial; número/emoji vira Cliente", () => {
  assert.equal(tv.shortCustomerName("ana maria souza"), "Ana S.");
  assert.equal(tv.shortCustomerName("JOÃO"), "João");
  assert.equal(tv.shortCustomerName("5533999998888"), "Cliente");
  assert.equal(tv.shortCustomerName("🔥🔥"), "Cliente");
  assert.equal(tv.shortCustomerName(null), "Cliente");
});

test("ids dos eventos seguem o formato aceito pelo ERP e são determinísticos", () => {
  const ids = [g.firstResponseEventId(8812, 99120), g.slaEventId(8812, new Date("2026-10-27T13:00:00Z")), g.convertedEventId(SALE_ID)];
  for (const id of ids) assert.ok(g.isValidEventId(id), id);
  assert.equal(ids[0], "conv-8812:first-response:99120");
  assert.equal(ids[1], g.slaEventId(8812, new Date("2026-10-27T13:00:00.900Z")));
  assert.equal(g.outcomeForErpStatus("APLICADO"), "sent");
  assert.equal(g.outcomeForErpStatus("SEM_USUARIO"), "sent");
  assert.equal(g.outcomeForErpStatus("INVALIDO"), "failed");
  assert.equal(g.outcomeForErpStatus(undefined), "retry");
  assert.match(g.describeGamificationError(new Error("ERP respondeu 403: x")), /Eventos de atendimento \(gamificação\)/);
  assert.equal(g.validItem({ eventId: "x y", type: "CONVERSATION_UNANSWERED_SLA", occurredAt: new Date().toISOString(), agent: { externalId: "1" } }), false);
  assert.equal(g.validItem({ eventId: "a:1", type: "CONVERSATION_CONVERTED", occurredAt: new Date().toISOString(), agent: { externalId: "1" } }), false);
});

// ─── Detecção ───────────────────────────────────────────────────────────────

let answered: { convId: number; replyId: number };

test("1ª resposta: o atendente responde 60 s depois do cliente → evento com responseSeconds e só ids/números", async () => {
  const c = await conv({ phone: "5533999990001", name: "Ana Cliente", assigneeId: anaId, attendanceStartedAt: ago(30 * MIN), storeId });
  await msg(c.id, "inbound", ago(20 * MIN));
  const reply = await msg(c.id, "outbound", ago(19 * MIN), { senderId: anaId, senderName: "Ana", content: "Temos sim!" });
  await msg(c.id, "outbound", ago(18 * MIN), { senderId: anaId, senderName: "Ana", content: "Quer reservar?" });
  await db.update(conversationsTable).set({ lastMessageDirection: "outbound", lastMessageAt: ago(18 * MIN) }).where(eq(conversationsTable.id, c.id));
  answered = { convId: c.id, replyId: reply.id };

  // Atendimento ativo (a loja escreveu primeiro): não é "resposta".
  const proactive = await conv({ phone: "5533999990002", name: "Bruno", assigneeId: anaId, attendanceStartedAt: ago(30 * MIN) });
  await msg(proactive.id, "outbound", ago(25 * MIN), { senderId: anaId, content: "Promoção!" });
  // Linha interna e grupo ficam de fora.
  const internal = await conv({ phone: "5533999990003", name: "Fornecedor", sessionKey: internalKey, assigneeId: anaId, attendanceStartedAt: ago(30 * MIN) });
  await msg(internal.id, "inbound", ago(20 * MIN));
  await msg(internal.id, "outbound", ago(19 * MIN), { senderId: anaId });
  const group = await conv({ phone: "1203630@g.us", name: "Grupo", assigneeId: anaId, attendanceStartedAt: ago(30 * MIN) });
  await msg(group.id, "inbound", ago(20 * MIN));
  await msg(group.id, "outbound", ago(19 * MIN), { senderId: anaId });
  // Nota interna e robô (sem senderId) não contam.
  const noted = await conv({ phone: "5533999990004", name: "Carla", assigneeId: anaId, attendanceStartedAt: ago(30 * MIN) });
  await msg(noted.id, "inbound", ago(20 * MIN));
  await msg(noted.id, "outbound", ago(19 * MIN), { senderId: anaId, type: "note" });
  await msg(noted.id, "outbound", ago(19 * MIN), { senderName: "Robô" });
  await db.update(conversationsTable).set({ lastMessageDirection: "outbound", lastMessageAt: ago(19 * MIN) })
    .where(inArray(conversationsTable.id, [internal.id, group.id, noted.id, proactive.id]));

  const r = await g.runTenantGamification(tenantId);
  assert.equal(r.error, null, JSON.stringify(r));
  const rows = await db.select().from(erpGamificationEventsTable)
    .where(and(eq(erpGamificationEventsTable.tenantId, tenantId), eq(erpGamificationEventsTable.type, "CONVERSATION_FIRST_RESPONSE")));
  assert.equal(rows.length, 1, JSON.stringify(rows.map((x) => x.eventId)));
  const ev = rows[0]!;
  assert.equal(ev.eventId, `conv-${c.id}:first-response:${reply.id}`);
  assert.equal(ev.status, "sent");
  assert.equal(ev.erpStatus, "APLICADO");
  assert.equal(ev.erpPoints, 2);
  const item = fake.events.flatMap((b) => b.items).find((i: any) => i.eventId === ev.eventId);
  assert.equal(fake.events[0].version, 1);
  assert.equal(item.responseSeconds, 60);
  assert.deepEqual(item.agent, { externalId: String(anaId), email: "ana@gam-erp.invalid" });
  assert.equal(item.conversationId, `conv-${c.id}`);
  // LGPD: nada de texto, nome ou celular do cliente no que foi ao ERP.
  const sent = JSON.stringify(fake.events);
  for (const bad of ["película", "Temos sim", "Ana Cliente", "5533999990001", "Promoção"]) assert.ok(!sent.includes(bad), bad);
});

test("sem resposta no prazo: conversa com responsável esperando há 10 min (limite 5) → um evento por espera", async () => {
  const c = await conv({
    phone: "5533999990010", name: "Diego Lima", assigneeId: anaId, attendanceStartedAt: ago(40 * MIN), storeId,
    lastMessageDirection: "inbound", lastMessageAt: ago(10 * MIN),
  });
  await msg(c.id, "inbound", ago(10 * MIN));
  // Esperando só 2 min: ainda no prazo.
  await conv({ phone: "5533999990011", name: "Eva", assigneeId: anaId, lastMessageDirection: "inbound", lastMessageAt: ago(2 * MIN) });
  // "Não precisa responder" marcado: não conta.
  await conv({ phone: "5533999990012", name: "Fabio", assigneeId: anaId, lastMessageDirection: "inbound", lastMessageAt: ago(10 * MIN), replyDismissedAt: ago(9 * MIN) });
  // Esperando desde antes de ligar a pontuação: não conta.
  await conv({ phone: "5533999990013", name: "Gil", assigneeId: anaId, lastMessageDirection: "inbound", lastMessageAt: ago(300 * MIN) });

  await g.runTenantGamification(tenantId);
  await g.runTenantGamification(tenantId); // repetir não duplica
  const rows = await db.select().from(erpGamificationEventsTable)
    .where(and(eq(erpGamificationEventsTable.tenantId, tenantId), eq(erpGamificationEventsTable.type, "CONVERSATION_UNANSWERED_SLA")));
  assert.equal(rows.length, 1, JSON.stringify(rows.map((x) => x.eventId)));
  assert.equal(rows[0]!.conversationId, c.id);
  assert.equal(rows[0]!.agentUserId, anaId);
  const item = rows[0]!.payload;
  assert.ok(item.waitingSeconds! >= 600 && item.waitingSeconds! < 700, String(item.waitingSeconds));
  const sentIds = fake.events.flatMap((b) => b.items.map((i: any) => i.eventId));
  assert.equal(sentIds.filter((id: string) => id === rows[0]!.eventId).length, 1);
});

test("conversa que virou venda: lê as vendas atribuídas no ERP e devolve o evento com o saleId (atendente de fora é ignorado)", async () => {
  fake.attributed = [
    { saleId: SALE_ID, storeId: ERP_STORE_A, attributedAt: new Date().toISOString(), attendantExternalId: String(anaId), conversationExternalId: String(answered.convId) },
    { saleId: SALE_UNKNOWN, storeId: ERP_STORE_A, attributedAt: new Date().toISOString(), attendantExternalId: "999999999", conversationExternalId: null },
  ];
  const run = await g.runTenantGamification(tenantId);
  assert.equal(run.salesError, null, JSON.stringify(run));
  const rows = await db.select().from(erpGamificationEventsTable)
    .where(and(eq(erpGamificationEventsTable.tenantId, tenantId), eq(erpGamificationEventsTable.type, "CONVERSATION_CONVERTED")));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.eventId, `sale-${SALE_ID}:converted`);
  assert.equal(rows[0]!.payload.saleId, SALE_ID);
  assert.equal(rows[0]!.payload.storeId, ERP_STORE_A);
  assert.equal(rows[0]!.payload.conversationId, `conv-${answered.convId}`);
  // Primeira leitura pelo "since"; depois continua do cursor devolvido pelo ERP.
  assert.match(fake.attributedCalls[0]!, /since=/);
  await g.runTenantGamification(tenantId);
  assert.match(fake.attributedCalls.at(-1)!, /after=cur-2/);
  const [integ] = await db.select().from(tenantErpIntegrationsTable).where(eq(tenantErpIntegrationsTable.tenantId, tenantId));
  assert.equal(integ!.gamificationSalesCursor, "cur-2");
});

test("chave sem o acesso (403): nada se perde — fica na fila e a tela mostra o que fazer", async () => {
  fake.mode = "403";
  const c = await conv({ phone: "5533999990020", name: "Hugo", assigneeId: anaId, attendanceStartedAt: ago(15 * MIN) });
  await msg(c.id, "inbound", ago(14 * MIN));
  await msg(c.id, "outbound", ago(13 * MIN), { senderId: anaId });
  await db.update(conversationsTable).set({ lastMessageDirection: "outbound", lastMessageAt: ago(13 * MIN) }).where(eq(conversationsTable.id, c.id));
  const r = await g.runTenantGamification(tenantId);
  assert.match(r.error ?? "", /Eventos de atendimento \(gamificação\)/);
  const [ev] = await db.select().from(erpGamificationEventsTable).where(and(eq(erpGamificationEventsTable.tenantId, tenantId), eq(erpGamificationEventsTable.conversationId, c.id)));
  assert.equal(ev!.status, "pending");
  assert.equal(ev!.attempts, 0);
  assert.ok(ev!.nextAttemptAt.getTime() > Date.now() + 10 * MIN);
  const st = await admin("GET", "/settings/erp/gamification");
  assert.equal(st.status, 200);
  assert.match(st.body.lastError, /Auxiliares › Integrações/);
  assert.ok(st.body.queue.pending >= 1);

  // Chave nova colada: na próxima rodada vai.
  fake.mode = "ok";
  await db.update(erpGamificationEventsTable).set({ nextAttemptAt: new Date() }).where(eq(erpGamificationEventsTable.id, ev!.id));
  const ok = await g.runTenantGamification(tenantId);
  assert.equal(ok.error, null);
  const [again] = await db.select().from(erpGamificationEventsTable).where(eq(erpGamificationEventsTable.id, ev!.id));
  assert.equal(again!.status, "sent");
});

test("ERP fora do ar: o CRM segue, o evento espera com nova tentativa; SEM_USUARIO fica guardado como enviado", async () => {
  fake.mode = "500";
  const c = await conv({ phone: "5533999990030", name: "Iris", assigneeId: anaId, attendanceStartedAt: ago(15 * MIN) });
  await msg(c.id, "inbound", ago(14 * MIN));
  await msg(c.id, "outbound", ago(12 * MIN), { senderId: anaId });
  await db.update(conversationsTable).set({ lastMessageDirection: "outbound", lastMessageAt: ago(12 * MIN) }).where(eq(conversationsTable.id, c.id));
  const r = await g.runTenantGamification(tenantId);
  assert.ok(r.error);
  const [ev] = await db.select().from(erpGamificationEventsTable).where(and(eq(erpGamificationEventsTable.tenantId, tenantId), eq(erpGamificationEventsTable.conversationId, c.id)));
  assert.equal(ev!.status, "pending");
  assert.equal(ev!.attempts, 1);

  fake.mode = "ok";
  fake.statusFor = () => "SEM_USUARIO";
  await db.update(erpGamificationEventsTable).set({ nextAttemptAt: new Date() }).where(eq(erpGamificationEventsTable.id, ev!.id));
  await g.runTenantGamification(tenantId);
  const [done] = await db.select().from(erpGamificationEventsTable).where(eq(erpGamificationEventsTable.id, ev!.id));
  assert.equal(done!.status, "sent");
  assert.equal(done!.erpStatus, "SEM_USUARIO");
});

// ─── TV da loja ─────────────────────────────────────────────────────────────

test("TV: só manda com loja ligada; nome curto, sem celular; outra loja (tenant) nunca entra", async () => {
  fake.snapshots = [];
  assert.equal((await tv.pushTvSnapshot(tenantId)).skipped, "sem lojas ligadas");
  assert.equal(fake.snapshots.length, 0);

  await db.insert(erpStoreLinksTable).values({ tenantId, kind: "store", crmRef: String(storeId), erpStoreId: ERP_STORE_A, erpStoreName: "Loja PP" });
  await db.insert(erpStoreLinksTable).values({ tenantId, kind: "line", crmRef: lineKey, erpStoreId: ERP_STORE_B, erpStoreName: "Loja SJ" });
  // Na fila, sem responsável, na linha de varejo → loja B (pela linha).
  await conv({ phone: "5533999990040", name: "joana pereira da silva", lastMessageDirection: "inbound", lastMessageAt: ago(3 * MIN) });
  // Conversa da outra empresa com o mesmo telefone: nunca aparece.
  const [otherLine] = await db.insert(whatsappSessionsTable).values({ tenantId: otherTenantId, sessionKey: `gam-${otherTenantId}-x` }).returning();
  await conv({ phone: "5533999990041", name: "Zé Outro", sessionKey: otherLine!.sessionKey, lastMessageDirection: "inbound", lastMessageAt: ago(3 * MIN) }, otherTenantId);

  const r = await tv.pushTvSnapshot(tenantId);
  assert.equal(r.error, null);
  const snap = fake.snapshots.at(-1);
  assert.equal(snap.version, 1);
  const a = snap.items.find((s: any) => s.storeId === ERP_STORE_A);
  const b = snap.items.find((s: any) => s.storeId === ERP_STORE_B);
  assert.ok(a && b);
  // Loja A: Diego (esperando 10 min, loja PP) — atrasado.
  assert.ok(a.conversations.some((c: any) => c.customer === "Diego L."));
  assert.ok(a.lateCount >= 1);
  assert.ok(b.conversations.some((c: any) => c.customer === "Joana S." && c.channel === "whatsapp" && c.waitingSeconds >= 170));
  const raw = JSON.stringify(fake.snapshots);
  for (const bad of ["5533999990040", "Zé", "pereira", "película"]) assert.ok(!raw.includes(bad), bad);
  const [integ] = await db.select().from(tenantErpIntegrationsTable).where(eq(tenantErpIntegrationsTable.tenantId, tenantId));
  assert.ok(integ!.tvWaitingLastPushAt);

  // Sem acesso na chave: mensagem clara, sem derrubar nada.
  fake.mode = "403";
  const denied = await tv.pushTvSnapshot(tenantId);
  assert.match(denied.error ?? "", /Fila de espera do atendimento \(TV da loja\)/);
});

// ─── Telas (rotas) ──────────────────────────────────────────────────────────

test("rotas: sem login 401, vendedor 403, admin vê; formato errado 400", async () => {
  assert.equal((await anon("GET", "/settings/erp/gamification")).status, 401);
  assert.equal((await ana("GET", "/settings/erp/gamification")).status, 403);
  assert.equal((await ana("PUT", "/settings/erp/store-links", { links: [] })).status, 403);
  const st = await admin("GET", "/settings/erp/gamification");
  assert.equal(st.status, 200);
  assert.equal(st.body.enabled, true);
  assert.ok(st.body.recent.length > 0);
  assert.ok(st.body.recent.every((e: any) => !("payload" in e)));
  assert.equal((await admin("PATCH", "/settings/erp/gamification", { enabled: "sim" })).status, 400);
  assert.equal((await admin("PATCH", "/settings/erp/gamification", {})).status, 400);
});

test("ligações de loja: valida loja daqui e loja do ERP; desligar/religar a pontuação recomeça do zero", async () => {
  const links = await admin("GET", "/settings/erp/store-links");
  assert.equal(links.status, 200);
  assert.equal(links.body.erpStores.length, 2);
  assert.ok(links.body.lines.some((l: any) => l.ref === lineKey));
  assert.ok(!links.body.lines.some((l: any) => l.ref === internalKey));
  // Loja de outra empresa / inexistente.
  assert.equal((await admin("PUT", "/settings/erp/store-links", { links: [{ kind: "store", crmRef: "999999", erpStoreId: ERP_STORE_A }] })).status, 400);
  assert.equal((await admin("PUT", "/settings/erp/store-links", { links: [{ kind: "store", crmRef: String(storeId), erpStoreId: "nao-uuid" }] })).status, 400);
  assert.equal((await admin("PUT", "/settings/erp/store-links", { links: [{ kind: "store", crmRef: String(storeId), erpStoreId: "eeeeeeee-5555-4555-8555-eeeeeeeeeeee" }] })).status, 400);
  const ok = await admin("PUT", "/settings/erp/store-links", { links: [{ kind: "store", crmRef: String(storeId), erpStoreId: ERP_STORE_B }] });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.links.find((l: any) => l.kind === "store"), { kind: "store", crmRef: String(storeId), erpStoreId: ERP_STORE_B, erpStoreName: "Loja SJ" });
  const removed = await admin("PUT", "/settings/erp/store-links", { links: [{ kind: "line", crmRef: lineKey, erpStoreId: null }] });
  assert.ok(!removed.body.links.some((l: any) => l.kind === "line"));

  assert.equal((await admin("PATCH", "/settings/erp/gamification", { enabled: false })).body.enabled, false);
  const on = await admin("PATCH", "/settings/erp/gamification", { enabled: true });
  assert.equal(on.body.enabled, true);
  assert.equal(on.body.since, null);
  await g.runTenantGamification(tenantId);
  const [integ] = await db.select().from(tenantErpIntegrationsTable).where(eq(tenantErpIntegrationsTable.tenantId, tenantId));
  assert.ok(integ!.gamificationSince && integ!.gamificationSince.getTime() > Date.now() - MIN);
  const [{ maxId }] = (await db.execute((await import("drizzle-orm")).sql`select coalesce(max(id),0)::int as "maxId" from messages where tenant_id = ${tenantId}`)).rows as any[];
  assert.equal(integ!.gamificationMsgCursor, Number(maxId));
});
