import { pgTable, serial, text, timestamp, integer, boolean, jsonb, date, index } from "drizzle-orm/pg-core";
import { storesTable } from "./stores";
import { sectorsTable } from "./sectors";
import { usersTable } from "./users";

// Rotinas e Produtividade: checklists operacionais agendados (abertura,
// fechamento, conferência de caixa etc.) que travam o uso do sistema até
// responder, com reautenticação por senha (fases seguintes). Vizinho de
// checklists.ts (Questionários), mas módulo separado de propósito —
// Questionários é pesquisa geral de equipe (targeting só por role de
// login), Rotinas é operacional, preso à hierarquia loja/setor/função/
// usuário e integrado ao Ponto (rh_dp.ts).
export const routineChecklistsTable = pgTable("routine_checklists", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  message: text("message"), // texto exibido ao usuário quando o alerta aparece
  scheduledTime: text("scheduled_time").notNull(), // "08:00"
  // "daily" | "weekdays" (seg-sex) | "specific_days" | "weekly" | "monthly" | "specific_date"
  recurrence: text("recurrence").notNull().default("daily"),
  // dias da semana (0=domingo..6=sábado) pra specific_days/weekly, OU dia do
  // mês (1-31) pra monthly — formato depende de `recurrence`.
  recurrenceDays: jsonb("recurrence_days").$type<number[]>(),
  specificDate: date("specific_date"), // usado só quando recurrence="specific_date"
  toleranceMinutes: integer("tolerance_minutes").notNull().default(0), // 0 = responder imediatamente
  mandatory: boolean("mandatory").notNull().default(true), // trava o sistema — só entra em vigor na Fase 3
  active: boolean("active").notNull().default(true),
  // Bumped quando as perguntas mudam de um jeito que afeta o sentido das
  // respostas antigas — cada resposta grava seu próprio snapshot das
  // perguntas (routineResponsesTable, Fase 2), então isso aqui é só
  // metadado informativo pro admin, não a garantia de imutabilidade em si.
  version: integer("version").notNull().default(1),
  createdByUserId: integer("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const routineChecklistQuestionsTable = pgTable("routine_checklist_questions", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  checklistId: integer("checklist_id").notNull().references(() => routineChecklistsTable.id, { onDelete: "cascade" }),
  orderIndex: integer("order_index").notNull().default(0),
  label: text("label").notNull(),
  // "yes_no" | "done_not_done" | "text" | "number" | "value" | "photo" | "document" | "observation"
  type: text("type").notNull().default("yes_no"),
  required: boolean("required").notNull().default(true),
  requiresEvidence: boolean("requires_evidence").notNull().default(false),
  evidenceType: text("evidence_type"), // "photo" | "document" | null
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("routine_checklist_questions_checklist_idx").on(t.checklistId),
]);

// Regra de escopo: combina (AND) as dimensões preenchidas — pelo menos uma
// precisa estar preenchida (validado na rota). Várias linhas por checklist
// permitem várias combinações (ex.: Loja A+Setor Vendas E Loja B+Setor
// Vendas). "Mais específico vence" é resolvido em código (contagem de
// campos preenchidos), não em schema — ver comentário no topo do arquivo.
export const routineChecklistScopesTable = pgTable("routine_checklist_scopes", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  checklistId: integer("checklist_id").notNull().references(() => routineChecklistsTable.id, { onDelete: "cascade" }),
  storeId: integer("store_id").references(() => storesTable.id),
  sectorId: integer("sector_id").references(() => sectorsTable.id),
  jobFunction: text("job_function"), // texto livre, mesmo valor de employees.job_function
  userId: integer("user_id").references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("routine_checklist_scopes_checklist_idx").on(t.checklistId),
]);

export type RoutineChecklist = typeof routineChecklistsTable.$inferSelect;
export type RoutineChecklistQuestion = typeof routineChecklistQuestionsTable.$inferSelect;
export type RoutineChecklistScope = typeof routineChecklistScopesTable.$inferSelect;
