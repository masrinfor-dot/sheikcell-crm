import { pgTable, serial, text, integer, timestamp, boolean, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { storesTable } from "./stores";
import { usersTable } from "./users";

// Módulo financeiro bancário (Fase 1 — fundação + PagBank real, ver plano).
// Conciliação entre o que entra/sai nas contas bancárias/gateways de cada loja
// (bank_transactions) e o que foi vendido nas maquininhas/credenciadoras
// (acquirer_sales), passando pelo repasse que liga as duas pontas (acquirer_repasses).
// Nenhum lançamento é apagado — só estornado/ajustado (auditabilidade).

// Conta bancária, gateway ou maquininha cadastrada para uma loja específica.
// "kind" distingue conta (extrato/saldo) de maquininha (vendas de cartão) —
// o PagBank, por exemplo, é as duas coisas ao mesmo tempo (duas linhas aqui).
export const bankAccountsTable = pgTable("bank_accounts", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  storeId: integer("store_id").notNull().references(() => storesTable.id),
  provider: text("provider").notNull(), // pagbank | inter | itau | asaas | mercado_pago | cappta | rede | bradesco | nubank | sicoob | sicredi
  kind: text("kind").notNull().default("conta"), // conta | maquininha
  label: text("label").notNull(),
  externalAccountId: text("external_account_id"),
  currency: text("currency").notNull().default("BRL"),
  status: text("status").notNull().default("nao_configurado"), // nao_configurado | conectado | erro | desconectado
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Credenciais/tokens de integração — SEMPRE criptografados (ver lib/crypto.ts no
// api-server); nunca gravar authTag/iv errado nem guardar o segredo em texto puro.
export const bankIntegrationCredentialsTable = pgTable("bank_integration_credentials", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  bankAccountId: integer("bank_account_id").notNull().references(() => bankAccountsTable.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  authType: text("auth_type").notNull().default("api_key"), // oauth | api_key
  encryptedPayload: text("encrypted_payload").notNull(),
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  status: text("status").notNull().default("ativo"), // ativo | erro | expirado
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Movimentações da conta bancária/gateway (extrato). Sem onDelete cascade a
// partir de bank_accounts: um lançamento financeiro não some junto com o
// cadastro da conta (auditabilidade).
export const bankTransactionsTable = pgTable(
  "bank_transactions",
  {
    tenantId: integer("tenant_id").notNull().default(1),
    id: serial("id").primaryKey(),
    bankAccountId: integer("bank_account_id").notNull().references(() => bankAccountsTable.id),
    externalId: text("external_id").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
    amountCents: integer("amount_cents").notNull(), // assinado: positivo = crédito, negativo = débito
    type: text("type").notNull(), // credit | debit
    description: text("description"),
    counterpartyDoc: text("counterparty_doc"), // CPF/CNPJ, quando disponível
    rawPayload: jsonb("raw_payload"),
    reconciliationStatus: text("reconciliation_status").notNull().default("pending"), // pending | matched | ignored
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("bank_transactions_account_external_unique").on(t.bankAccountId, t.externalId)],
);

// Venda registrada pela credenciadora/maquininha (camada 1 da conciliação:
// venda no sistema → venda na credenciadora → repasse na conta bancária).
export const acquirerSalesTable = pgTable(
  "acquirer_sales",
  {
    tenantId: integer("tenant_id").notNull().default(1),
    id: serial("id").primaryKey(),
    bankAccountId: integer("bank_account_id").notNull().references(() => bankAccountsTable.id), // a maquininha
    storeId: integer("store_id").notNull().references(() => storesTable.id),
    externalSaleId: text("external_sale_id").notNull(),
    soldAt: timestamp("sold_at", { withTimezone: true }).notNull(),
    grossAmountCents: integer("gross_amount_cents").notNull(),
    feeAmountCents: integer("fee_amount_cents").notNull().default(0),
    netAmountCents: integer("net_amount_cents").notNull(),
    installments: integer("installments").notNull().default(1),
    cardBrand: text("card_brand"),
    paymentMethod: text("payment_method").notNull().default("credito"), // credito | debito | pix
    authorizationCode: text("authorization_code"),
    nsu: text("nsu"),
    repasseStatus: text("repasse_status").notNull().default("pending"), // pending | repassado
    // Vínculo N:1 — várias vendas caem num único repasse consolidado (comum em
    // PagBank/Mercado Pago). Preenchido quando a credenciadora informa o
    // repasse, ou pelo motor de conciliação ao agrupar vendas contra um repasse.
    repasseId: integer("repasse_id").references(() => acquirerRepassesTable.id),
    rawPayload: jsonb("raw_payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("acquirer_sales_account_external_unique").on(t.bankAccountId, t.externalSaleId)],
);

// Repasse financeiro da credenciadora para a conta bancária de destino
// (camada 2 — liga um conjunto de acquirer_sales a um crédito em bank_transactions).
export const acquirerRepassesTable = pgTable(
  "acquirer_repasses",
  {
    tenantId: integer("tenant_id").notNull().default(1),
    id: serial("id").primaryKey(),
    bankAccountId: integer("bank_account_id").notNull().references(() => bankAccountsTable.id), // conta destino
    externalRepasseId: text("external_repasse_id").notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }).notNull(),
    amountCents: integer("amount_cents").notNull(),
    reconciledTransactionId: integer("reconciled_transaction_id").references(() => bankTransactionsTable.id),
    rawPayload: jsonb("raw_payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("acquirer_repasses_account_external_unique").on(t.bankAccountId, t.externalRepasseId)],
);

// Regras do motor de conciliação — avaliadas em ordem de "priority" (menor primeiro).
export const reconciliationRulesTable = pgTable("reconciliation_rules", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  ruleType: text("rule_type").notNull(), // valor_data | external_id | documento
  toleranceValueCents: integer("tolerance_value_cents"),
  toleranceDays: integer("tolerance_days"),
  priority: integer("priority").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Resultado da conciliação: qual bank_transaction foi casada com qual
// acquirer_sale/acquirer_repasse (ou marcada manualmente), e por qual regra.
export const reconciliationMatchesTable = pgTable("reconciliation_matches", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  bankTransactionId: integer("bank_transaction_id").notNull().references(() => bankTransactionsTable.id),
  matchedType: text("matched_type").notNull(), // acquirer_sale | acquirer_repasse | manual
  matchedRecordId: integer("matched_record_id"),
  ruleId: integer("rule_id").references(() => reconciliationRulesTable.id),
  matchedBy: text("matched_by").notNull().default("system"), // "system" ou id do usuário (texto)
  status: text("status").notNull().default("auto"), // auto | manual_confirmed | rejected
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Trabalho futuro (Fase 2+): tabelas criadas agora para não exigir outro
// push de schema depois, mas SEM rota/parser/UI nesta fase. ───────────────────

// Upload de relatório de vendas mensal (PDF/Excel) para conferência manual.
export const uploadsVendasTable = pgTable("uploads_vendas", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  storeId: integer("store_id").notNull().references(() => storesTable.id),
  fileName: text("file_name").notNull(),
  storedName: text("stored_name").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  uploadedBy: integer("uploaded_by").references(() => usersTable.id),
  status: text("status").notNull().default("pendente"), // pendente | processado | erro
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Linhas extraídas de um upload de vendas (uma por venda do arquivo enviado).
export const vendasImportadasTable = pgTable("vendas_importadas", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  uploadId: integer("upload_id").notNull().references(() => uploadsVendasTable.id, { onDelete: "cascade" }),
  rowNumber: integer("row_number").notNull(),
  soldAt: timestamp("sold_at", { withTimezone: true }),
  amountCents: integer("amount_cents").notNull(),
  description: text("description"),
  rawRow: jsonb("raw_row").notNull(),
  matched: boolean("matched").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Relatórios personalizados salvos (filtros + colunas + agrupamento).
export const relatoriosSalvosTable = pgTable("relatorios_salvos", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  config: jsonb("config").notNull(), // { filtros, colunas, agrupamento }
  createdBy: integer("created_by").references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type BankAccount = typeof bankAccountsTable.$inferSelect;
export type BankIntegrationCredential = typeof bankIntegrationCredentialsTable.$inferSelect;
export type BankTransaction = typeof bankTransactionsTable.$inferSelect;
export type AcquirerSale = typeof acquirerSalesTable.$inferSelect;
export type AcquirerRepasse = typeof acquirerRepassesTable.$inferSelect;
export type ReconciliationRule = typeof reconciliationRulesTable.$inferSelect;
export type ReconciliationMatch = typeof reconciliationMatchesTable.$inferSelect;
