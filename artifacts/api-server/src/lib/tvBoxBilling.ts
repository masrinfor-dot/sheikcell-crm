import { and, eq, sql } from "drizzle-orm";
import { db, appSettingsTable, tvBoxClientsTable, tvBoxInvoicesTable } from "@workspace/db";
import { logger } from "./logger";
import { TV_BOX_MOVED_KEY, tenantsWithTvBoxMoved } from "./tvBoxMoved";

// ── Geração de mensalidades dos clientes da TV Box ───────────────────────────
// Mesmo desenho de lib/saasBilling.ts (que gera as mensalidades das LOJAS na
// plataforma), aplicado aqui aos clientes de TV Box de cada loja. Idempotente:
// pula clientes que já têm mensalidade com vencimento no mês (inclui as
// lançadas manualmente) e o índice único (client_id, billing_month) garante
// no banco que nunca há duplicata mesmo sob corrida.
//
// Loja que passou a TV Box para o ERP ("Desligar no CRM") fica de fora: a
// cobrança dela passa a ser do ERP e o CRM nunca gera em dobro.

/**
 * Gera as mensalidades do mês `m` ("YYYY-MM") a partir dos clientes ativos de
 * TV Box (de todas as lojas — cada linha já carrega seu próprio tenant_id).
 * Retorna quantas foram criadas.
 */
export async function generateTvBoxInvoicesForMonth(m: string): Promise<number> {
  const clients = await db
    .select({ id: tvBoxClientsTable.id, tenantId: tvBoxClientsTable.tenantId, dueDay: tvBoxClientsTable.dueDay, monthlyValueCents: tvBoxClientsTable.monthlyValueCents })
    .from(tvBoxClientsTable)
    .where(and(eq(tvBoxClientsTable.status, "ativo"), sql`${tvBoxClientsTable.monthlyValueCents} > 0`));

  const moved = await tenantsWithTvBoxMoved();
  let created = 0;
  for (const c of clients) {
    if (moved.has(c.tenantId)) continue;
    const lastDay = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).getDate();
    const dueDate = `${m}-${String(Math.min(c.dueDay, lastDay)).padStart(2, "0")}`;
    // Trava a linha do cliente (FOR UPDATE) e re-checa o status depois do
    // lock: cliente cancelado/suspenso no meio do tick nunca ganha fatura
    // nova. A não-duplicação por mês é garantida NO BANCO pelo índice único
    // (client_id, billing_month).
    const inserted = await db.transaction(async (tx) => {
      const [client] = await tx.select().from(tvBoxClientsTable).where(eq(tvBoxClientsTable.id, c.id)).for("update");
      if (!client || client.status !== "ativo" || client.monthlyValueCents <= 0) return false;
      // Re-checa DENTRO da transação: se o admin desligou no CRM no meio do
      // tick, esta loja não ganha mais nenhuma fatura aqui.
      const [movedNow] = await tx.select({ value: appSettingsTable.value }).from(appSettingsTable)
        .where(and(eq(appSettingsTable.tenantId, client.tenantId), eq(appSettingsTable.key, TV_BOX_MOVED_KEY)))
        .limit(1);
      if (movedNow?.value === "true") return false;
      const [already] = await tx
        .select({ id: tvBoxInvoicesTable.id })
        .from(tvBoxInvoicesTable)
        .where(and(
          eq(tvBoxInvoicesTable.clientId, c.id),
          sql`${tvBoxInvoicesTable.status} <> 'cancelado'`,
          sql`to_char(${tvBoxInvoicesTable.dueDate}, 'YYYY-MM') = ${m}`,
        ))
        .limit(1);
      if (already) return false;
      const rows = await tx
        .insert(tvBoxInvoicesTable)
        .values({
          tenantId: client.tenantId,
          clientId: c.id,
          description: `Mensalidade TV Box ${m.slice(5, 7)}/${m.slice(0, 4)}`,
          amountCents: client.monthlyValueCents,
          dueDate,
          billingMonth: m,
        })
        .onConflictDoNothing({ target: [tvBoxInvoicesTable.clientId, tvBoxInvoicesTable.billingMonth] })
        .returning({ id: tvBoxInvoicesTable.id });
      return rows.length > 0;
    });
    if (inserted) created++;
  }
  return created;
}

// ── Tick automático (agendador) ──────────────────────────────────────────────
let billingRunning = false;
export async function runTvBoxMonthlyBilling(now: Date = new Date()): Promise<void> {
  if (billingRunning) return; // evita ticks sobrepostos
  billingRunning = true;
  try {
    const m = now.toISOString().slice(0, 7); // "YYYY-MM"
    const created = await generateTvBoxInvoicesForMonth(m);
    if (created > 0) {
      logger.info({ month: m, created }, "Mensalidades de TV Box geradas automaticamente");
    }
  } catch (err) {
    logger.warn({ err }, "Tick de geração automática de mensalidades da TV Box falhou");
  } finally {
    billingRunning = false;
  }
}
