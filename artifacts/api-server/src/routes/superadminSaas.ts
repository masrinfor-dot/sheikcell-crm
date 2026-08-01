import { Router, type IRouter } from "express";
import {
  db,
  tenantsTable,
  saasContractsTable,
  saasInvoicesTable,
  saasTicketsTable,
  saasSettingsTable,
} from "@workspace/db";
import { eq, and, desc, sql, lt } from "drizzle-orm";
import { requireSuperadmin } from "../middlewares/auth";
import { generateInvoicesForMonth } from "../lib/saasBilling";

// Rotas do "negócio SaaS" do dono do sistema: contratos de aluguel,
// mensalidades (financeiro) e chamados de suporte por lojista.
// Tudo exige role "superadmin" — admins de loja nunca enxergam isto.
const router: IRouter = Router();

router.use("/superadmin", requireSuperadmin);

const todayISO = (): string => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- Visão geral
router.get("/superadmin/saas/overview", async (_req, res): Promise<void> => {
  const today = todayISO();
  const monthStart = today.slice(0, 7) + "-01";
  const [[mrr], [paidMonth], [paidTotal], [overdue], [pending], [openTickets], [newContractsMonth]] = await Promise.all([
    // Receita mensal esperada (contratos ativos de lojistas não cancelados)
    db.select({ v: sql<number>`COALESCE(SUM(${saasContractsTable.monthlyValueCents}),0)` })
      .from(saasContractsTable)
      .innerJoin(tenantsTable, eq(saasContractsTable.tenantId, tenantsTable.id))
      .where(and(eq(saasContractsTable.isActive, true), sql`${tenantsTable.saasStatus} <> 'cancelado'`)),
    // Recebido no mês (mensalidades pagas com pagamento neste mês)
    db.select({ v: sql<number>`COALESCE(SUM(${saasInvoicesTable.amountCents}),0)`, n: sql<number>`COUNT(*)` })
      .from(saasInvoicesTable)
      .where(and(eq(saasInvoicesTable.status, "paga"), sql`${saasInvoicesTable.paidAt} >= ${monthStart}::date`)),
    // Recebido no total
    db.select({ v: sql<number>`COALESCE(SUM(${saasInvoicesTable.amountCents}),0)` })
      .from(saasInvoicesTable).where(eq(saasInvoicesTable.status, "paga")),
    // Em atraso (pendente + vencida)
    db.select({ v: sql<number>`COALESCE(SUM(${saasInvoicesTable.amountCents}),0)`, n: sql<number>`COUNT(*)` })
      .from(saasInvoicesTable)
      .where(and(eq(saasInvoicesTable.status, "pendente"), lt(saasInvoicesTable.dueDate, today))),
    // A vencer (pendente, ainda no prazo)
    db.select({ v: sql<number>`COALESCE(SUM(${saasInvoicesTable.amountCents}),0)`, n: sql<number>`COUNT(*)` })
      .from(saasInvoicesTable)
      .where(and(eq(saasInvoicesTable.status, "pendente"), sql`${saasInvoicesTable.dueDate} >= ${today}::date`)),
    db.select({ n: sql<number>`COUNT(*)` })
      .from(saasTicketsTable).where(sql`${saasTicketsTable.status} <> 'resolvido'`),
    // Contratos novos fechados neste mês
    db.select({ n: sql<number>`COUNT(*)` })
      .from(saasContractsTable).where(sql`${saasContractsTable.createdAt} >= ${monthStart}::date`),
  ]);
  res.json({
    mrrCents: Number(mrr?.v ?? 0),
    paidMonthCents: Number(paidMonth?.v ?? 0),
    paidMonthCount: Number(paidMonth?.n ?? 0),
    paidTotalCents: Number(paidTotal?.v ?? 0),
    overdueCents: Number(overdue?.v ?? 0),
    overdueCount: Number(overdue?.n ?? 0),
    pendingCents: Number(pending?.v ?? 0),
    pendingCount: Number(pending?.n ?? 0),
    openTickets: Number(openTickets?.n ?? 0),
    newContractsMonth: Number(newContractsMonth?.n ?? 0),
  });
});

