import { pgTable, serial, text, integer, timestamp, boolean, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sectorsTable } from "./sectors";
import { usersTable } from "./users";
import { crmContactsTable } from "./crm_contacts";

// Agenda unificada da equipe: era um quadro Kanban (Trello-style) simples;
// agora cada tarefa pode também ser um COMPROMISSO com horário marcado
// (dueDate já era timestamp com hora — só não era exposto no front antes),
// vinculado a um cliente do CRM, com duração e alerta prévio. Tarefa sem
// horário continua funcionando como item de backlog comum (nada quebra).
export const tasksTable = pgTable("tasks", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("todo"),   // todo | doing | done
  priority: text("priority").notNull().default("media"), // baixa | media | alta
  createdById: integer("created_by_id").references(() => usersTable.id),
  sectorId: integer("sector_id").references(() => sectorsTable.id),
  dueDate: timestamp("due_date", { withTimezone: true }),
  // Cliente do CRM vinculado ao compromisso (opcional — nem toda tarefa é um
  // atendimento com cliente).
  contactId: integer("contact_id").references(() => crmContactsTable.id),
  // Duração do compromisso em minutos (opcional — só faz sentido quando
  // dueDate tem horário marcado).
  durationMinutes: integer("duration_minutes"),
  // Quantos minutos antes do dueDate avisar os responsáveis. Nulo = sem
  // alerta automático pra essa tarefa.
  alertMinutesBefore: integer("alert_minutes_before"),
  position: integer("position").notNull().default(0),
  isArchived: boolean("is_archived").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Responsáveis pela tarefa (0..N por tarefa — antes era um único assignee_id).
export const taskAssigneesTable = pgTable("task_assignees", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  taskId: integer("task_id").notNull().references(() => tasksTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Chat da tarefa: comentários para esclarecer dúvidas e complementar informações.
export const taskCommentsTable = pgTable("task_comments", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  taskId: integer("task_id").notNull().references(() => tasksTable.id, { onDelete: "cascade" }),
  authorId: integer("author_id").references(() => usersTable.id, { onDelete: "set null" }),
  content: text("content").notNull(),
  // Anexo opcional (foto/documento) — arquivo salvo em MEDIA_DIR, mesmo
  // esquema de URL usado pelos anexos de conversas (GET /chat/media/:filename).
  mediaUrl: text("media_url"),
  mediaType: text("media_type"), // image | doc
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Aviso de comentário novo para quem está envolvido na tarefa (responsável e
// criador, exceto quem comentou). Consumido por um badge simples no quadro —
// não é push em tempo real (isso é uma frente maior, à parte).
export const taskNotificationsTable = pgTable("task_notifications", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  taskId: integer("task_id").notNull().references(() => tasksTable.id, { onDelete: "cascade" }),
  commentId: integer("comment_id").notNull().references(() => taskCommentsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  isRead: boolean("is_read").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Subtarefas (checklist estilo Kerika/Trello) dentro de uma tarefa.
export const taskSubtasksTable = pgTable("task_subtasks", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  taskId: integer("task_id").notNull().references(() => tasksTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  isDone: boolean("is_done").notNull().default(false),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Lembretes de compromisso da Agenda (tarefa com dueDate + alertMinutesBefore),
// gerados por job periódico (taskReminders.ts) — mesmo padrão do
// routine_alerts (rotinas.ts): dedupeKey evita repetir o mesmo aviso.
export const taskRemindersTable = pgTable("task_reminders", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  taskId: integer("task_id").notNull().references(() => tasksTable.id, { onDelete: "cascade" }),
  recipientUserId: integer("recipient_user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  dueDate: timestamp("due_date", { withTimezone: true }).notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  read: boolean("read").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("task_reminders_dedupe_unique").on(t.dedupeKey),
  index("task_reminders_recipient_idx").on(t.recipientUserId),
]);
