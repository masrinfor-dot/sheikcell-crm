import { pgTable, serial, integer, text, timestamp, jsonb, index, uniqueIndex, primaryKey } from "drizzle-orm/pg-core";

/**
 * Pontuação do atendimento → gamificação do ERP Prumo (27/10/2026).
 *
 * Fila (outbox) dos eventos das conversas: primeira resposta, conversa que
 * virou venda no ERP e conversa sem resposta no prazo. Cada evento nasce uma
 * vez (event_id único por loja, o mesmo id que vai ao ERP — lá também é
 * idempotente) e o agendador manda em lotes de até 200, com nova tentativa e
 * espera crescente. Se o ERP estiver fora do ar, nada se perde.
 *
 * LGPD: o payload é exatamente o item do contrato v1 — só ids e números
 * (nunca texto de mensagem, nome ou telefone do cliente). O e-mail que vai é
 * o do ATENDENTE (para o ERP achar o usuário).
 */
export const erpGamificationEventsTable = pgTable("erp_gamification_events", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  eventId: text("event_id").notNull(),
  type: text("type").notNull(),
  conversationId: integer("conversation_id"),
  agentUserId: integer("agent_user_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  payload: jsonb("payload").$type<ErpGamificationItem>().notNull(),
  status: text("status").notNull().default("pending"), // pending | processing | sent | failed
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  lastError: text("last_error"),
  // Resposta do ERP para este evento (APLICADO, DUPLICADO, SEM_USUARIO, ...).
  erpStatus: text("erp_status"),
  erpPoints: integer("erp_points"),
  erpMessage: text("erp_message"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("erp_gamification_events_tenant_event_uniq").on(t.tenantId, t.eventId),
  index("erp_gamification_events_status_next_idx").on(t.status, t.nextAttemptAt),
  index("erp_gamification_events_tenant_created_idx").on(t.tenantId, t.createdAt),
]);

/** Item do contrato v1 (`POST /integrations/gamification/v1/events`). */
export interface ErpGamificationItem {
  eventId: string;
  type: "CONVERSATION_FIRST_RESPONSE" | "CONVERSATION_CONVERTED" | "CONVERSATION_UNANSWERED_SLA";
  occurredAt: string;
  agent: { externalId: string; email?: string };
  conversationId?: string;
  storeId?: string;
  responseSeconds?: number;
  waitingSeconds?: number;
  quoteId?: string;
  saleId?: string;
}

export type ErpGamificationEventRow = typeof erpGamificationEventsTable.$inferSelect;

/**
 * Loja do CRM (ou linha de WhatsApp) → loja do ERP (27/10/2026). Usada pela
 * fila "Clientes esperando resposta" da TV de cada loja e para dizer ao ERP
 * em que loja aconteceu o evento da pontuação. kind = "store" (crm_ref = id
 * da loja daqui) ou "line" (crm_ref = session_key da linha, ou "instagram").
 */
export const erpStoreLinksTable = pgTable("erp_store_links", {
  tenantId: integer("tenant_id").notNull(),
  kind: text("kind").$type<"store" | "line">().notNull(),
  crmRef: text("crm_ref").notNull(),
  erpStoreId: text("erp_store_id").notNull(),
  erpStoreName: text("erp_store_name"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.kind, t.crmRef] })]);

export type ErpStoreLink = typeof erpStoreLinksTable.$inferSelect;
