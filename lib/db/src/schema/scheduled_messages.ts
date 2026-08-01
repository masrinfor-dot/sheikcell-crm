import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { conversationsTable } from "./conversations";
import { usersTable } from "./users";
import { tasksTable } from "./tasks";

// Agendamentos ligados a uma conversa do atendimento:
// - kind "mensagem": o texto é ENVIADO automaticamente ao cliente no horário.
// - kind "retorno": lembrete de retorno — vira só uma tarefa no quadro (nada é enviado).
// Cada agendamento cria uma tarefa espelho no quadro (taskId) com o mesmo prazo.
export const scheduledMessagesTable = pgTable("scheduled_messages", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversationsTable.id),
  kind: text("kind").notNull().default("mensagem"),       // mensagem | retorno
  content: text("content").notNull(),                      // texto a enviar / anotação do retorno
  sendAt: timestamp("send_at", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("pending"),     // pending | sent | done | failed | cancelled
  createdById: integer("created_by_id").references(() => usersTable.id),
  taskId: integer("task_id").references(() => tasksTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