// ------------------------------------------------------------------ Contratos
router.get("/superadmin/saas/contracts", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      contract: saasContractsTable,
      tenantName: tenantsTable.name,
    })
    .from(saasContractsTable)
    .innerJoin(tenantsTable, eq(saasContractsTable.tenantId, tenantsTable.id))
    .orderBy(desc(saasContractsTable.createdAt));
  res.json({ contracts: rows.map((r) => ({ ...r.contract, tenantName: r.tenantName })) });
});

// Cria/atualiza o contrato da loja (1 contrato por loja)
router.put("/superadmin/tenants/:id/contract", async (req, res): Promise<void> => {
  const tenantId = Number(req.params.id);
  if (!Number.isFinite(tenantId)) { res.status(400).json({ error: "Loja inválida" }); return; }

  const { plan, monthlyValueCents, startDate, renewalDate, notes, isActive } = req.body as {
    plan?: string; monthlyValueCents?: number; startDate?: string | null;
    renewalDate?: string | null; notes?: string | null; isActive?: boolean;
  };
  const cents = Math.round(Number(monthlyValueCents ?? 0));
  if (!Number.isFinite(cents) || cents < 0) { res.status(400).json({ error: "Valor mensal inválido" }); return; }
  const dateOk = (d: unknown): boolean => d == null || d === "" || /^\d{4}-\d{2}-\d{2}$/.test(String(d));
  if (!dateOk(startDate) || !dateOk(renewalDate)) { res.status(400).json({ error: "Data inválida" }); return; }

  const values = {
    plan: (plan ?? "Mensal").trim() || "Mensal",
    monthlyValueCents: cents,
    startDate: startDate || null,
    renewalDate: renewalDate || null,
    notes: typeof notes === "string" ? notes : null,
    isActive: isActive !== false,
    updatedAt: new Date(),
  };
  // Trava a loja (mesmo lock do cancelamento) e re-checa o status sob o
  // lock: gravar contrato ativo em loja cancelada reativaria a cobrança —
  // proibido, mesmo que a requisição tenha começado antes do cancelamento.
  const result = await db.transaction(async (tx) => {
    const [tenant] = await tx.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId)).for("update");
    if (!tenant) return { error: 404 as const };
    if (tenant.saasStatus === "cancelado") return { error: 400 as const };
    const [existing] = await tx.select().from(saasContractsTable).where(eq(saasContractsTable.tenantId, tenantId));
    const [contract] = existing
      ? await tx.update(saasContractsTable).set(values).where(eq(saasContractsTable.id, existing.id)).returning()
      : await tx.insert(saasContractsTable).values({ tenantId, ...values }).returning();
    return { contract };
  });
  if ("error" in result) {
    if (result.error === 404) { res.status(404).json({ error: "Loja não encontrada" }); return; }
    res.status(400).json({ error: "Loja cancelada não pode ter contrato ativo — reative a loja primeiro" });
    return;
  }
  res.json({ contract: result.contract });
});

// Modelo base do contrato de aluguel (texto editável)
const TEMPLATE_KEY = "contract_template";
router.get("/superadmin/saas/contract-template", async (_req, res): Promise<void> => {
  const [row] = await db.select().from(saasSettingsTable).where(eq(saasSettingsTable.key, TEMPLATE_KEY));
  res.json({ template: row?.value ?? "" });
});
router.put("/superadmin/saas/contract-template", async (req, res): Promise<void> => {
  const { template } = req.body as { template?: string };
  if (typeof template !== "string") { res.status(400).json({ error: "Modelo inválido" }); return; }
  await db
    .insert(saasSettingsTable)
    .values({ key: TEMPLATE_KEY, value: template, updatedAt: new Date() })
    .onConflictDoUpdate({ target: saasSettingsTable.key, set: { value: template, updatedAt: new Date() } });
  res.json({ ok: true });
});

