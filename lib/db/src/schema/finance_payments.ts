import { pgTable, serial, text, integer, timestamp, numeric, boolean } from "drizzle-orm/pg-core";
import { storesTable } from "./stores";
import { usersTable } from "./users";

// Módulo "Pagamentos entre Filiais" (aba Financeiro) — substitui a planilha
// manual que a matriz usava pra registrar pagamentos feitos em nome de
// outras lojas da rede e ratear o valor entre elas (banco pagador, filial
// pagadora, filial(is) beneficiada(s), valor, descrição).
//
// Importante: isto NÃO é o módulo "Financeiro Bancário" (conexão de conta
// real + conciliação automática) que existiu e foi removido em
// 0019_remove_peliculas_planilhas_financeiro_bancario.sql por nunca ter tido
// conta real conectada em produção. Aqui não há integração bancária nenhuma
// — "conta bancária" é só um rótulo cadastrado à mão (nome do banco/maquininha
// por filial), exatamente como a planilha fazia. Lançamento e rateio são
// sempre manuais, sem OFX/API de banco nenhuma.

// Conta bancária / maquininha cadastrada por filial — só identificação
// (nome do banco + apelido opcional), sem credenciais nem integração.
export const financeBankAccountsTable = pgTable("finance_bank_accounts", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  storeId: integer("store_id").notNull().references(() => storesTable.id),
  bankName: text("bank_name").notNull(), // ex.: "Itaú", "Inter", "PagSeguro", "Cappta"
  label: text("label"), // apelido opcional, ex.: "Maquininha loja"
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type FinanceBankAccount = typeof financeBankAccountsTable.$inferSelect;

// Pagamento lançado por uma filial (normalmente a Matriz) em nome da rede —
// pode ser rateado entre várias filiais ou direcionado 100% pra uma só
// (mesma distinção "Rateada"/"Direta" da planilha original). O rateio de
// verdade fica em financePaymentAllocationsTable — aqui ficam só os dados
// do lançamento em si.
export const financePaymentsTable = pgTable("finance_payments", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  paymentDate: timestamp("payment_date", { withTimezone: true }).notNull(),
  description: text("description").notNull(),
  supplier: text("supplier"), // fornecedor/beneficiário — texto livre
  payingBankAccountId: integer("paying_bank_account_id").notNull().references(() => financeBankAccountsTable.id),
  payingStoreId: integer("paying_store_id").notNull().references(() => storesTable.id), // quem pagou de fato (normalmente Matriz)
  splitType: text("split_type").notNull().default("rateada"), // rateada | direta — só controla como o formulário é reaberto pra edição
  splitMode: text("split_mode").notNull().default("percent"), // percent | value — só usado quando splitType = rateada
  totalAmount: numeric("total_amount").notNull(),
  status: text("status").notNull().default("aberto"), // aberto | pago
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type FinancePayment = typeof financePaymentsTable.$inferSelect;

// Rateio por filial de um pagamento — 1 linha por filial contemplada.
// Fonte de verdade do valor final: sum(amount) sempre é validado no backend
// pra bater com finance_payments.total_amount (percent é só informativo,
// guardado pra reabrir o formulário exatamente como foi digitado).
export const financePaymentAllocationsTable = pgTable("finance_payment_allocations", {
  id: serial("id").primaryKey(),
  paymentId: integer("payment_id").notNull().references(() => financePaymentsTable.id, { onDelete: "cascade" }),
  storeId: integer("store_id").notNull().references(() => storesTable.id),
  percent: numeric("percent"), // null quando splitMode = value
  amount: numeric("amount").notNull(),
});
export type FinancePaymentAllocation = typeof financePaymentAllocationsTable.$inferSelect;
