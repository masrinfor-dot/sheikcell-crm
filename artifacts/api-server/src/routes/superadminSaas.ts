import { Router, type IRouter } from "express";
import {
  db,
  tenantsTable,
  saasContractsTable,
  saasInvoicesTable,
  saasTicketsTable,
  saasTicketMessagesTable,
  saasSettingsTable,
  usersTable,
  whatsappSessionsTable,
} from "@workspace/db";
import { eq, and, asc, desc, sql, lt } from "drizzle-orm";
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
  // Contratos ativos (lojas não canceladas) com renovação neste mês —
  // consulta separada para não mexer no destructuring posicional acima.
  const [renewMonth] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(saasContractsTable)
    .innerJoin(tenantsTable, eq(saasContractsTable.tenantId, tenantsTable.id))
    .where(and(
      eq(saasContractsTable.isActive, true),
      sql`${tenantsTable.saasStatus} <> 'cancelado'`,
      sql`${saasContractsTable.renewalDate} IS NOT NULL`,
      sql`to_char(${saasContractsTable.renewalDate}, 'YYYY-MM') = ${today.slice(0, 7)}`,
    ));
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
    renewalsMonthCount: Number(renewMonth?.n ?? 0),
  });
});

// ------------------------------------------------------ Aba "Visão Geral"
// Junta contagem de lojas por situação, WhatsApp conectado/total e uma lista
// de itens que "precisam de atenção" (WhatsApp caído, mensalidade atrasada,
// contrato vencendo, chamado urgente parado) — tudo pra alimentar a home do
// painel do superadmin sem ele ter que abrir aba por aba pra notar problema.
const ATTENTION_RENEWAL_WINDOW_DAYS = 30;
const ATTENTION_ITEM_LIMIT = 20;

