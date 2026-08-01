import { pgTable, serial, text, integer, timestamp, jsonb, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Questionários/checklists criados pelo admin: avaliação da loja, checklist
// diário por função etc. Aparecem automaticamente na data/recorrência
// configurada; se obrigatório, trava o uso do sistema até responder.
export const checklistsTable = pgTable("checklists", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  // [{ id: "q1", label: "...", type: "text" | "options" | "rating", options?: string[] }]
  questions: jsonb("questions").notNull(),
  // funções que devem responder: ["vendedor","supervisor","admin"]
  targetRoles: jsonb("target_roles").notNull(),
  recurrence: text("recurrence").notNull().default("weekly"), // daily | weekly | once
  dayOfWeek: integer("day_of_week"),      // 0=domingo..6=sábado (recorrência semanal)
  startDate: text("start_date"),          // "YYYY-MM-DD" — a partir de quando vale
  mandatory: boolean("mandatory").notNull().default(true),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const checklistResponsesTable = pgTable("checklist_responses", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  checklistId: integer("checklist_id").notNull().references(() => checklistsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  periodKey: text("period_key").notNull(), // "2026-07-30" (diário/único) ou "2026-W31" (semanal)
  answers: jsonb("answers").notNull(),     // { [questionId]: string }
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("checklist_responses_unique").on(t.checklistId, t.userId, t.periodKey),
]);
