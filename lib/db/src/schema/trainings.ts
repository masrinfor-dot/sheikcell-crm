import { pgTable, serial, text, integer, timestamp, jsonb, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Treinamentos criados por admin/supervisor: texto, vídeo ou quiz.
// Se obrigatório, trava o uso do sistema até o usuário concluir.
export const trainingsTable = pgTable("trainings", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  type: text("type").notNull().default("text"), // text | video | quiz
  content: text("content"),                     // corpo do texto OU URL do vídeo
  // quiz: [{ id, label, options: string[], correct: number (índice) }]
  quiz: jsonb("quiz"),
  targetRoles: jsonb("target_roles").notNull(), // ["vendedor","supervisor","admin"]
  mandatory: boolean("mandatory").notNull().default(true),
  active: boolean("active").notNull().default(true),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const trainingCompletionsTable = pgTable("training_completions", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  trainingId: integer("training_id").notNull().references(() => trainingsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  quizScore: integer("quiz_score"),   // % de acertos (só quiz)
  answers: jsonb("answers"),          // respostas do quiz (índices escolhidos)
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("training_completions_unique").on(t.trainingId, t.userId),
]);
