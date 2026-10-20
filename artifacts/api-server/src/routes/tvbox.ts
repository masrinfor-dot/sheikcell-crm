import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, tvBoxClientsTable, tvBoxInvoicesTable } from "@workspace/db";
import { eq, and, desc, asc, inArray, sql } from "drizzle-orm";
import { requireAdmin, requireAuth, requireTenant } from "../middlewares/auth";
import { requireModuleAccess } from "../lib/moduleAccess";
import { normalizePhone } from "../lib/phone";
import { generateTvBoxInvoicesForMonth } from "../lib/tvBoxBilling";
import { ensureTvBoxSector } from "../lib/tvBoxMessaging";
import { getTvBoxSettings, saveTvBoxSettings } from "../lib/tvBoxSettings";
import { saveTvBoxErpUrl, setTvBoxMovedToErp, tvBoxErpUrl, tvBoxMovedToErp } from "../lib/tvBoxMoved";
import { buildTvBoxExport } from "../lib/tvBoxExport";

const router: IRouter = Router();

// Módulo "tvbox" contratado pela loja e liberado pro usuário.
router.use("/tvbox", requireModuleAccess("tvbox"));

// ─── TV Box passada para o ERP (17/10/2026) ──────────────────────────────────
// "Desligar no CRM": a cobrança automática do CRM para nesta loja e o painel
// vira só consulta. Toda alteração responde 410 com o aviso (as consultas e a
// exportação continuam). Ver lib/tvBoxMoved.ts.
export async function blockTvBoxWritesWhenMoved(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.method === "GET" || req.path === "/moved") return next();
  const tenantId = req.session?.tenantId;
  if (typeof tenantId === "number" && (await tvBoxMovedToErp(tenantId))) {
    res.status(410).json({ error: "A TV Box agora fica no ERP — cadastre, dê baixa e cobre por lá. Aqui é só consulta." });
    return;
  }
  next();
}
router.use("/tvbox", blockTvBoxWritesWhenMoved);

router.get("/tvbox/moved", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  res.json({ moved: await tvBoxMovedToErp(tenantId), erpUrl: await tvBoxErpUrl(tenantId) });
});

router.put("/tvbox/moved", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { moved, erpUrl } = req.body as { moved?: boolean; erpUrl?: string };
  const url = typeof erpUrl === "string" ? erpUrl.trim().slice(0, 300) : undefined;
  if (url && !/^https?:\/\/[^\s]+$/i.test(url)) { res.status(400).json({ error: "Endereço do ERP inválido (comece com https://)" }); return; }
  if (moved !== undefined) await setTvBoxMovedToErp(tenantId, moved === true);
  if (url !== undefined) await saveTvBoxErpUrl(tenantId, url);
  res.json({ moved: await tvBoxMovedToErp(tenantId), erpUrl: await tvBoxErpUrl(tenantId) });
});

router.get("/tvbox/export", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const payload = await buildTvBoxExport(tenantId);
  res.setHeader("Content-Disposition", `attachment; filename="tv-box-${payload.exportedAt.slice(0, 10)}.json"`);
  res.json(payload);
});

