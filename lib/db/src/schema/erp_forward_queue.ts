import { pgTable, serial, integer, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

/**
 * Fila (outbox) do encaminhamento ao ERP (19/10/2026): cada mensagem recebida
 * numa conexão marcada como "WhatsApp de compras" vira uma linha aqui e é
 * enviada ao ERP pelo agendador, com nova tentativa em caso de falha. O
 * webhook do WhatsApp nunca espera o ERP. `external_id` = id da mensagem no
 * WhatsApp (o ERP também é idempotente por ele).
 */
export const erpForwardQueueTable = pgTable("erp_forward_queue", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1),
  sessionKey: text("session_key").notNull(),
  externalId: text("external_id").notNull().unique(),
  conversationId: integer("conversation_id"),
  payload: jsonb("payload").$type<ErpForwardPayload>().notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  erpListId: text("erp_list_id"),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("erp_forward_queue_status_next_idx").on(t.status, t.nextAttemptAt),
  index("erp_forward_queue_tenant_idx").on(t.tenantId, t.createdAt),
]);

export interface ErpForwardPayload {
  senderPhone: string;
  senderName: string | null;
  receivedAt: string;
  text: string | null;
  fileName: string | null;
  mimeType: string | null;
  /** Arquivo já salvo pelo CRM (MEDIA_DIR) — lido na hora de mandar. */
  mediaPath: string | null;
  /** Só quando o CRM não guardou o arquivo (tipo fora da lista): vai inline. */
  mediaBase64: string | null;
}

export type ErpForwardQueueRow = typeof erpForwardQueueTable.$inferSelect;
