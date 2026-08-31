import { Router, type IRouter } from "express";
import { db, financeBankAccountsTable, financePaymentsTable, financePaymentAllocationsTable, storesTable } from "@workspace/db";
import { eq, and, asc, desc, gte, lte, inArray, sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { requireAuth, requireTenant } from "../middlewares/auth";
import { requireModuleAccess } from "../lib/moduleAccess";

const router: IRouter = Router();
router.use("/finance/bank-accounts", requireModuleAccess("pagamentos"));
router.use("/finance/payments", requireModuleAccess("pagamentos"));

function clean(v: unknown, maxLen: number): string {
  return typeof v === "string" ? v.trim().slice(0, maxLen) : "";
}

// Duas casas decimais, sempre — evita sobra de ponto flutuante nos valores
// em reais (mesmo cuidado da planilha original: "ajusta os centavos pra
// fechar o valor exato").
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

async function assertStoreOwned(tenantId: number, storeId: number): Promise<boolean> {
  const [row] = await db.select({ id: storesTable.id }).from(storesTable)
    .where(and(eq(storesTable.id, storeId), eq(storesTable.tenantId, tenantId))).limit(1);
  return !!row;
}

// ─── Contas bancárias (cadastro manual, sem integração — ver comentário no schema) ───

router.get("/finance/bank-accounts", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const storeId = req.query.storeId ? parseInt(String(req.query.storeId), 10) : null;
  const conds = [eq(financeBankAccountsTable.tenantId, tenantId)];
  if (storeId) conds.push(eq(financeBankAccountsTable.storeId, storeId));
  const rows = await db.select().from(financeBankAccountsTable)
    .where(and(...conds)).orderBy(asc(financeBankAccountsTable.bankName));
  res.json(rows);
});

router.post("/finance/bank-accounts", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const body = req.body as Record<string, unknown>;
  const storeId = Number(body.storeId);
  const bankName = clean(body.bankName, 80);
  if (!Number.isInteger(storeId) || storeId <= 0) { res.status(400).json({ error: "Selecione a filial" }); return; }
  if (!bankName) { res.status(400).json({ error: "Informe o nome do banco" }); return; }
  if (!(await assertStoreOwned(tenantId, storeId))) { res.status(400).json({ error: "Filial inválida" }); return; }
  const [created] = await db.insert(financeBankAccountsTable)
    .values({ tenantId, storeId, bankName, label: clean(body.label, 80) || null })
    .returning();
  res.status(201).json(created);
});

router.patch("/finance/bank-accounts/:id", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const body = req.body as Record<string, unknown>;
  const update: Record<string, unknown> = {};
  if (typeof body.bankName === "string") {
    const n = clean(body.bankName, 80);
    if (!n) { res.status(400).json({ error: "Nome do banco não pode ficar vazio" }); return; }
    update.bankName = n;
  }
  if ("label" in body) update.label = clean(body.label, 80) || null;
  if (typeof body.isActive === "boolean") update.isActive = body.isActive;
  if (Object.keys(update).length === 0) { res.status(400).json({ error: "Nada para atualizar" }); return; }
  const [updated] = await db.update(financeBankAccountsTable).set(update)
    .where(and(eq(financeBankAccountsTable.id, id), eq(financeBankAccountsTable.tenantId, tenantId))).returning();
  if (!updated) { res.status(404).json({ error: "Conta não encontrada" }); return; }
  res.json(updated);
});

// ─── Pagamentos + rateio entre filiais ───

type AllocationInput = { storeId: number; percent: number | null };