router.get("/superadmin/saas/attention", async (_req, res): Promise<void> => {
  const today = todayISO();
  const renewalCutoff = new Date();
  renewalCutoff.setDate(renewalCutoff.getDate() + ATTENTION_RENEWAL_WINDOW_DAYS);
  const renewalCutoffISO = renewalCutoff.toISOString().slice(0, 10);

  const [
    tenants,
    disconnected,
    overdueInvoices,
    renewingContracts,
    urgentTickets,
    [wsTotal],
    [wsConnected],
    [criticalTicketCount],
  ] = await Promise.all([
    db.select({ id: tenantsTable.id, isActive: tenantsTable.isActive, saasStatus: tenantsTable.saasStatus })
      .from(tenantsTable),
    // WhatsApp que não está conectado, em loja não cancelada — ordenado pelo
    // que está caído há mais tempo primeiro.
    db.select({
      tenantId: whatsappSessionsTable.tenantId,
      tenantName: tenantsTable.name,
      sessionLabel: sql<string>`COALESCE(${whatsappSessionsTable.displayName}, ${whatsappSessionsTable.sessionKey})`,
      updatedAt: whatsappSessionsTable.updatedAt,
    })
      .from(whatsappSessionsTable)
      .innerJoin(tenantsTable, eq(whatsappSessionsTable.tenantId, tenantsTable.id))
      .where(and(sql`${whatsappSessionsTable.status} <> 'connected'`, sql`${tenantsTable.saasStatus} <> 'cancelado'`))
      .orderBy(asc(whatsappSessionsTable.updatedAt))
      .limit(ATTENTION_ITEM_LIMIT),
    // Mensalidades pendentes já vencidas — mais antigas primeiro.
    db.select({
      tenantId: saasInvoicesTable.tenantId,
      tenantName: tenantsTable.name,
      amountCents: saasInvoicesTable.amountCents,
      dueDate: saasInvoicesTable.dueDate,
    })
      .from(saasInvoicesTable)
      .innerJoin(tenantsTable, eq(saasInvoicesTable.tenantId, tenantsTable.id))
      .where(and(eq(saasInvoicesTable.status, "pendente"), lt(saasInvoicesTable.dueDate, today)))
      .orderBy(asc(saasInvoicesTable.dueDate))
      .limit(ATTENTION_ITEM_LIMIT),
    // Contratos ativos (loja não cancelada) vencendo nos próximos 30 dias
    // (ou já vencidos e ainda não renovados) — mais urgente primeiro.
    db.select({
      tenantId: saasContractsTable.tenantId,
      tenantName: tenantsTable.name,
      renewalDate: saasContractsTable.renewalDate,
    })
      .from(saasContractsTable)
      .innerJoin(tenantsTable, eq(saasContractsTable.tenantId, tenantsTable.id))
      .where(and(
        eq(saasContractsTable.isActive, true),
        sql`${tenantsTable.saasStatus} <> 'cancelado'`,
        sql`${saasContractsTable.renewalDate} IS NOT NULL`,
        sql`${saasContractsTable.renewalDate} <= ${renewalCutoffISO}::date`,
      ))
      .orderBy(asc(saasContractsTable.renewalDate))
      .limit(ATTENTION_ITEM_LIMIT),
    // Chamados urgentes ainda não resolvidos/fechados — mais antigos primeiro.
    db.select({
      id: saasTicketsTable.id,
      tenantId: saasTicketsTable.tenantId,
      tenantName: tenantsTable.name,
      title: saasTicketsTable.title,
      createdAt: saasTicketsTable.createdAt,
      firstRespondedAt: saasTicketsTable.firstRespondedAt,
    })
      .from(saasTicketsTable)
      .innerJoin(tenantsTable, eq(saasTicketsTable.tenantId, tenantsTable.id))
      .where(and(
        eq(saasTicketsTable.priority, "urgente"),
        sql`${saasTicketsTable.status} <> 'resolvido'`,
        sql`${saasTicketsTable.status} <> 'fechado'`,
      ))
      .orderBy(asc(saasTicketsTable.createdAt))
      .limit(ATTENTION_ITEM_LIMIT),
    // WhatsApp conectado/total, só de lojas não canceladas.
    db.select({ n: sql<number>`COUNT(*)` })
      .from(whatsappSessionsTable)
      .innerJoin(tenantsTable, eq(whatsappSessionsTable.tenantId, tenantsTable.id))
      .where(sql`${tenantsTable.saasStatus} <> 'cancelado'`),
    db.select({ n: sql<number>`COUNT(*)` })
      .from(whatsappSessionsTable)
      .innerJoin(tenantsTable, eq(whatsappSessionsTable.tenantId, tenantsTable.id))
      .where(and(eq(whatsappSessionsTable.status, "connected"), sql`${tenantsTable.saasStatus} <> 'cancelado'`)),
    // Contagem real (não limitada pelo .limit() da lista de itens acima).
    db.select({ n: sql<number>`COUNT(*)` })
      .from(saasTicketsTable)
      .where(and(
        eq(saasTicketsTable.priority, "urgente"),
        sql`${saasTicketsTable.status} <> 'resolvido'`,
        sql`${saasTicketsTable.status} <> 'fechado'`,
      )),
  ]);

  // Contagem por situação — mesma precedência usada em GET /superadmin/tenants
  // (cancelado > suspensa > em implantação > inadimplente > ativo), pra bater
  // com o que a tabela de Lojistas mostra.
  const overdueTenantIds = new Set(overdueInvoices.map((i) => i.tenantId));
  const counts = { total: tenants.length, ativo: 0, suspensas: 0, emImplantacao: 0, cancelado: 0, inadimplente: 0 };
  for (const t of tenants) {
    if (t.saasStatus === "cancelado") { counts.cancelado++; continue; }
    if (!t.isActive) { counts.suspensas++; continue; }
    if (t.saasStatus === "em_implantacao") { counts.emImplantacao++; continue; }
    if (overdueTenantIds.has(t.id)) { counts.inadimplente++; continue; }
    counts.ativo++;
  }

  const now = Date.now();
  const items = [
    ...disconnected.map((d) => ({
      type: "whatsapp_disconnected" as const,
      tenantId: d.tenantId, tenantName: d.tenantName, sessionLabel: d.sessionLabel,
      hoursOffline: Math.floor((now - new Date(d.updatedAt).getTime()) / 3600000),
    })),
    ...overdueInvoices.map((i) => ({
      type: "invoice_overdue" as const,
      tenantId: i.tenantId, tenantName: i.tenantName, amountCents: i.amountCents,
      daysOverdue: Math.floor((now - new Date(i.dueDate).getTime()) / 86400000),
    })),
    ...renewingContracts.map((c) => ({
      type: "contract_renewing" as const,
      tenantId: c.tenantId, tenantName: c.tenantName, renewalDate: c.renewalDate!,
      daysUntil: Math.round((new Date(c.renewalDate! + "T00:00:00").getTime() - new Date(today + "T00:00:00").getTime()) / 86400000),
    })),
    ...urgentTickets.map((t) => ({
      type: "ticket_urgent" as const,
      tenantId: t.tenantId, tenantName: t.tenantName, ticketId: t.id, title: t.title,
      hoursOpen: Math.floor((now - new Date(t.createdAt).getTime()) / 3600000),
      responded: !!t.firstRespondedAt,
    })),
  ];

  res.json({
    counts,
    whatsapp: { connected: Number(wsConnected?.n ?? 0), total: Number(wsTotal?.n ?? 0) },
    criticalTickets: Number(criticalTicketCount?.n ?? 0),
    items,
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
const VALID_STATUSES = ["aberto", "em_analise", "em_andamento", "resolvido", "fechado"];
const VALID_CATEGORIES = ["bug", "duvida", "melhoria"];
const VALID_PRIORITIES = ["baixa", "normal", "alta", "urgente"];

router.get("/superadmin/saas/tickets", async (req, res): Promise<void> => {
  const { status, priority, category, tenantId } = req.query as Record<string, string | undefined>;
  const conditions = [];
  if (status && VALID_STATUSES.includes(status)) conditions.push(eq(saasTicketsTable.status, status));
  if (priority && VALID_PRIORITIES.includes(priority)) conditions.push(eq(saasTicketsTable.priority, priority));
  if (category && VALID_CATEGORIES.includes(category)) conditions.push(eq(saasTicketsTable.category, category));
  if (tenantId && Number.isFinite(Number(tenantId))) conditions.push(eq(saasTicketsTable.tenantId, Number(tenantId)));

  const rows = await db
    .select({ ticket: saasTicketsTable, tenantName: tenantsTable.name, openedByUserName: usersTable.name })
    .from(saasTicketsTable)
    .innerJoin(tenantsTable, eq(saasTicketsTable.tenantId, tenantsTable.id))
    .leftJoin(usersTable, eq(saasTicketsTable.openedByUserId, usersTable.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(saasTicketsTable.createdAt));
  res.json({ tickets: rows.map((r) => ({ ...r.ticket, tenantName: r.tenantName, openedByUserName: r.openedByUserName })) });
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
  const { status, priority, category, title, description, resolutionNote } = req.body as {
    status?: string; priority?: string; category?: string; title?: string; description?: string;
    resolutionNote?: string;
  };
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Chamado inválido" }); return; }
  const updates: Record<string, unknown> = {};
  if (status) {
    if (!VALID_STATUSES.includes(status)) { res.status(400).json({ error: "Situação inválida" }); return; }
    // Marcar como resolvido exige registrar a solução aplicada — fica
    // visível permanentemente no chamado (não é uma mensagem que se perde
    // na timeline, nem é limpa se o status mudar de novo depois).
    const hasNote = typeof resolutionNote === "string" && resolutionNote.trim().length > 0;
    if (status === "resolvido" && !hasNote) {
      res.status(400).json({ error: "Descreva a solução aplicada para marcar o chamado como resolvido." });
      return;
    }
    updates["status"] = status;
    updates["resolvedAt"] = status === "resolvido" || status === "fechado" ? new Date() : null;
  }
  if (typeof resolutionNote === "string") updates["resolutionNote"] = resolutionNote.trim() || null;
  if (priority) {
    if (!VALID_PRIORITIES.includes(priority)) { res.status(400).json({ error: "Prioridade inválida" }); return; }
    updates["priority"] = priority;
  }
  if (category) {
    if (!VALID_CATEGORIES.includes(category)) { res.status(400).json({ error: "Categoria inválida" }); return; }
    updates["category"] = category;
  }
  if (typeof title === "string" && title.trim()) updates["title"] = title.trim();
  if (typeof description === "string") updates["description"] = description.trim() || null;
  if (!Object.keys(updates).length) { res.status(400).json({ error: "Nada para atualizar" }); return; }
  const [ticket] = await db.update(saasTicketsTable).set(updates).where(eq(saasTicketsTable.id, id)).returning();
  if (!ticket) { res.status(404).json({ error: "Chamado não encontrado" }); return; }
  res.json({ ticket });
});

// ── Timeline de mensagens (lado superadmin — vê qualquer chamado) ─────────
router.get("/superadmin/saas/tickets/:id/messages", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Chamado inválido" }); return; }
  const rows = await db.select().from(saasTicketMessagesTable)
    .where(eq(saasTicketMessagesTable.ticketId, id)).orderBy(asc(saasTicketMessagesTable.createdAt));
  res.json({ messages: rows });
});

router.post("/superadmin/saas/tickets/:id/messages", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Chamado inválido" }); return; }
  const [ticket] = await db.select().from(saasTicketsTable).where(eq(saasTicketsTable.id, id)).limit(1);
  if (!ticket) { res.status(404).json({ error: "Chamado não encontrado" }); return; }

  const { content } = req.body as { content?: string };
  if (!content?.trim()) { res.status(400).json({ error: "Escreva uma mensagem" }); return; }

  const [message] = await db.insert(saasTicketMessagesTable).values({
    ticketId: id, authorType: "superadmin", authorUserId: null,
    authorName: req.session.userName ?? "Suporte Sheikcell", content: content.trim(),
  }).returning();

  // 1ª resposta do técnico/superadmin: alimenta o indicador de SLA na lista.
  if (!ticket.firstRespondedAt) {
    await db.update(saasTicketsTable).set({ firstRespondedAt: message!.createdAt }).where(eq(saasTicketsTable.id, id));
  }

  res.status(201).json({ message });
});

export default router;
