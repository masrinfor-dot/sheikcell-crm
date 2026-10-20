// Trocas com o ERP: mapa (fluxos e situação), registro de cada chamada pelo
// erpFetch (sem conteúdo), filtros do histórico e limpeza de 90 dias.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";

const { db, tenantsTable, erpExchangeLogsTable } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const ex = await import("./erpExchanges.ts");
const { erpFetch } = await import("./erpOsMessages.ts");

const MARK = "__teste_trocas_erp__";
let tenantId: number;
let server: Server;
let baseUrl: string;

before(async () => {
  await db.delete(tenantsTable).where(eq(tenantsTable.name, MARK));
  const [t] = await db.insert(tenantsTable).values({ name: MARK }).returning();
  tenantId = t!.id;
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const url = req.url ?? "";
      res.setHeader("Content-Type", "application/json");
      if (url.startsWith("/api/v1/integrations/service-orders/status")) {
        res.end(JSON.stringify({ found: true, orders: [{ number: "1" }, { number: "2" }] }));
      } else if (url === "/api/v1/integrations/hr/punches") {
        res.end(JSON.stringify({ ok: true, received: JSON.parse(body).items.length }));
      } else if (url === "/api/v1/integrations/hr/timesheets") {
        res.statusCode = 403;
        res.end(JSON.stringify({ message: "Esta chave não tem acesso a: RH (colaboradores e ponto)" }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

after(async () => {
  server.close();
  await db.delete(erpExchangeLogsTable).where(eq(erpExchangeLogsTable.tenantId, tenantId));
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
});

test("mapa: cada chamada que o CRM faz ao ERP tem um fluxo e um lado", () => {
  const cases: [string, string, string, string][] = [
    ["GET", "/ping", "ping", "ERP_TO_CRM"],
    ["GET", "/service-orders/messages/due", "os_messages", "ERP_TO_CRM"],
    ["POST", "/service-orders/messages/:id/result", "os_messages", "CRM_TO_ERP"],
    ["GET", "/service-orders/status", "os_status", "ERP_TO_CRM"],
    ["POST", "/hr/employees", "hr", "CRM_TO_ERP"],
    ["GET", "/hr/employees", "hr", "ERP_TO_CRM"],
    ["POST", "/hr/employees/link", "hr", "CRM_TO_ERP"],
    ["POST", "/hr/punches", "hr", "CRM_TO_ERP"],
    ["POST", "/hr/punches/delete", "hr", "CRM_TO_ERP"],
    ["POST", "/hr/timesheets", "hr", "CRM_TO_ERP"],
    ["POST", "/hr/documents", "hr", "CRM_TO_ERP"],
    ["POST", "/hr/import", "hr", "CRM_TO_ERP"],
    ["FILE", "/catalog/export", "storefront_export", "CRM_TO_ERP"],
    ["FILE", "/trade-in/export", "trade_in_export", "CRM_TO_ERP"],
  ];
  for (const [m, p, flow, dir] of cases) {
    const hit = ex.findErpFlow(m, p);
    assert.equal(hit?.flow.key, flow, `${m} ${p}`);
    assert.equal(hit?.route.direction, dir, `${m} ${p}`);
  }
  assert.equal(ex.findErpFlow("GET", "/nao-existe"), null);
  assert.equal(new Set(ex.CRM_ERP_FLOWS.map((f) => f.key)).size, ex.CRM_ERP_FLOWS.length);
});

test("rota gravada sem query e sem ids (o celular do cliente nunca vai)", () => {
  assert.equal(ex.erpRoutePath("/integrations/service-orders/status?phone=5533999990000&number=1"), "/service-orders/status");
  assert.equal(ex.erpRoutePath("/integrations/service-orders/messages/0b6f3c1e-9d1a-4e7b-8a8c-2f6f5e4d3c2b/result"), "/service-orders/messages/:id/result");
  assert.equal(ex.erpRoutePath("/integrations/hr/employees?since=2026-10-01"), "/hr/employees");
});

test("contagem: só a quantidade; erro sem chave", () => {
  assert.equal(ex.countErpExchange("POST", JSON.stringify({ items: [1, 2, 3] }), {}), 3);
  assert.equal(ex.countErpExchange("POST", JSON.stringify({ crmEntryIds: ["a"] }), {}), 1);
  assert.equal(ex.countErpExchange("POST", JSON.stringify({ status: "SENT" }), {}), 1);
  assert.equal(ex.countErpExchange("POST", "x".repeat(2_000_000), {}), 1);
  assert.equal(ex.countErpExchange("GET", undefined, { items: [{}, {}] }), 2);
  assert.equal(ex.countErpExchange("GET", undefined, { found: false, orders: [] }), 0);
  assert.equal(ex.countErpExchange("GET", undefined, { ok: true }), null);
  assert.equal(ex.scrubErpError("chave erp_0123456789ab_SEGREDOsegredoSEGREDO ruim"), "chave erp_*** ruim");
});

test("situação: desligado aqui, sem acesso na chave, ligado e manual", () => {
  const row = { osMessagesEnabled: true, hrSyncEnabled: false } as Parameters<typeof ex.erpFlowStatus>[1];
  const flow = (k: string) => ex.CRM_ERP_FLOWS.find((f) => f.key === k)!;
  assert.equal(ex.erpFlowStatus(flow("os_messages"), null, null).status, "OFF");
  assert.equal(ex.erpFlowStatus(flow("os_messages"), row, ["service_orders.notify"]).status, "ON");
  assert.equal(ex.erpFlowStatus(flow("os_messages"), row, ["hr.sync"]).status, "NO_ACCESS");
  assert.equal(ex.erpFlowStatus(flow("os_messages"), row, null).status, "ON");
  assert.equal(ex.erpFlowStatus(flow("hr"), row, ["hr.sync"]).status, "OFF");
  assert.equal(ex.erpFlowStatus(flow("os_status"), row, ["service_orders.notify"]).status, "ON");
  assert.equal(ex.erpFlowStatus(flow("storefront_export"), row, []).status, "MANUAL");
});

test("dia em Brasília: início de hoje e filtros de período", () => {
  assert.equal(ex.startOfTodayBr(new Date("2026-10-19T02:00:00Z")).toISOString(), "2026-10-18T03:00:00.000Z");
  assert.equal(ex.startOfTodayBr(new Date("2026-10-19T15:00:00Z")).toISOString(), "2026-10-19T03:00:00.000Z");
  assert.equal(ex.brDayStart("2026-10-19", 1)?.toISOString(), "2026-10-20T03:00:00.000Z");
  assert.equal(ex.brDayStart("19/10/2026"), null);
});

test("erpFetch grava cada troca da loja (ok e erro), sem conteúdo", async () => {
  await db.delete(erpExchangeLogsTable).where(eq(erpExchangeLogsTable.tenantId, tenantId));
  // Fora do contexto de uma loja não grava (não se sabe de quem é).
  await erpFetch(baseUrl, "erp_0123456789ab_SEGREDOsegredoSEGREDO", "/integrations/service-orders/status?phone=5533999990000");
  await ex.withErpTenant(tenantId, async () => {
    await erpFetch(baseUrl, "erp_0123456789ab_SEGREDOsegredoSEGREDO", "/integrations/service-orders/status?phone=5533999990000");
    await erpFetch(baseUrl, "erp_0123456789ab_SEGREDOsegredoSEGREDO", "/integrations/hr/punches", {
      method: "POST", body: JSON.stringify({ items: [{ crmEntryId: "1" }, { crmEntryId: "2" }, { crmEntryId: "3" }] }),
    });
    await assert.rejects(erpFetch(baseUrl, "erp_0123456789ab_SEGREDOsegredoSEGREDO", "/integrations/hr/timesheets", {
      method: "POST", body: JSON.stringify({ items: [] }),
    }), /ERP respondeu 403/);
  });
  // A gravação é "dispara e esquece": espera um pouco.
  await new Promise((r) => setTimeout(r, 300));
  const rows = await db.select().from(erpExchangeLogsTable).where(eq(erpExchangeLogsTable.tenantId, tenantId));
  assert.equal(rows.length, 3);
  const status = rows.find((r) => r.flow === "os_status")!;
  assert.equal(status.path, "/service-orders/status");
  assert.equal(status.summary, "2 OS informadas ao robô");
  assert.equal(status.direction, "ERP_TO_CRM");
  const punches = rows.find((r) => r.path === "/hr/punches")!;
  assert.equal(punches.summary, "3 batidas de ponto enviadas");
  assert.equal(punches.direction, "CRM_TO_ERP");
  const failed = rows.find((r) => r.path === "/hr/timesheets")!;
  assert.equal(failed.ok, false);
  assert.equal(failed.httpStatus, 403);
  assert.match(failed.error ?? "", /não tem acesso/);
  const all = JSON.stringify(rows);
  assert.ok(!all.includes("5533999990000"), "celular do cliente não pode ir para o histórico");
  assert.ok(!all.includes("SEGREDO"), "chave não pode ir para o histórico");
});

test("histórico: filtros, buscas vazias escondidas, contadores do dia e limpeza de 90 dias", async () => {
  await db.delete(erpExchangeLogsTable).where(eq(erpExchangeLogsTable.tenantId, tenantId));
  const now = new Date();
  const base = { tenantId, durationMs: 10 };
  await ex.recordErpExchange({ ...base, method: "GET", path: "/integrations/service-orders/messages/due?limit=20", httpStatus: 200, ok: true, itemCount: 0 });
  await ex.recordErpExchange({ ...base, method: "GET", path: "/integrations/service-orders/messages/due?limit=20", httpStatus: 200, ok: true, itemCount: 4 });
  await ex.recordErpExchange({ ...base, method: "POST", path: "/integrations/hr/employees", httpStatus: 200, ok: true, itemCount: 12 });
  await ex.recordErpExchange({ ...base, method: "POST", path: "/integrations/hr/punches", httpStatus: 500, ok: false, error: "ERP respondeu 500" });
  await ex.recordErpExchange({ ...base, method: "FILE", path: "/catalog/export", httpStatus: 200, ok: true, itemCount: 30 });
  const [old] = await db.insert(erpExchangeLogsTable).values({
    tenantId, flow: "hr", direction: "CRM_TO_ERP", method: "POST", path: "/hr/punches", ok: true,
    createdAt: new Date(now.getTime() - 91 * 86_400_000),
  }).returning();

  const all = await ex.listErpExchanges(tenantId, {});
  assert.equal(all.total, 6);
  const hidden = await ex.listErpExchanges(tenantId, { hideEmpty: "true" });
  assert.equal(hidden.total, 5);
  assert.ok(hidden.items.every((r) => !(r.method === "GET" && r.itemCount === 0)));
  assert.equal((await ex.listErpExchanges(tenantId, { flow: "hr" })).total, 3);
  assert.equal((await ex.listErpExchanges(tenantId, { direction: "ERP_TO_CRM" })).total, 2);
  assert.equal((await ex.listErpExchanges(tenantId, { result: "error" })).total, 1);
  const hr = (await ex.listErpExchanges(tenantId, { flow: "hr", result: "ok" })).items.map((r) => r.summary);
  assert.ok(hr.includes("12 colaboradores enviados"));
  const vitrine = (await ex.listErpExchanges(tenantId, { flow: "storefront_export" })).items[0]!;
  assert.equal(vitrine.summary, "30 produtos exportados");
  const today = new Date(now.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
  assert.equal((await ex.listErpExchanges(tenantId, { from: today, to: today })).total, 5);
  assert.deepEqual(all.today, { total: 5, ok: 4, errors: 1, crmToErp: 3, erpToCrm: 2 });
  assert.equal(all.retentionDays, 90);
  assert.ok(!("tenantId" in all.items[0]!));

  const flows = await ex.erpFlowsOverview(tenantId, null, null);
  const os = flows.find((f) => f.key === "os_messages")!;
  assert.equal(os.todayOk, 2);
  assert.ok(os.lastExchangeAt);
  assert.equal(flows.find((f) => f.key === "hr")!.todayErrors, 1);

  assert.ok((await ex.cleanupErpExchanges(now)) >= 1);
  const left = await db.select().from(erpExchangeLogsTable).where(eq(erpExchangeLogsTable.id, old!.id));
  assert.equal(left.length, 0);
  assert.equal((await ex.listErpExchanges(tenantId, {})).total, 5);
});

test("acessos da chave: guardados 10 min; se o ERP cair, usa o último que tinha", async () => {
  ex.forgetErpScopes(tenantId);
  let calls = 0;
  const ping = async () => { calls++; return { key: { scopes: ["hr.sync"] } }; };
  assert.deepEqual(await ex.erpKeyScopes(tenantId, ping), { scopes: ["hr.sync"], error: null });
  assert.deepEqual(await ex.erpKeyScopes(tenantId, ping), { scopes: ["hr.sync"], error: null });
  assert.equal(calls, 1);
  ex.forgetErpScopes(tenantId);
  const down = await ex.erpKeyScopes(tenantId, async () => { throw new Error("ERP fora do ar"); });
  assert.deepEqual(down, { scopes: null, error: "ERP fora do ar" });
});