const CLIENT_STATUSES = ["ativo", "suspenso", "cancelado"];
const INVOICE_STATUSES = ["pendente", "pago", "cancelado"];

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── Clientes ────────────────────────────────────────────────────────────────
router.get("/tvbox/clients", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const clients = await db.select().from(tvBoxClientsTable)
    .where(eq(tvBoxClientsTable.tenantId, tenantId))
    .orderBy(asc(tvBoxClientsTable.name));

  const ids = clients.map((c) => c.id);
  // Fatura pendente mais recente de cada cliente (a que importa pro status
  // exibido na lista — pagas/canceladas não aparecem aqui).
  const pendingInvoices = ids.length > 0
    ? await db.select().from(tvBoxInvoicesTable)
        .where(and(inArray(tvBoxInvoicesTable.clientId, ids), eq(tvBoxInvoicesTable.status, "pendente")))
        .orderBy(desc(tvBoxInvoicesTable.dueDate))
    : [];
  const pendingByClient = new Map<number, typeof pendingInvoices[number]>();
  for (const inv of pendingInvoices) {
    if (!pendingByClient.has(inv.clientId)) pendingByClient.set(inv.clientId, inv);
  }

  const today = todayISO();
  res.json(clients.map((c) => {
    const pending = pendingByClient.get(c.id) ?? null;
    const overdue = pending != null && pending.dueDate < today;
    const daysLate = overdue ? Math.floor((Date.now() - new Date(`${pending!.dueDate}T00:00:00`).getTime()) / 86_400_000) : 0;
    return { ...c, pendingInvoice: pending, overdue, daysLate };
  }));
});

router.post("/tvbox/clients", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { name, phone, monthlyValueCents, dueDay, notes } = req.body as {
    name?: string; phone?: string; monthlyValueCents?: number; dueDay?: number; notes?: string;
  };
  if (!name?.trim()) { res.status(400).json({ error: "Nome é obrigatório" }); return; }
  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone) { res.status(400).json({ error: "Telefone inválido" }); return; }
  const value = Number(monthlyValueCents);
  if (!Number.isFinite(value) || value <= 0) { res.status(400).json({ error: "Valor da mensalidade inválido" }); return; }
  const day = Math.round(Number(dueDay));
  if (!Number.isFinite(day) || day < 1 || day > 28) { res.status(400).json({ error: "Dia de vencimento deve ser entre 1 e 28" }); return; }

  const sectorId = await ensureTvBoxSector(tenantId);
  const [created] = await db.insert(tvBoxClientsTable).values({
    tenantId,
    name: name.trim(),
    phone: cleanPhone,
    monthlyValueCents: value,
    dueDay: day,
    sectorId,
    notes: notes?.trim() || null,
  }).returning();
  res.status(201).json(created);
});

router.patch("/tvbox/clients/:id", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const { name, phone, monthlyValueCents, dueDay, status, notes } = req.body as {
    name?: string; phone?: string; monthlyValueCents?: number; dueDay?: number; status?: string; notes?: string;
  };
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (name !== undefined) {
    if (!name.trim()) { res.status(400).json({ error: "Nome é obrigatório" }); return; }
    update.name = name.trim();
  }
  if (phone !== undefined) {
    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone) { res.status(400).json({ error: "Telefone inválido" }); return; }
    update.phone = cleanPhone;
  }
  if (monthlyValueCents !== undefined) {
    const value = Number(monthlyValueCents);
    if (!Number.isFinite(value) || value <= 0) { res.status(400).json({ error: "Valor da mensalidade inválido" }); return; }
    update.monthlyValueCents = value;
  }
  if (dueDay !== undefined) {
    const day = Math.round(Number(dueDay));
    if (!Number.isFinite(day) || day < 1 || day > 28) { res.status(400).json({ error: "Dia de vencimento deve ser entre 1 e 28" }); return; }
    update.dueDay = day;
  }
  if (status !== undefined) {
    if (!CLIENT_STATUSES.includes(status)) { res.status(400).json({ error: "Status inválido" }); return; }
    update.status = status;
  }
  if (notes !== undefined) update.notes = notes.trim() || null;

  const [updated] = await db.update(tvBoxClientsTable).set(update)
    .where(and(eq(tvBoxClientsTable.id, id), eq(tvBoxClientsTable.tenantId, tenantId))).returning();
  if (!updated) { res.status(404).json({ error: "Cliente não encontrado" }); return; }
  res.json(updated);
});

