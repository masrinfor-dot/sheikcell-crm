import { pgTable, serial, text, timestamp, integer, boolean, jsonb, date, index, uniqueIndex } from "drizzle-orm/pg-core";
import { storesTable } from "./stores";
import { sectorsTable } from "./sectors";
import { usersTable } from "./users";

export type RoutineQuestionSnapshot = {
  id: number; label: string; type: string; required: boolean; requiresEvidence: boolean; evidenceType: string | null;
  requiresJustificationOnNo: boolean; requiresJustificationOnYes: boolean; alertLevel: string | null;
};

// Fase 3.5: resposta "Não" em pergunta marcada requiresJustificationOnNo
// carrega motivo (lista fixa) + pendência + quem precisa ser comunicado, em
// vez de só o valor simples — ver sanitização em rotinas.ts.
export type RoutineNoJustification = {
  value: string; motivo: string; pendencia: string | null; comunicarA: string | null;
};

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
  // "08:00" — null quando recurrence="continuous" (sem horário fixo, devido
  // o expediente inteiro).
  scheduledTime: text("scheduled_time"),
  // Rotinas com mais de um horário por dia (ex.: conferência de caixa 3x/dia)
  // — null/vazio pro caso normal de horário único (scheduledTime sozinho já
  // resolve, comportamento 100% igual a antes). Quando preenchido com 2+
  // horários, scheduledTime continua guardando o PRIMEIRO deles (telas que
  // só leem scheduledTime, ex. ordenação/listagem, seguem funcionando), e
  // cada horário desta lista vira uma ocorrência própria — ver
  // checklistOccurrences() em lib/routinesShared.ts.
  scheduledTimes: jsonb("scheduled_times").$type<string[]>(),
  // "daily" | "weekdays" (seg-sex) | "specific_days" | "weekly" | "monthly" | "specific_date" | "continuous"
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
  // Fase 3.5: resposta negativa ("Não" / "Não executado") passa a exigir
  // motivo (lista fixa) + pendência + quem comunicar, ver rotinas.ts.
  requiresJustificationOnNo: boolean("requires_justification_on_no").notNull().default(false),
  // Padrão invertido (perguntas do tipo "Encontrou alguma irregularidade?"):
  // a pendência dispara na resposta POSITIVA, não na negativa. Mesmo fluxo
  // de justificativa de requiresJustificationOnNo, só que no gatilho oposto
  // — nunca os dois juntos na mesma pergunta (validado em sanitizeQuestions).
  requiresJustificationOnYes: boolean("requires_justification_on_yes").notNull().default(false),
  // "critico" | "atencao" | null — mapeamento pro motor de alerta da Fase 7,
  // só o desenho por enquanto (sem entrega de notificação ainda).
  alertLevel: text("alert_level"),
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

