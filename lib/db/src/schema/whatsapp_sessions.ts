import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";

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
  // Identidade visual da conexão na Central de Atendimento — cada número
  // (sessionKey) ganha uma cor própria pra etiqueta "via <número>", pra
  // reduzir erro de responder pelo número errado quando há mais de um.
  color: text("color").notNull().default("#10b981"),
  icon: text("icon"), // emoji opcional (ex.: "🏬"), mostrado junto da etiqueta
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WhatsappSession = typeof whatsappSessionsTable.$inferSelect;