// --------------------------------------------------------------- Mensalidades
router.get("/superadmin/saas/invoices", async (_req, res): Promise<void> => {
  const rows = await db
    .select({ invoice: saasInvoicesTable, tenantName: tenantsTable.name })
    .from(saasInvoicesTable)
    .innerJoin(tenantsTable, eq(saasInvoicesTable.tenantId, tenantsTable.id))
    .orderBy(desc(saasInvoicesTable.dueDate), desc(saasInvoicesTable.id));
  const today = todayISO();
  res.json({
    invoices: rows.map((r) => ({
      ...r.invoice,
      tenantName: r.tenantName,
      // "atrasada" é derivada: pendente com vencimento no passado
      overdue: r.invoice.status === "pendente" && r.invoice.dueDate < today,
    })),
  });
});

router.post("/superadmin/saas/invoices", async (req, res): Promise<void> => {
  const { tenantId, description, amountCents, dueDate } = req.body as {
    tenantId?: number; description?: string; amountCents?: number; dueDate?: string;
  };
  const tid = Number(tenantId);
  const cents = Math.round(Number(amountCents));
  if (!Number.isFinite(tid)) { res.status(400).json({ error: "Loja inválida" }); return; }
  if (!Number.isFinite(cents) || cents <= 0) { res.status(400).json({ error: "Informe um valor maior que zero" }); return; }
  if (!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) { res.status(400).json({ error: "Informe o vencimento" }); return; }
  // Trava a linha da loja (FOR UPDATE) e re-checa o status DENTRO da
  // transação: um cancelamento simultâneo não pode passar entre a checagem e
  // o insert (o cancelamento atualiza a mesma linha e espera o lock).
  const result = await db.transaction(async (tx) => {
    const [tenant] = await tx.select().from(tenantsTable).where(eq(tenantsTable.id, tid)).for("update");
    if (!tenant) return { error: 404 as const };
    if (tenant.saasStatus === "cancelado") return { error: 400 as const };
    // Uma cobrança por loja por mês: se já existe mensalidade (manual ou
    // gerada) não cancelada vencendo no mesmo mês, rejeita — checado sob o
    // lock da loja, então não há corrida com a geração automática.
    const [already] = await tx
      .select({ id: saasInvoicesTable.id })
      .from(saasInvoicesTable)
      .where(and(
        eq(saasInvoicesTable.tenantId, tid),
        sql`${saasInvoicesTable.status} <> 'cancelada'`,
        sql`to_char(${saasInvoicesTable.dueDate}, 'YYYY-MM') = ${dueDate.slice(0, 7)}`,
      ))
      .limit(1);
    if (already) return { error: 409 as const };
    const [invoice] = await tx.insert(saasInvoicesTable).values({
      tenantId: tid,
      description: description?.trim() || "Mensalidade",
      amountCents: cents,
      dueDate,
    }).returning();
    return { invoice };
  });
  if ("error" in result) {
    if (result.error === 404) { res.status(404).json({ error: "Loja não encontrada" }); return; }
    if (result.error === 409) {
      res.status(409).json({ error: "A loja já tem mensalidade neste mês" });
      return;
    }
    res.status(400).json({ error: "Loja com contrato cancelado não pode receber mensalidade" });
    return;
  }
  res.status(201).json({ invoice: result.invoice });
});

// Gera as mensalidades do mês a partir dos contratos ativos (não duplica:
// pula lojas que já têm mensalidade com vencimento no mês).
router.post("/superadmin/saas/invoices/generate", async (req, res): Promise<void> => {
  const { month } = req.body as { month?: string }; // "YYYY-MM"
  const m = month && /^\d{4}-\d{2}$/.test(month) ? month : todayISO().slice(0, 7);
  // Lógica compartilhada com o agendador automático (lib/saasBilling).
  const created = await generateInvoicesForMonth(m);
  res.json({ created, month: m });
});

