import { pgTable, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";

// Ligação desta loja com o ERP Prumo (06/10/2026): endereço da API do ERP e a
// chave de integração gerada lá (Auxiliares › Integrações). A chave nunca é
// gravada em texto puro (AES-256-GCM, mesmo cofre da chave de IA — ver
// lib/aiCredentialsCrypto.ts) e nunca volta para o frontend, só os últimos 4.
// Primeiro uso: mensagens das OS (o CRM busca a fila do ERP a cada minuto,
// manda pelo WhatsApp e abre o atendimento).
export const tenantErpIntegrationsTable = pgTable("tenant_erp_integrations", {
  tenantId: integer("tenant_id").primaryKey(),
  baseUrl: text("base_url").notNull(),
  encryptedApiKey: text("encrypted_api_key").notNull(),
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  last4: text("last4").notNull(),
  osMessagesEnabled: boolean("os_messages_enabled").notNull().default(false),
  lastPollAt: timestamp("last_poll_at", { withTimezone: true }),
  lastError: text("last_error"),
  sentCount: integer("sent_count").notNull().default(0),
  // RH com o ERP (07/10/2026): o ERP é o dono de todo o cadastro; o CRM só
  // manda as batidas do WhatsApp, o fechamento do mês e os documentos da
  // contratação que recolhe. Cursores = último id já enviado ao ERP.
  hrSyncEnabled: boolean("hr_sync_enabled").notNull().default(false),
  hrImportedAt: timestamp("hr_imported_at", { withTimezone: true }),
  hrLastPullAt: timestamp("hr_last_pull_at", { withTimezone: true }),
  hrLastPunchId: integer("hr_last_punch_id").notNull().default(0),
  hrLastClosureId: integer("hr_last_closure_id").notNull().default(0),
  hrLastDocumentId: integer("hr_last_document_id").notNull().default(0),
  hrLastSyncAt: timestamp("hr_last_sync_at", { withTimezone: true }),
  hrLastError: text("hr_last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type TenantErpIntegration = typeof tenantErpIntegrationsTable.$inferSelect;
