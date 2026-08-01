import { pgTable, serial, text, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { conversationsTable } from "./conversations";

// Avisos persistentes do sino da Central de Atendimento.
// Hoje cobrem os agendamentos ("retorno" vencido e "failed" = envio agendado
// que falhou). O SSE continua avisando em tempo real; esta tabela garante que
// o aviso NÃO se perde se o vendedor estiver offline na hora — ao abrir a
// Central, os não lidos são carregados no sino.
export const chatNotificationsTable = pgTable("chat_notifications", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  kind: text("kind").notNull(),                 // retorno | failed
  scheduledId: integer("scheduled_id"),          // agendamento de origem (dedupe no sino)
  conversationId: integer("conversation_id").notNull().references(() => conversationsTable.id),
  convName: text("conv_name").notNull().default(""),
  content: text("content").notNull().default(""),
  read: boolean("read").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