// Marca paga / reabre / cancela
router.patch("/superadmin/saas/invoices/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const { status } = req.body as { status?: string };
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Mensalidade inválida" }); return; }
  if (!status || !["pendente", "paga", "cancelada"].includes(status)) {
    res.status(400).json({ error: "Situação inválida" }); return;
  }
  // Trava a loja (mesmo lock do cancelamento) e re-checa: reabrir uma
  // mensalidade como "pendente" em loja cancelada criaria cobrança em aberto
  // de loja cancelada — proibido.
  const result = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(saasInvoicesTable).where(eq(saasInvoicesTable.id, id));
    if (!existing) return { error: 404 as const };
    const [tenant] = await tx.select().from(tenantsTable).where(eq(tenantsTable.id, existing.tenantId)).for("update");
    if (status === "pendente" && tenant?.saasStatus === "cancelado") return { error: 400 as const };
    const [invoice] = await tx
      .update(saasInvoicesTable)
      .set({ status, paidAt: status === "paga" ? new Date() : null })
      .where(eq(saasInvoicesTable.id, id))
      .returning();
    return { invoice };
  });
  if ("error" in result) {
    if (result.error === 404) { res.status(404).json({ error: "Mensalidade não encontrada" }); return; }
    res.status(400).json({ error: "Loja cancelada não pode ter mensalidade pendente" });
    return;
  }
  res.json({ invoice: result.invoice });
});

router.delete("/superadmin/saas/invoices/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Mensalidade inválida" }); return; }
  const [invoice] = await db.delete(saasInvoicesTable).where(eq(saasInvoicesTable.id, id)).returning();
  if (!invoice) { res.status(404).json({ error: "Mensalidade não encontrada" }); return; }
  res.json({ ok: true });
});

// ------------------------------------------------------- Chamados / suporte
router.get("/superadmin/saas/tickets", async (_req, res): Promise<void> => {
  const rows = await db
    .select({ ticket: saasTicketsTable, tenantName: tenantsTable.name })
    .from(saasTicketsTable)
    .innerJoin(tenantsTable, eq(saasTicketsTable.tenantId, tenantsTable.id))
    .orderBy(desc(saasTicketsTable.createdAt));
  res.json({ tickets: rows.map((r) => ({ ...r.ticket, tenantName: r.tenantName })) });
});

router.post("/superadmin/saas/tickets", async (req, res): Promise<void> => {
  const { tenantId, title, description } = req.body as { tenantId?: number; title?: string; description?: string };
  const tid = Number(tenantId);
  if (!Number.isFinite(tid)) { res.status(400).json({ error: "Loja inválida" }); return; }
  if (!title?.trim()) { res.status(400).json({ error: "Informe o título do chamado" }); return; }
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tid));
  if (!tenant) { res.status(404).json({ error: "Loja não encontrada" }); return; }
  const [ticket] = await db.insert(saasTicketsTable).values({
    tenantId: tid,
    title: title.trim(),
    description: description?.trim() || null,
  }).returning();
  res.status(201).json({ ticket });
});

router.patch("/superadmin/saas/tickets/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const { status, title, description } = req.body as { status?: string; title?: string; description?: string };
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Chamado inválido" }); return; }
  const updates: Record<string, unknown> = {};
  if (status) {
    if (!["aberto", "em_andamento", "resolvido"].includes(status)) { res.status(400).json({ error: "Situação inválida" }); return; }
    updates["status"] = status;
    updates["resolvedAt"] = status === "resolvido" ? new Date() : null;
  }
  if (typeof title === "string" && title.trim()) updates["title"] = title.trim();
  if (typeof description === "string") updates["description"] = description.trim() || null;
  if (!Object.keys(updates).length) { res.status(400).json({ error: "Nada para atualizar" }); return; }
  const [ticket] = await db.update(saasTicketsTable).set(updates).where(eq(saasTicketsTable.id, id)).returning();
  if (!ticket) { res.status(404).json({ error: "Chamado não encontrado" }); return; }
  res.json({ ticket });
});

export default router;