// Normaliza o rateio recebido e calcula o valor final (em R$) de cada
// filial, garantindo que a soma bate exatamente com totalAmount — mesma
// regra da planilha ("Por %": o sistema normaliza e ajusta os centavos pra
// fechar o valor exato; "Por valor": usa o valor digitado direto).
function computeAllocationAmounts(
  allocations: AllocationInput[],
  totalAmount: number,
  splitMode: "percent" | "value",
  rawAmounts: Map<number, number>,
): { storeId: number; percent: number | null; amount: number }[] | null {
  if (allocations.length === 0) return null;

  if (splitMode === "value") {
    const sum = round2(allocations.reduce((s, a) => s + (rawAmounts.get(a.storeId) ?? 0), 0));
    if (Math.abs(sum - round2(totalAmount)) > 0.01) return null; // não fecha com o valor total
    return allocations.map((a) => ({ storeId: a.storeId, percent: null, amount: round2(rawAmounts.get(a.storeId) ?? 0) }));
  }

  // percent: normaliza pra somar 1 (tolera pequena imprecisão de digitação,
  // igual à planilha aceitando 0.9999) e ajusta os centavos na última linha.
  const percentSum = allocations.reduce((s, a) => s + (a.percent ?? 0), 0);
  if (percentSum <= 0) return null;
  const out: { storeId: number; percent: number | null; amount: number }[] = [];
  let allocated = 0;
  allocations.forEach((a, i) => {
    const pct = (a.percent ?? 0) / percentSum;
    if (i === allocations.length - 1) {
      out.push({ storeId: a.storeId, percent: pct, amount: round2(totalAmount - allocated) });
    } else {
      const amount = round2(totalAmount * pct);
      allocated = round2(allocated + amount);
      out.push({ storeId: a.storeId, percent: pct, amount });
    }
  });
  return out;
}

async function loadPaymentsWithAllocations(tenantId: number, paymentIds: number[]) {
  if (paymentIds.length === 0) return new Map<number, { storeId: number; percent: string | null; amount: string }[]>();
  const rows = await db.select({
    paymentId: financePaymentAllocationsTable.paymentId,
    storeId: financePaymentAllocationsTable.storeId,
    percent: financePaymentAllocationsTable.percent,
    amount: financePaymentAllocationsTable.amount,
  }).from(financePaymentAllocationsTable).where(inArray(financePaymentAllocationsTable.paymentId, paymentIds));
  const map = new Map<number, { storeId: number; percent: string | null; amount: string }[]>();
  for (const r of rows) {
    const list = map.get(r.paymentId) ?? [];
    list.push({ storeId: r.storeId, percent: r.percent, amount: r.amount });
    map.set(r.paymentId, list);
  }
  return map;
}

router.get("/finance/payments", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const conds = [eq(financePaymentsTable.tenantId, tenantId)];
  const status = typeof req.query.status === "string" ? req.query.status : null;
  if (status === "aberto" || status === "pago") conds.push(eq(financePaymentsTable.status, status));
  const bankAccountId = req.query.bankAccountId ? parseInt(String(req.query.bankAccountId), 10) : null;
  if (bankAccountId) conds.push(eq(financePaymentsTable.payingBankAccountId, bankAccountId));
  const from = typeof req.query.from === "string" ? new Date(req.query.from) : null;
  if (from && !isNaN(from.getTime())) conds.push(gte(financePaymentsTable.paymentDate, from));
  const to = typeof req.query.to === "string" ? new Date(req.query.to) : null;
  if (to && !isNaN(to.getTime())) conds.push(lte(financePaymentsTable.paymentDate, to));

  let payments = await db.select().from(financePaymentsTable)
    .where(and(...conds)).orderBy(desc(financePaymentsTable.paymentDate), desc(financePaymentsTable.id)).limit(500);

  // Filtro por filial: pagadora OU beneficiária do rateio — aplicado depois
  // de carregar as alocações, já que envolve a tabela filha.
  const storeId = req.query.storeId ? parseInt(String(req.query.storeId), 10) : null;
  const allocMap = await loadPaymentsWithAllocations(tenantId, payments.map((p) => p.id));
  if (storeId) {
    payments = payments.filter((p) => p.payingStoreId === storeId || (allocMap.get(p.id) ?? []).some((a) => a.storeId === storeId));
  }

  res.json(payments.map((p) => ({ ...p, allocations: allocMap.get(p.id) ?? [] })));
});