// ─── Faturas ─────────────────────────────────────────────────────────────────
router.get("/tvbox/invoices", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const clientId = req.query.clientId ? parseInt(String(req.query.clientId), 10) : null;
  const conditions = [eq(tvBoxInvoicesTable.tenantId, tenantId)];
  if (clientId != null && !isNaN(clientId)) conditions.push(eq(tvBoxInvoicesTable.clientId, clientId));
  const invoices = await db.select().from(tvBoxInvoicesTable)
    .where(and(...conditions))
    .orderBy(desc(tvBoxInvoicesTable.dueDate));
  const today = todayISO();
  res.json(invoices.map((inv) => ({ ...inv, overdue: inv.status === "pendente" && inv.dueDate < today })));
});

router.patch("/tvbox/invoices/:id", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const { status } = req.body as { status?: string };
  if (!status || !INVOICE_STATUSES.includes(status)) { res.status(400).json({ error: "Status inválido" }); return; }
  const update: Record<string, unknown> = { status };
  if (status === "pago") update.paidAt = new Date();
  else update.paidAt = null;
  const [updated] = await db.update(tvBoxInvoicesTable).set(update)
    .where(and(eq(tvBoxInvoicesTable.id, id), eq(tvBoxInvoicesTable.tenantId, tenantId))).returning();
  if (!updated) { res.status(404).json({ error: "Fatura não encontrada" }); return; }
  res.json(updated);
});

// Gatilho manual (espelha o botão "Gerar mensalidades" do superadmin) —
// o tick automático já cobre isso, mas útil pra não esperar até a próxima hora.
router.post("/tvbox/invoices/generate", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const m = new Date().toISOString().slice(0, 7);
  const before = await db.select({ id: tvBoxInvoicesTable.id }).from(tvBoxInvoicesTable)
    .where(and(eq(tvBoxInvoicesTable.tenantId, tenantId), eq(tvBoxInvoicesTable.billingMonth, m)));
  await generateTvBoxInvoicesForMonth(m);
  const after = await db.select({ id: tvBoxInvoicesTable.id }).from(tvBoxInvoicesTable)
    .where(and(eq(tvBoxInvoicesTable.tenantId, tenantId), eq(tvBoxInvoicesTable.billingMonth, m)));
  res.json({ created: after.length - before.length });
});

// ─── Visão geral ─────────────────────────────────────────────────────────────
router.get("/tvbox/overview", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const today = todayISO();
  const [[activeCount], [pendingRow], [overdueRow]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(tvBoxClientsTable)
      .where(and(eq(tvBoxClientsTable.tenantId, tenantId), eq(tvBoxClientsTable.status, "ativo"))),
    db.select({ v: sql<number>`coalesce(sum(${tvBoxInvoicesTable.amountCents}),0)::int`, n: sql<number>`count(*)::int` })
      .from(tvBoxInvoicesTable)
      .where(and(eq(tvBoxInvoicesTable.tenantId, tenantId), eq(tvBoxInvoicesTable.status, "pendente"))),
    db.select({ v: sql<number>`coalesce(sum(${tvBoxInvoicesTable.amountCents}),0)::int`, n: sql<number>`count(*)::int` })
      .from(tvBoxInvoicesTable)
      .where(and(eq(tvBoxInvoicesTable.tenantId, tenantId), eq(tvBoxInvoicesTable.status, "pendente"), sql`${tvBoxInvoicesTable.dueDate} < ${today}::date`)),
  ]);
  res.json({
    activeClients: activeCount?.n ?? 0,
    pendingCents: pendingRow?.v ?? 0,
    pendingCount: pendingRow?.n ?? 0,
    overdueCents: overdueRow?.v ?? 0,
    overdueCount: overdueRow?.n ?? 0,
  });
});

// ─── Configurações de mensagem ───────────────────────────────────────────────
router.get("/tvbox/settings", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  res.json(await getTvBoxSettings(tenantId));
});

router.patch("/tvbox/settings", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  res.json(await saveTvBoxSettings(tenantId, req.body ?? {}));
});

export default router;
