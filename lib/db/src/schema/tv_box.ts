import { pgTable, serial, text, integer, boolean, date, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sectorsTable } from "./sectors";

// Assinantes da TV Box (Uni TV) revendida pela loja — cadastro + mensalidade
// recorrente. Espelha o mesmo modelo já usado pra cobrar a MENSALIDADE DA
// PRÓPRIA LOJA na plataforma (saas_contracts/saas_invoices em schema/saas.ts),
// só que por loja (tenant) em vez de por loja-do-sistema-inteiro.
export const tvBoxClientsTable = pgTable("tv_box_clients", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  // valor em centavos para não sofrer com arredondamento de float
  monthlyValueCents: integer("monthly_value_cents").notNull(),
  // dia do vencimento (1-28, evita mês curto) — cobrado nesse dia todo mês
  dueDay: integer("due_day").notNull(),
  // Setor onde as conversas de cobrança deste cliente caem (ver ensureTvBoxSector).
  sectorId: integer("sector_id").references(() => sectorsTable.id),
  // ativo | suspenso | cancelado — só muda por ação manual do admin; o
  // sistema NUNCA suspende sozinho, só continua cobrando enquanto pendente.
  status: text("status").notNull().default("ativo"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Mensalidades (cobranças) de cada cliente da TV Box.
export const tvBoxInvoicesTable = pgTable(
  "tv_box_invoices",
  {
    tenantId: integer("tenant_id").notNull().default(1),
    id: serial("id").primaryKey(),
    clientId: integer("client_id").notNull().references(() => tvBoxClientsTable.id, { onDelete: "cascade" }),
    description: text("description").notNull().default("Mensalidade TV Box"),
    amountCents: integer("amount_cents").notNull(),
    dueDate: date("due_date").notNull(),
    // Preenchido só pela geração automática ("YYYY-MM"); o índice único
    // garante no banco que nunca há duas mensalidades geradas pro mesmo
    // cliente no mesmo mês, mesmo com ticks concorrentes.
    billingMonth: text("billing_month"),
    // pendente | pago | cancelado — "atrasada" é derivada (pendente + vencida)
    status: text("status").notNull().default("pendente"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    // Lembrete pré-vencimento: só um por fatura.
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
    // Última cobrança pós-vencimento enviada — permite espaçar reenvios
    // (settings.overdueMessageIntervalDays) sem repetir todo tick.
    lastChargeSentAt: timestamp("last_charge_sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tv_box_invoices_client_month_unique").on(t.clientId, t.billingMonth)],
);

export type TvBoxClient = typeof tvBoxClientsTable.$inferSelect;
export type TvBoxInvoice = typeof tvBoxInvoicesTable.$inferSelect;
