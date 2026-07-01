import { pgTable, serial, text, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { sectorsTable } from "./sectors";
import { usersTable } from "./users";

// Trello-style team task board for organizing atendimento work across the team.
export const tasksTable = pgTable("tasks", {
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
