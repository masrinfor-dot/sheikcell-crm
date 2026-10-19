import { pgTable, serial, text, timestamp, integer, boolean } from "drizzle-orm/pg-core";

export const whatsappSessionsTable = pgTable("whatsapp_sessions", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  sessionKey: text("session_key").notNull().unique(),
  displayName: text("display_name"),
  status: text("status").notNull().default("unknown"),
  phoneNumber: text("phone_number"),
  phoneId: text("phone_id"),
  errorMessage: text("error_message"),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  // WhatsApp de compras (19/10/2026): toda mensagem recebida nesta conexão é
  // encaminhada ao ERP (listas de preço dos fornecedores). Ver lib/erpForward.ts.
  forwardToErp: boolean("forward_to_erp").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WhatsappSession = typeof whatsappSessionsTable.$inferSelect;
