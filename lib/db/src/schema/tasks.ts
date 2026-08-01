import { pgTable, serial, text, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { sectorsTable } from "./sectors";
import { usersTable } from "./users";

// Trello-style team task board for organizing atendimento work across the team.
export const tasksTable = pgTable("tasks", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("todo"),   // todo | doing | done
  priority: text("priority").notNull().default("media"), // baixa | media | alta
  assigneeId: integer("assignee_id").references(() => usersTable.id),
  createdById: integer("created_by_id").references(() => usersTable.id),
  sectorId: integer("sector_id").references(() => sectorsTable.id),
  dueDate: timestamp("due_date", { withTimezone: true }),
  position: integer("position").notNull().default(0),
  isArchived: boolean("is_archived").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Chat da tarefa: comentários para esclarecer dúvidas e complementar informações.
export const taskCommentsTable = pgTable("task_comments", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  taskId: integer("task_id").notNull().references(() => tasksTable.id, { onDelete: "cascade" }),
  authorId: integer("author_id").references(() => usersTable.id, { onDelete: "set null" }),
  content: text("content").notNull(),
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
