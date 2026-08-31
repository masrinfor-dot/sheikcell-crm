import { pgTable, serial, text, integer, timestamp, jsonb, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Treinamentos criados por admin/supervisor: texto, vídeo, quiz ou checklist.
// Se obrigatório, trava o uso do sistema até o usuário concluir (ou, no caso
// de checklist, responder o período corrente).
export const trainingsTable = pgTable("trainings", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  type: text("type").notNull().default("text"), // text | video | quiz | checklist
  content: text("content"),                     // corpo do texto OU URL do vídeo (nulo p/ checklist)
  // quiz: [{ id, label, options: string[], correct: number (índice) }]
  quiz: jsonb("quiz"),
  // Campos exclusivos do tipo "checklist" — unificação com o antigo módulo
  // Questionários (ver migration 0071_trainings_checklist_merge.sql). Nulos
  // para os demais tipos (text/video/quiz).
  // questions: [{ id, label, type: "text"|"options"|"rating", options?: string[] }]
  questions: jsonb("questions"),
  recurrence: text("recurrence"),          // daily | weekly | once (só checklist)
  dayOfWeek: integer("day_of_week"),       // 0=domingo..6=sábado (recorrência semanal)
  startDate: text("start_date"),           // "YYYY-MM-DD" — a partir de quando vale
  targetRoles: jsonb("target_roles").notNull(), // ["vendedor","supervisor","admin"]
  mandatory: boolean("mandatory").notNull().default(true),
  active: boolean("active").notNull().default(true),
  // Prazo pra concluir (opcional) — só informativo (mostrado no card e na
  // trava), NÃO desliga a trava sozinho ao vencer (isso continua exigindo
  // conclusão ou o "destravar" manual do admin abaixo).
  dueDate: timestamp("due_date", { withTimezone: true }),
  // Preenchido só nas linhas migradas do antigo módulo Questionários — id da
  // linha original em "checklists" (agora "checklists_deprecated"). Só serve
  // de rastreabilidade/idempotência da migração 0071, nada em runtime lê isto.
  legacyChecklistId: integer("legacy_checklist_id"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Uma linha por TENTATIVA concluída (não mais uma por usuário): repetir um
// treinamento grava uma nova linha com attemptNumber incrementado, em vez de
// sobrescrever ou bloquear a conclusão anterior — nada do histórico é
// apagado. attemptNumber é calculado pelo backend (maior existente + 1) e a
// combinação (treinamento, usuário, tentativa) é única só pra evitar
// duplicata em corrida de requisições, não pra limitar a 1 conclusão.
export const trainingCompletionsTable = pgTable("training_completions", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  trainingId: integer("training_id").notNull().references(() => trainingsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  attemptNumber: integer("attempt_number").notNull().default(1),
  quizScore: integer("quiz_score"),   // % de acertos (só quiz)
  answers: jsonb("answers"),          // respostas do quiz (índices) OU do checklist ({ [questionId]: string })
  // Preenchido só para conclusões de treinamento tipo "checklist": chave do
  // período respondido ("2026-07-30" diário/único, "2026-W31" semanal) — a
  // mesma pessoa pode responder de novo em outro período. Índice único
  // parcial training_completions_period_unique (criado via SQL na migration
  // 0071) garante 1 resposta por período, coexistindo com o índice de
  // tentativa abaixo (que continua único por não ter WHERE). Nulo para
  // treinamentos normais (texto/vídeo/quiz), que só usam attemptNumber.
  periodKey: text("period_key"),
  // Preenchido só quando um admin/supervisor usa o botão "Destravar sistema"
  // pra liberar alguém sem ele ter concluído de verdade (ex.: treinamento
  // quebrado, urgência). Nulo = conclusão normal, feita pela própria pessoa.
  forcedByAdminId: integer("forced_by_admin_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("training_completions_attempt_unique").on(t.trainingId, t.userId, t.attemptNumber),
]);

// Rascunho de progresso EM ANDAMENTO (ainda não concluído) — permite "Continuar
// de onde parou": uma linha só por (treinamento, usuário), sobrescrita a cada
// resposta enquanto o treinamento não é enviado. Some quando a tentativa é
// concluída (não faz parte do histórico) ou quando o usuário escolhe
// "Recomeçar do início".
export const trainingProgressTable = pgTable("training_progress", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  trainingId: integer("training_id").notNull().references(() => trainingsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  answers: jsonb("answers"),          // respostas parciais do quiz (índices escolhidos até agora)
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("training_progress_unique").on(t.trainingId, t.userId),
]);
