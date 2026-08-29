import { pgTable, serial, text, integer, boolean, timestamp, date, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";
import { plansTable, type PlanLimits } from "./plans";

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
    // Plano de limites (Fase 3 — Planos & Limites). Null = loja ainda sem
    // plano de limites atribuído (nenhum bloqueio se aplica, tudo ilimitado).
    planId: integer("plan_id").references(() => plansTable.id),
    // false (padrão) = usa os limites do plano acima tal como cadastrado.
    // true = ignora o plano nesse(s) recurso(s) e usa customLimits — a
    // negociação combinada com esse cliente específico, sem afetar o plano
    // nem as demais lojas que usam o mesmo plano.
    usesCustomLimits: boolean("uses_custom_limits").notNull().default(false),
    // Só chaves customizadas ficam aqui (parcial) — o que não está presente
    // cai de volta no valor do plano. Só tem efeito quando usesCustomLimits
    // é true.
    customLimits: jsonb("custom_limits").$type<Partial<PlanLimits>>(),
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

// Chamados de suporte por lojista — a loja abre/conversa, o superadmin
// (ou um técnico) triagem e responde.
export const saasTicketsTable = pgTable("saas_tickets", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  title: text("title").notNull(),
  description: text("description"),
  // aberto | em_analise | em_andamento | resolvido | fechado
  status: text("status").notNull().default("aberto"),
  // baixa | normal | alta | urgente
  priority: text("priority").notNull().default("normal"),
  // bug | duvida | melhoria
  category: text("category").notNull().default("duvida"),
  // Quem na loja abriu (null quando o superadmin cria manualmente em nome
  // da loja, fluxo antigo que continua existindo).
  openedByUserId: integer("opened_by_user_id").references(() => usersTable.id),
  // Loja específica dentro de uma rede multi-loja (users.storeName livre).
  storeName: text("store_name"),
  // 1ª resposta do superadmin/técnico — indicador de SLA na listagem sem
  // precisar buscar as mensagens de todo mundo.
  firstRespondedAt: timestamp("first_responded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  // Explicação da solução aplicada, preenchida ao marcar o chamado como
  // "resolvido" — fica registrada e visível permanentemente (o chamado
  // nunca é arquivado/escondido), não é limpa se o status mudar depois.
  resolutionNote: text("resolution_note"),
});

// Timeline de mensagens de um chamado — não se mistura com as conversas de
// WhatsApp/chat interno, é o histórico próprio do chamado.
export const saasTicketMessagesTable = pgTable(
  "saas_ticket_messages",
  {
    id: serial("id").primaryKey(),
    ticketId: integer("ticket_id").notNull().references(() => saasTicketsTable.id, { onDelete: "cascade" }),
    // tenant | superadmin
    authorType: text("author_type").notNull(),
    authorUserId: integer("author_user_id").references(() => usersTable.id),
    authorName: text("author_name").notNull(),
    content: text("content"),
    mediaUrl: text("media_url"),
    mediaType: text("media_type"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("saas_ticket_messages_ticket_idx").on(t.ticketId)],
);

// Configurações do painel do dono (ex.: modelo base do contrato de aluguel).
export const saasSettingsTable = pgTable("saas_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SaasContract = typeof saasContractsTable.$inferSelect;
export type SaasInvoice = typeof saasInvoicesTable.$inferSelect;
export type SaasTicket = typeof saasTicketsTable.$inferSelect;
export type SaasTicketMessage = typeof saasTicketMessagesTable.$inferSelect;
