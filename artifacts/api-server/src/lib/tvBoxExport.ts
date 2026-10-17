// Exportação da TV Box para o ERP (17/10/2026) — GET /api/tvbox/export.
import { asc, eq } from "drizzle-orm";
import { db, tenantsTable, tvBoxClientsTable, tvBoxInvoicesTable } from "@workspace/db";
import { getTvBoxSettings } from "./tvBoxSettings";
import { tvBoxMovedToErp } from "./tvBoxMoved";

/**
 * Pacote que o ERP importa em TV Box › Importar do CRM (versão 1, kind
 * "tv-box"): clientes, todas as faturas e as mensagens configuradas. Ids do
 * CRM vão junto (o ERP importa de novo sem duplicar). `crmBillingDisabled`
 * diz se a cobrança automática do CRM já foi desligada — só com ele `true` o
 * ERP libera a cobrança automática de lá (nunca cobrar em dobro).
 */
export async function buildTvBoxExport(tenantId: number, now = new Date()) {
  const [[tenant], clients, invoices, settings, moved] = await Promise.all([
    db.select({ id: tenantsTable.id, name: tenantsTable.name }).from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1),
    db.select().from(tvBoxClientsTable).where(eq(tvBoxClientsTable.tenantId, tenantId)).orderBy(asc(tvBoxClientsTable.id)),
    db.select().from(tvBoxInvoicesTable).where(eq(tvBoxInvoicesTable.tenantId, tenantId)).orderBy(asc(tvBoxInvoicesTable.id)),
    getTvBoxSettings(tenantId),
    tvBoxMovedToErp(tenantId),
  ]);
  return {
    version: 1,
    kind: "tv-box",
    source: "sheikcell-crm",
    exportedAt: now.toISOString(),
    tenant: tenant ?? { id: tenantId, name: null },
    crmBillingDisabled: moved,
    settings,
    clients: clients.map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      monthlyValueCents: c.monthlyValueCents,
      dueDay: c.dueDay,
      status: c.status,
      notes: c.notes,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })),
    invoices: invoices.map((i) => ({
      id: i.id,
      clientId: i.clientId,
      description: i.description,
      amountCents: i.amountCents,
      dueDate: i.dueDate,
      billingMonth: i.billingMonth,
      status: i.status,
      paidAt: i.paidAt,
      reminderSentAt: i.reminderSentAt,
      lastChargeSentAt: i.lastChargeSentAt,
      createdAt: i.createdAt,
    })),
  };
}

