import { pgTable, serial, integer, text, boolean, timestamp, index } from "drizzle-orm/pg-core";

// Trocas com o ERP (19/10/2026 — Samuel: "cria uma aba com todas as
// informações que são trocadas entre o CRM e o Prumo"). Uma linha por chamada
// do CRM ao ERP (ou arquivo exportado para o ERP): fluxo, lado, rota sem query,
// status, duração e contagem. NUNCA guarda conteúdo (texto de mensagem de
// cliente, documento, chave). Guardado 90 dias (limpeza no scheduler).
export const erpExchangeLogsTable = pgTable("erp_exchange_logs", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  flow: text("flow").notNull(),
  direction: text("direction").notNull(),
  method: text("method").notNull(),
  path: text("path").notNull(),
  httpStatus: integer("http_status"),
  ok: boolean("ok").notNull(),
  durationMs: integer("duration_ms").notNull().default(0),
  itemCount: integer("item_count"),
  summary: text("summary"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("erp_exchange_logs_tenant_created_idx").on(t.tenantId, t.createdAt),
  index("erp_exchange_logs_created_idx").on(t.createdAt),
]);

export type ErpExchangeLog = typeof erpExchangeLogsTable.$inferSelect;