// Exporta os lançamentos filtrados (mesmos filtros da tela: filial, status,
// banco, período) pra uma planilha Excel — substitui de vez a necessidade de
// levar esses números pra uma planilha à parte. Duas abas: "Lançamentos" (uma
// linha por filial beneficiada do rateio — formato longo, bom pra somar/
// filtrar no Excel) e "Resumo por filial" (mesmo total pago/em aberto por
// filial mostrado na tela, sem os filtros de filial/status — visão geral).
router.get("/finance/payments/export", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const conds = [eq(financePaymentsTable.tenantId, tenantId)];
  const status = typeof req.query.status === "string" ? req.query.status : null;
  if (status === "aberto" || status === "pago") conds.push(eq(financePaymentsTable.status, status));
  const bankAccountId = req.query.bankAccountId ? parseInt(String(req.query.bankAccountId), 10) : null;
  if (bankAccountId) conds.push(eq(financePaymentsTable.payingBankAccountId, bankAccountId));
  const from = typeof req.query.from === "string" ? new Date(req.query.from) : null;
  if (from && !isNaN(from.getTime())) conds.push(gte(financePaymentsTable.paymentDate, from));
  const to = typeof req.query.to === "string" ? new Date(req.query.to) : null;
  if (to && !isNaN(to.getTime())) conds.push(lte(financePaymentsTable.paymentDate, to));

  let payments = await db.select().from(financePaymentsTable)
    .where(and(...conds)).orderBy(desc(financePaymentsTable.paymentDate), desc(financePaymentsTable.id)).limit(500);

  const storeId = req.query.storeId ? parseInt(String(req.query.storeId), 10) : null;
  const allocMap = await loadPaymentsWithAllocations(tenantId, payments.map((p) => p.id));
  if (storeId) {
    payments = payments.filter((p) => p.payingStoreId === storeId || (allocMap.get(p.id) ?? []).some((a) => a.storeId === storeId));
  }

  const [stores, bankAccounts] = await Promise.all([
    db.select().from(storesTable).where(eq(storesTable.tenantId, tenantId)),
    db.select().from(financeBankAccountsTable).where(eq(financeBankAccountsTable.tenantId, tenantId)),
  ]);
  const storeName = (id: number) => stores.find((s) => s.id === id)?.name ?? `Filial #${id}`;
  const bankLabel = (id: number) => {
    const b = bankAccounts.find((x) => x.id === id);
    if (!b) return `Banco #${id}`;
    return b.label ? `${b.bankName} (${b.label})` : b.bankName;
  };
  const fmtDate = (d: Date) => new Date(d).toLocaleDateString("pt-BR");

  const launchRows = payments.flatMap((p) => {
    const allocs = allocMap.get(p.id) ?? [];
    const base = {
      Data: fmtDate(p.paymentDate),
      Descrição: p.description,
      Fornecedor: p.supplier ?? "",
      "Filial pagadora": storeName(p.payingStoreId),
      "Banco pagador": bankLabel(p.payingBankAccountId),
      Tipo: p.splitType === "direta" ? "Direta" : "Rateada",
      "Valor total": Number(p.totalAmount),
      Status: p.status === "pago" ? "Pago" : "Em aberto",
      "Pago em": p.paidAt ? fmtDate(p.paidAt) : "",
    };
    if (allocs.length === 0) return [{ ...base, "Filial beneficiada": "", "% rateio": "", "Valor rateado": "" }];
    return allocs.map((a) => ({
      ...base,
      "Filial beneficiada": storeName(a.storeId),
      "% rateio": a.percent != null ? `${(Number(a.percent) * 100).toFixed(2)}%` : "",
      "Valor rateado": Number(a.amount),
    }));
  });

  // Resumo por filial: mesma consulta agregada da tela (sem filtro de
  // filial/status — visão geral de tudo que já foi rateado pra cada uma).
  const summaryRows = await db.select({
    storeId: financePaymentAllocationsTable.storeId,
    status: financePaymentsTable.status,
    total: sql<string>`coalesce(sum(${financePaymentAllocationsTable.amount}), 0)::text`,
  }).from(financePaymentAllocationsTable)
    .innerJoin(financePaymentsTable, eq(financePaymentAllocationsTable.paymentId, financePaymentsTable.id))
    .where(eq(financePaymentsTable.tenantId, tenantId))
    .groupBy(financePaymentAllocationsTable.storeId, financePaymentsTable.status);
  const byStore = new Map<number, { pago: number; aberto: number }>();
  for (const r of summaryRows) {
    const cur = byStore.get(r.storeId) ?? { pago: 0, aberto: 0 };
    if (r.status === "pago") cur.pago = Number(r.total); else cur.aberto = Number(r.total);
    byStore.set(r.storeId, cur);
  }
  const resumoRows = [...stores].sort((a, b) => a.name.localeCompare(b.name)).map((s) => {
    const v = byStore.get(s.id) ?? { pago: 0, aberto: 0 };
    return { Filial: s.name, Pago: v.pago, "Em aberto": v.aberto, Total: v.pago + v.aberto };
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(launchRows), "Lançamentos");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resumoRows), "Resumo por filial");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="pagamentos-entre-filiais.xlsx"`);
  res.send(buffer);
});

router.get("/finance/payments/summary", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const from = typeof req.query.from === "string" ? new Date(req.query.from) : null;
  const to = typeof req.query.to === "string" ? new Date(req.query.to) : null;
  const conds = [eq(financePaymentsTable.tenantId, tenantId)];
  if (from && !isNaN(from.getTime())) conds.push(gte(financePaymentsTable.paymentDate, from));
  if (to && !isNaN(to.getTime())) conds.push(lte(financePaymentsTable.paymentDate, to));

  const rows = await db.select({
    storeId: financePaymentAllocationsTable.storeId,
    status: financePaymentsTable.status,
    total: sql<string>`coalesce(sum(${financePaymentAllocationsTable.amount}), 0)::text`,
  }).from(financePaymentAllocationsTable)
    .innerJoin(financePaymentsTable, eq(financePaymentAllocationsTable.paymentId, financePaymentsTable.id))
    .where(and(...conds))
    .groupBy(financePaymentAllocationsTable.storeId, financePaymentsTable.status);

  const stores = await db.select().from(storesTable).where(eq(storesTable.tenantId, tenantId)).orderBy(asc(storesTable.name));
  const byStore = new Map<number, { pago: number; aberto: number }>();
  for (const r of rows) {
    const cur = byStore.get(r.storeId) ?? { pago: 0, aberto: 0 };
    if (r.status === "pago") cur.pago = Number(r.total); else cur.aberto = Number(r.total);
    byStore.set(r.storeId, cur);
  }
  res.json({
    stores: stores.map((s) => ({
      storeId: s.id, storeName: s.name,
      pago: byStore.get(s.id)?.pago ?? 0,
      aberto: byStore.get(s.id)?.aberto ?? 0,
    })),
  });
});

router.post("/finance/payments", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const body = req.body as Record<string, unknown>;

  const description = clean(body.description, 200);
  const paymentDate = new Date(String(body.paymentDate ?? ""));
  const payingBankAccountId = Number(body.payingBankAccountId);
  const payingStoreId = Number(body.payingStoreId);
  const totalAmount = Number(body.totalAmount);
  const splitType = body.splitType === "direta" ? "direta" : "rateada";
  const splitMode = body.splitMode === "value" ? "value" : "percent";

  if (!description) { res.status(400).json({ error: "Informe a descrição do pagamento" }); return; }
  if (isNaN(paymentDate.getTime())) { res.status(400).json({ error: "Data inválida" }); return; }
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) { res.status(400).json({ error: "Informe o valor total" }); return; }
  if (!(await assertStoreOwned(tenantId, payingStoreId))) { res.status(400).json({ error: "Filial pagadora inválida" }); return; }
  const [bankAccount] = await db.select().from(financeBankAccountsTable)
    .where(and(eq(financeBankAccountsTable.id, payingBankAccountId), eq(financeBankAccountsTable.tenantId, tenantId))).limit(1);
  if (!bankAccount) { res.status(400).json({ error: "Conta bancária inválida" }); return; }
  if (bankAccount.storeId !== payingStoreId) { res.status(400).json({ error: "Essa conta bancária não pertence à filial pagadora selecionada" }); return; }

  const rawAllocations = Array.isArray(body.allocations) ? body.allocations as Record<string, unknown>[] : [];
  const allocationInputs: AllocationInput[] = [];
  const rawAmounts = new Map<number, number>();
  for (const a of rawAllocations) {
    const storeId = Number(a.storeId);
    if (!Number.isInteger(storeId) || storeId <= 0) continue;
    if (!(await assertStoreOwned(tenantId, storeId))) { res.status(400).json({ error: "Filial do rateio inválida" }); return; }
    allocationInputs.push({ storeId, percent: a.percent != null ? Number(a.percent) : null });
    if (a.amount != null) rawAmounts.set(storeId, Number(a.amount));
  }
  if (allocationInputs.length === 0) { res.status(400).json({ error: "Informe pelo menos uma filial no rateio" }); return; }

  const computed = computeAllocationAmounts(allocationInputs, totalAmount, splitMode, rawAmounts);
  if (!computed) {
    res.status(400).json({ error: splitMode === "value" ? "A soma dos valores por filial não bate com o valor total" : "Rateio inválido" });
    return;
  }

  const [payment] = await db.insert(financePaymentsTable).values({
    tenantId, paymentDate, description,
    supplier: clean(body.supplier, 120) || null,
    payingBankAccountId, payingStoreId, splitType, splitMode,
    totalAmount: String(round2(totalAmount)),
    status: "aberto",
    createdBy: req.session.userId ?? null,
  }).returning();

  await db.insert(financePaymentAllocationsTable).values(
    computed.map((a) => ({
      paymentId: payment.id, storeId: a.storeId,
      percent: a.percent != null ? String(a.percent) : null,
      amount: String(a.amount),
    })),
  );

  res.status(201).json({ ...payment, allocations: computed });
});

router.patch("/finance/payments/:id", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const [existing] = await db.select().from(financePaymentsTable)
    .where(and(eq(financePaymentsTable.id, id), eq(financePaymentsTable.tenantId, tenantId))).limit(1);
  if (!existing) { res.status(404).json({ error: "Pagamento não encontrado" }); return; }

  const body = req.body as Record<string, unknown>;
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof body.description === "string") {
    const n = clean(body.description, 200);
    if (!n) { res.status(400).json({ error: "Descrição não pode ficar vazia" }); return; }
    update.description = n;
  }
  if ("supplier" in body) update.supplier = clean(body.supplier, 120) || null;
  if (typeof body.status === "string" && (body.status === "aberto" || body.status === "pago")) {
    update.status = body.status;
    update.paidAt = body.status === "pago" ? new Date() : null;
  }

  const [updated] = await db.update(financePaymentsTable).set(update)
    .where(and(eq(financePaymentsTable.id, id), eq(financePaymentsTable.tenantId, tenantId))).returning();
  const allocMap = await loadPaymentsWithAllocations(tenantId, [id]);
  res.json({ ...updated, allocations: allocMap.get(id) ?? [] });
});

router.delete("/finance/payments/:id", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.delete(financePaymentsTable)
    .where(and(eq(financePaymentsTable.id, id), eq(financePaymentsTable.tenantId, tenantId)));
  res.json({ ok: true });
});

export default router;
