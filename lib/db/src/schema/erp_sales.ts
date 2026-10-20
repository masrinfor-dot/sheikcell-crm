import { pgTable, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";

// Vendas que vieram do atendimento (19/10/2026): o CRM manda ao ERP Prumo os
// atendimentos (telefone do cliente, atendente, setor, loja, último contato,
// conversa) e o ERP marca a venda com o atendente. Uma linha por loja com o
// cursor do envio: (cursorAt, cursorId) = última conversa já enviada,
// ordenada pelo último movimento da conversa.
export const erpSalesSyncTable = pgTable("erp_sales_sync", {
  tenantId: integer("tenant_id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  cursorAt: timestamp("cursor_at", { withTimezone: true }),
  cursorId: integer("cursor_id").notNull().default(0),
  attendantsSyncedAt: timestamp("attendants_synced_at", { withTimezone: true }),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastError: text("last_error"),
  sentCount: integer("sent_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type ErpSalesSync = typeof erpSalesSyncTable.$inferSelect;