// Resposta de checklist — uma linha por execução, nunca sobrescrita (histórico
// por construção, item 50). questionsSnapshot guarda as perguntas exatamente
// como estavam ao responder, então editar o checklist depois (bump de
// version em routineChecklistsTable) nunca muda o sentido de uma resposta
// antiga (item 61). reauthAt registra quando a senha foi confirmada — a
// senha em si nunca é armazenada, só o carimbo de quando foi validada.
export const routineResponsesTable = pgTable("routine_responses", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  checklistId: integer("checklist_id").notNull().references(() => routineChecklistsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  periodKey: text("period_key").notNull(), // "YYYY-MM-DD" — uma resposta por dia por usuário/checklist
  // Rotinas com mais de um horário por dia: "" (default, mesmo valor de toda
  // resposta histórica) pra checklist de ocorrência única no dia, ou o
  // horário ("HH:MM") da ocorrência específica respondida quando o checklist
  // tem múltiplos horários configurados — ver checklistOccurrences() em
  // lib/routinesShared.ts. Junto com periodKey, é o que diferencia as
  // várias respostas do mesmo checklist/usuário/dia (ver índice único abaixo).
  occurrenceTime: text("occurrence_time").notNull().default(""),
  // { [questionId]: valor simples, ou objeto de justificativa quando a
  // pergunta exige motivo pra resposta negativa (Fase 3.5) }
  answers: jsonb("answers").$type<Record<string, string | RoutineNoJustification>>().notNull(),
  questionsSnapshot: jsonb("questions_snapshot").$type<RoutineQuestionSnapshot[]>().notNull(),
  reauthAt: timestamp("reauth_at", { withTimezone: true }).notNull(),
  deviceInfo: text("device_info"), // User-Agent de quem respondeu
  // Fase 5: horário da resposta comparado ao Ponto do mesmo funcionário no
  // mesmo dia — "antes_entrada" | "depois_entrada" | "sem_ponto_no_dia" |
  // null (checklist contínuo, ou funcionário sem registro de Ponto vinculado).
  // Puro dado pro relatório mensal — não trava nem penaliza ninguém.
  respondedRelativeToPonto: text("responded_relative_to_ponto"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Fase 6: revisão do supervisor/gestor sobre a pendência marcada nesta
  // resposta (ver hasPendency em routineClosures.ts) — "approved" (pendência
  // já resolvida/reconhecida) ou "contested" (gestor discorda que seja uma
  // pendência de verdade). null enquanto ninguém revisou ainda. Puro
  // controle de gestão — nunca muda o dado bruto da resposta em si.
  pendencyReviewStatus: text("pendency_review_status"),
  pendencyReviewedByUserId: integer("pendency_reviewed_by_user_id"),
  pendencyReviewNote: text("pendency_review_note"),
  pendencyReviewedAt: timestamp("pendency_reviewed_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("routine_responses_unique").on(t.checklistId, t.userId, t.periodKey, t.occurrenceTime),
  index("routine_responses_user_idx").on(t.userId),
]);

// Fase 4: evidência (foto/documento) anexada a uma pergunta de uma resposta —
// arquivo em disco (mesmo padrão de documents.ts: UUID + magic-bytes),
// metadado aqui. Uma linha por pergunta com evidência numa resposta (uma
// resposta pode ter várias, uma por pergunta que exige). Histórico imutável
// por construção (nunca sobrescreve, só a resposta original é apagada em
// cascade se o checklist for excluído).
export const routineResponseEvidenceTable = pgTable("routine_response_evidence", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  responseId: integer("response_id").notNull().references(() => routineResponsesTable.id, { onDelete: "cascade" }),
  questionId: integer("question_id").notNull().references(() => routineChecklistQuestionsTable.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  storedName: text("stored_name").notNull(), // nome em disco (UUID.ext), nunca o nome original
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("routine_response_evidence_response_idx").on(t.responseId),
]);

// Fase 5: fechamento mensal de Rotinas por funcionário — snapshot CONGELADO,
// gerado uma vez e nunca recalculado, mesmo padrão de timeBankClosuresTable
// (rh_dp.ts): índice único (tenantId, employeeId, periodMonth) +
// onConflictDoNothing na geração, idempotente.
export const routineClosuresTable = pgTable("routine_closures", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull(),
  employeeName: text("employee_name").notNull(),
  periodMonth: text("period_month").notNull(), // "YYYY-MM"
  totalDue: integer("total_due").notNull(),
  totalAnswered: integer("total_answered").notNull(),
  totalOnTime: integer("total_on_time").notNull(),
  // Resposta negativa (Fase 3.5) em que o funcionário marcou que existe uma
  // pendência (campo "pendencia" preenchido) — não "Não sem motivo", que não
  // existe: motivo é sempre obrigatório quando a pergunta exige.
  totalWithPendency: integer("total_with_pendency").notNull(),
  totalUrgentBypass: integer("total_urgent_bypass").notNull(),
  // Cruzamento com o Ponto (item 2) — só dado cru, sem trava/penalidade.
  pontoBeforeEntry: integer("ponto_before_entry").notNull(),
  pontoAfterEntry: integer("ponto_after_entry").notNull(),
  pontoNoRecord: integer("ponto_no_record").notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
  // Fase 6: só entra "de verdade" no ranking depois que o supervisor revisar
  // todas as pendências/urgências do funcionário nesse mês e aprovar (ver
  // POST /rotinas/closures/:id/approve). Até lá, o score já pode ser
  // visualizado mas fica marcado como provisório na tela de ranking.
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedByUserId: integer("approved_by_user_id"),
}, (t) => [
  uniqueIndex("routine_closures_unique").on(t.tenantId, t.employeeId, t.periodMonth),
]);

// "Atendimento urgente" (Fase 3): libera temporariamente a trava sem marcar
// o checklist como respondido — só um registro de auditoria de que o bypass
// foi usado. A liberação em si é um carimbo em memória (ver rotinas.ts),
// não depende desta tabela pra funcionar; ela existe só pra não perder o
// rastro de quando/por quem foi usada.
export const routineUrgentBypassesTable = pgTable("routine_urgent_bypasses", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  checklistId: integer("checklist_id").notNull().references(() => routineChecklistsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Fase 6: mesmo espírito do pendencyReviewStatus acima — supervisor pode
  // aprovar (bypass justificado) ou contestar (mal registrado) antes do
  // fechamento do mês ser aprovado.
  reviewStatus: text("review_status"),
  reviewedByUserId: integer("reviewed_by_user_id"),
  reviewNote: text("review_note"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
}, (t) => [
  index("routine_urgent_bypasses_user_idx").on(t.userId),
]);

// Fase 6: pesos do score de produtividade — configurável pelo admin, sem
// deploy (mesmo espírito de routine_checklist_scopes: tabela flat que o
// admin edita). Uma linha por tenant (upsert). Ver fórmula documentada em
// computeRoutineScore (lib/routineScore.ts).
export const routineScoreWeightsTable = pgTable("routine_score_weights", {
  tenantId: integer("tenant_id").primaryKey(),
  weightOnTime: integer("weight_on_time").notNull().default(50),
  weightNoPendency: integer("weight_no_pendency").notNull().default(30),
  weightNoUrgentAbuse: integer("weight_no_urgent_abuse").notNull().default(20),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// Fase 7: alerta automático pro gestor — checklist obrigatório sem resposta
// dentro do prazo, ou resposta negativa numa pergunta alertLevel="critico".
// Gerado por job periódico (routineAlerts.ts), não em tempo real (ver
// generateRoutineAlerts). dedupeKey garante que o mesmo evento não gera
// alerta duplicado a cada execução do job (onConflictDoNothing na geração,
// mesmo espírito idempotente do fechamento mensal).
export const routineAlertsTable = pgTable("routine_alerts", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  recipientUserId: integer("recipient_user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }), // gestor/supervisor que recebe
  employeeUserId: integer("employee_user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }), // de quem é o alerta
  employeeName: text("employee_name").notNull(),
  checklistId: integer("checklist_id").references(() => routineChecklistsTable.id, { onDelete: "cascade" }),
  checklistName: text("checklist_name").notNull(),
  kind: text("kind").notNull(), // "atraso" | "critico"
  message: text("message").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  read: boolean("read").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("routine_alerts_dedupe_unique").on(t.dedupeKey),
  index("routine_alerts_recipient_idx").on(t.recipientUserId),
]);

export type RoutineChecklist = typeof routineChecklistsTable.$inferSelect;
export type RoutineChecklistQuestion = typeof routineChecklistQuestionsTable.$inferSelect;
export type RoutineChecklistScope = typeof routineChecklistScopesTable.$inferSelect;
export type RoutineResponse = typeof routineResponsesTable.$inferSelect;
export type RoutineUrgentBypass = typeof routineUrgentBypassesTable.$inferSelect;
export type RoutineResponseEvidence = typeof routineResponseEvidenceTable.$inferSelect;
export type RoutineClosure = typeof routineClosuresTable.$inferSelect;
export type RoutineScoreWeights = typeof routineScoreWeightsTable.$inferSelect;
export type RoutineAlert = typeof routineAlertsTable.$inferSelect;
