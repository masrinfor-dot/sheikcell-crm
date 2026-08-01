import { pgTable, serial, text, integer, boolean, timestamp, date, uniqueIndex } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";

// Tabelas do "negócio SaaS" do dono do sistema (superadmin). Nada aqui é
// visível para as lojas — só o superadmin acessa via rotas /superadmin/*.

// Contrato de aluguel do sistema de cada lojista (1 por loja).
export const saasContractsTable = pgTable(
  "saas_contracts",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
    plan: text("plan").notNull().default("Mensal"),
    // valor em centavos para não sofrer com arredondamento de float
    monthlyValueCents: integer("monthly_value_cents").notNull().default(0),
    startDate: date("start_date"),
    renewalDate: date("renewal_date"),
    notes: text("notes"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("saas_contracts_tenant_unique").on(t.tenantId)],
);

// Mensalidades (cobranças) de cada lojista.
export const saasInvoicesTable = pgTable(
  "saas_invoices",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
    description: text("description").notNull().default("Mensalidade"),
    amountCents: integer("amount_cents").notNull(),
    dueDate: date("due_date").notNull(),
    // Preenchido só pela geração automática ("YYYY-MM"); o índice único
    // garante no banco que nunca há duas mensalidades geradas para a mesma
    // loja no mesmo mês, mesmo com requisições simultâneas.
    billingMonth: text("billing_month"),
    // pendente | paga | cancelada — "atrasada" é derivada (pendente + vencida)
    status: text("status").notNull().default("pendente"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("saas_invoices_tenant_month_unique").on(t.tenantId, t.billingMonth)],
);

// Chamados de manutenção/suporte por lojista.
export const saasTicketsTable = pgTable("saas_tickets", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  title: text("title").notNull(),
  description: text("description"),
  // aberto | em_andamento | resolvido
  status: text("status").notNull().default("aberto"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

// Configurações do painel do dono (ex.: modelo base do contrato de aluguel).
export const saasSettingsTable = pgTable("saas_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SaasContract = typeof saasContractsTable.$inferSelect;
export type SaasInvoice = typeof saasInvoicesTable.$inferSelect;
export type SaasTicket = typeof saasTicketsTable.$inferSelect;
