import { and, eq, sql } from "drizzle-orm";
import { db, tenantsTable, saasContractsTable, saasInvoicesTable } from "@workspace/db";
import { logger } from "./logger";

// ── Geração de mensalidades dos lojistas ─────────────────────────────────────
// Lógica compartilhada entre o botão "Gerar mensalidades do mês" (rota do
// superadmin) e o agendador automático (dia 1º de cada mês). Idempotente:
// pula lojas que já têm mensalidade com vencimento no mês (inclui as lançadas
// manualmente) e o índice único (tenant_id, billing_month) garante no banco
// que nunca há duplicata mesmo sob corrida.

/**
 * Gera as mensalidades do mês `m` ("YYYY-MM") a partir dos contratos ativos
 * de lojistas não cancelados. Retorna quantas foram criadas.
 */
export async function generateInvoicesForMonth(m: string): Promise<number> {
  // Só contratos ativos de lojistas não cancelados — nunca cobrar loja cancelada
  const contracts = await db
    .select({ tenantId: saasContractsTable.tenantId, monthlyValueCents: saasContractsTable.monthlyValueCents, startDate: saasContractsTable.startDate })
    .from(saasContractsTable)
    .innerJoin(tenantsTable, eq(saasContractsTable.tenantId, tenantsTable.id))
    .where(and(
      eq(saasContractsTable.isActive, true),
      sql`${saasContractsTable.monthlyValueCents} > 0`,
      sql`${tenantsTable.saasStatus} <> 'cancelado'`,
    ));
  let created = 0;
  for (const c of contracts) {
    // vencimento no dia do início do contrato (ou dia 5)
    const day = c.startDate ? c.startDate.slice(8, 10) : "05";
    const lastDay = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).getDate();
    const dueDate = `${m}-${String(Math.min(Number(day), lastDay)).padStart(2, "0")}`;
    // Cada loja numa transação que trava a linha do tenant (FOR UPDATE) e
    // re-checa status/contrato após o lock: cancelamento simultâneo espera e
    // nunca sobra cobrança pendente de loja cancelada. A não-duplicação por
    // mês é garantida NO BANCO pelo índice único (tenant_id, billing_month).
    const inserted = await db.transaction(async (tx) => {
      const [tenant] = await tx.select().from(tenantsTable).where(eq(tenantsTable.id, c.tenantId)).for("update");
      if (!tenant || tenant.saasStatus === "cancelado") return false;
      const [contract] = await tx.select().from(saasContractsTable).where(eq(saasContractsTable.tenantId, c.tenantId));
      if (!contract?.isActive || contract.monthlyValueCents <= 0) return false;
      // Pula lojas que JÁ têm mensalidade no mês (inclui as lançadas
      // manualmente, que têm billing_month nulo) — checado sob o mesmo lock
      // da loja, então não há corrida com o lançamento manual.
      const [already] = await tx
        .select({ id: saasInvoicesTable.id })
        .from(saasInvoicesTable)
        .where(and(
          eq(saasInvoicesTable.tenantId, c.tenantId),
          sql`${saasInvoicesTable.status} <> 'cancelada'`,
          sql`to_char(${saasInvoicesTable.dueDate}, 'YYYY-MM') = ${m}`,
        ))
        .limit(1);
      if (already) return false;
      const rows = await tx
        .insert(saasInvoicesTable)
        .values({
          tenantId: c.tenantId,
          description: `Mensalidade ${m.slice(5, 7)}/${m.slice(0, 4)}`,
          amountCents: contract.monthlyValueCents,
          dueDate,
          billingMonth: m,
        })
        .onConflictDoNothing({ target: [saasInvoicesTable.tenantId, saasInvoicesTable.billingMonth] })
        .returning({ id: saasInvoicesTable.id });
      return rows.length > 0;
    });
    if (inserted) created++;
  }
  return created;
}

// ── Tick automático (agendador) ──────────────────────────────────────────────
// Roda periodicamente e garante que as mensalidades do mês corrente existam.
// Como a geração é idempotente (e barata: só contratos ativos), não precisa
// "lembrar" se já rodou — sobrevive a reinícios do servidor e cobre também o
// caso do servidor estar fora do ar exatamente no dia 1º (gera assim que
// voltar). Uma falha num tick não derruba nada: o próximo tenta de novo.
let billingRunning = false;
export async function runMonthlyBilling(now: Date = new Date()): Promise<void> {
  if (billingRunning) return; // evita ticks sobrepostos
  billingRunning = true;
  try {
    const m = now.toISOString().slice(0, 7); // "YYYY-MM"
    const created = await generateInvoicesForMonth(m);
    if (created > 0) {
      logger.info({ month: m, created }, "Mensalidades do mês geradas automaticamente");
    }
  } catch (err) {
    logger.warn({ err }, "Tick de geração automática de mensalidades falhou");
  } finally {
    billingRunning = false;
  }
}
