import { Router, type IRouter } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db, erpSalesSyncTable, usersTable } from "@workspace/db";
import { requireAdmin, requireTenant } from "../middlewares/auth";
import { requireModuleAccess } from "../lib/moduleAccess";
import { erpCredentials, erpPeriod, syncTenantSales } from "../lib/erpSalesSync";
import { erpFetch } from "../lib/erpOsMessages";

// Vendas que vieram do atendimento (19/10/2026): o CRM manda os atendimentos
// ao ERP Prumo (que marca a venda com o atendente) e o Financeiro mostra, lado
// a lado, o que foi lançado aqui ao finalizar x o que foi vendido no ERP.
const router: IRouter = Router();

async function status(tenantId: number) {
  const [row] = await db.select().from(erpSalesSyncTable).where(eq(erpSalesSyncTable.tenantId, tenantId)).limit(1);
  return {
    enabled: row?.enabled ?? false,
    lastSyncAt: row?.lastSyncAt ?? null,
    lastError: row?.lastError ?? null,
    sentCount: row?.sentCount ?? 0,
    cursorAt: row?.cursorAt ?? null,
    attendantsSyncedAt: row?.attendantsSyncedAt ?? null,
  };
}

router.get("/settings/erp/sales", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  res.json(await status(tenantId));
});

router.patch("/settings/erp/sales", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const enabled = req.body?.enabled;
  if (typeof enabled !== "boolean") { res.status(400).json({ error: "Informe enabled (true/false)" }); return; }
  if (enabled && !(await erpCredentials(tenantId))) {
    res.status(400).json({ error: "Ligue o ERP primeiro (endereço e chave)" });
    return;
  }
  await db.insert(erpSalesSyncTable).values({ tenantId, enabled })
    .onConflictDoUpdate({ target: erpSalesSyncTable.tenantId, set: { enabled } });
  res.json(await status(tenantId));
});

router.post("/settings/erp/sales/run", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const result = await syncTenantSales(tenantId);
  res.json({ result, status: await status(tenantId) });
});

type ErpAttendantRow = {
  attendantExternalId: string;
  attendantName: string | null;
  attendantEmail: string | null;
  sales: number;
  total: number;
  auto: number;
  manual: number;
};

// GET /finance/erp-sales?days=30&store=PP — vendas concluídas no ERP
// atribuídas a cada atendente (pelo id do usuário daqui).
router.get("/finance/erp-sales", requireModuleAccess("financeiro"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  let days = parseInt(String(req.query.days ?? "30"), 10);
  if (!Number.isFinite(days) || days < 1 || days > 365) days = 30;
  const store = typeof req.query.store === "string" && req.query.store.trim() ? req.query.store.trim().slice(0, 120) : null;
  const cred = await erpCredentials(tenantId);
  if (!cred) { res.json({ configured: false, error: null, rows: [], totals: { vendas: 0, total: 0 } }); return; }
  const { from, to } = erpPeriod(days);
  let attendants: ErpAttendantRow[];
  try {
    const r = await erpFetch(cred.baseUrl, cred.apiKey, `/integrations/sales/by-attendant?from=${from}&to=${to}`, undefined, 15_000) as { attendants: ErpAttendantRow[] };
    attendants = r.attendants ?? [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.json({
      configured: true,
      error: msg.includes("403") ? "A chave do ERP não tem o acesso \"Vendas do atendimento\"." : `Não foi possível buscar no ERP: ${msg.slice(0, 160)}`,
      rows: [], totals: { vendas: 0, total: 0 },
    });
    return;
  }
  const ids = attendants.map((a) => Number(a.attendantExternalId)).filter((n) => Number.isInteger(n) && n > 0);
  const users = ids.length
    ? await db.select({ id: usersTable.id, name: usersTable.name, storeName: usersTable.storeName, isActive: usersTable.isActive })
        .from(usersTable).where(and(eq(usersTable.tenantId, tenantId), inArray(usersTable.id, ids)))
    : [];
  const userMap = new Map(users.map((u) => [u.id, u]));
  const rows = attendants
    .map((a) => {
      const u = userMap.get(Number(a.attendantExternalId));
      return {
        vendedorId: u?.id ?? null,
        nome: u?.name ?? a.attendantName ?? "Atendente do CRM",
        loja: u?.storeName ?? null,
        ativo: u?.isActive ?? false,
        vendas: a.sales,
        total: a.total,
        automaticas: a.auto,
        marcadas: a.manual,
      };
    })
    .filter((r) => !store || r.loja === store)
    .sort((a, b) => b.total - a.total);
  const totals = rows.reduce((t, r) => ({ vendas: t.vendas + r.vendas, total: t.total + r.total }), { vendas: 0, total: 0 });
  res.json({ configured: true, error: null, from, to, rows, totals });
});

export default router;
