import { pgTable, serial, text, integer, timestamp, boolean, jsonb, date, uniqueIndex, index } from "drizzle-orm/pg-core";
import { tasksTable } from "./tasks";

// ─── Gerente IA ──────────────────────────────────────────────────────────────
// Secretária executiva / gerente geral por WhatsApp (antes "Meu Acessor",
// protótipo à parte). Vive dentro do CRM e usa a(s) linha(s) de WhatsApp já
// conectadas: só mensagens vindas de um NÚMERO AUTORIZADO (o celular pessoal
// do dono da loja) entram aqui — nunca viram conversa de atendimento, nunca
// aparecem pra equipe. Tudo que o dono pede vira um registro com destino,
// responsável, prazo e acompanhamento.

// Configuração por loja (1 linha por tenant).
export const gerenteSettingsTable = pgTable("gerente_settings", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().unique(),
  enabled: boolean("enabled").notNull().default(true),
  assistantName: text("assistant_name").notNull().default("Gerente IA"),
  // Telefones (normalizados, só dígitos com DDI — ver lib/phone.ts) cujas
  // mensagens são tratadas pelo Gerente IA. Lista vazia = ninguém é atendido.
  authorizedPhones: jsonb("authorized_phones").$type<string[]>().notNull().default([]),
  // Horário de descanso: lembretes não urgentes não são enviados nessa faixa
  // (ficam pra primeira hora útil). "HH:MM" no fuso de São Paulo.
  quietStart: text("quiet_start").notNull().default("22:00"),
  quietEnd: text("quiet_end").notNull().default("07:00"),
  // Resumo "Meu dia" enviado automaticamente nesse horário (null = desligado).
  dailyDigestTime: text("daily_digest_time").default("07:30"),
  dailyDigestSentOn: date("daily_digest_sent_on"),
  // Última linha/telefone por onde o dono falou — é por aí que os lembretes
  // proativos saem (sem isso, não há como escolher uma linha).
  lastSessionKey: text("last_session_key"),
  lastPhone: text("last_phone"),
  // Linha ADM: o que o dono manda nela (boleto, conta, "paguei") vai para a
  // fila de aprovação do ERP (Financeiro › Aprovações do agente).
  admSessionKey: text("adm_session_key"),
  // Endereço do CRM pra montar links (gravado quando o admin abre o painel).
  publicBaseUrl: text("public_base_url"),
  // Fechamento do dia (o que foi feito / o que ficou) e relatório semanal.
  eveningSummaryTime: text("evening_summary_time").default("19:00"),
  eveningSentOn: date("evening_sent_on"),
  weeklyReportSentOn: date("weekly_report_sent_on"),
  // Chave do agente do ERP (agk_...), cifrada com o mesmo cofre do ERP.
  erpAgentKeyCiphertext: text("erp_agent_key_ciphertext"),
  erpAgentKeyIv: text("erp_agent_key_iv"),
  erpAgentKeyAuthTag: text("erp_agent_key_auth_tag"),
  erpAgentKeyVersion: integer("erp_agent_key_version"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Histórico da conversa do dono com o Gerente IA (entrada e saída), com a
// interpretação feita — serve de memória curta pra IA e de auditoria
// ("o que eu pedi ontem?"). Nunca vai pra tabela messages do atendimento.
export const gerenteMessagesTable = pgTable("gerente_messages", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  phone: text("phone").notNull(),
  sessionKey: text("session_key"),
  direction: text("direction").notNull(), // in | out
  source: text("source").notNull().default("whatsapp"), // whatsapp | painel | sistema
  content: text("content").notNull(),
  // Nome da(s) ação(ões) executada(s) (ex.: "criar_lembrete") e argumentos —
  // só nas mensagens de entrada.
  intent: text("intent"),
  payload: jsonb("payload"),
  // ID da mensagem no WhatsApp — dedupe em reentrega (reconexão do Baileys).
  externalId: text("external_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("gerente_messages_tenant_created_idx").on(t.tenantId, t.createdAt),
  uniqueIndex("gerente_messages_external_id_uq").on(t.externalId),
]);

// Agenda: compromissos pessoais e da empresa.
export const gerenteEventsTable = pgTable("gerente_events", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  title: text("title").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  location: text("location"),
  participants: text("participants"),
  scope: text("scope").notNull().default("empresa"), // pessoal | empresa
  storeName: text("store_name"),
  notes: text("notes"),
  status: text("status").notNull().default("agendado"), // agendado | concluido | cancelado
  remindMinutesBefore: integer("remind_minutes_before").notNull().default(30),
  remindedAt: timestamp("reminded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("gerente_events_tenant_starts_idx").on(t.tenantId, t.startsAt)]);

// Lembretes: avisados pelo WhatsApp no horário; respondem a "feito" e "adia".
export const gerenteRemindersTable = pgTable("gerente_reminders", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  title: text("title").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  urgent: boolean("urgent").notNull().default(false),
  status: text("status").notNull().default("pendente"), // pendente | concluido | cancelado
  sentAt: timestamp("sent_at", { withTimezone: true }),
  snoozeCount: integer("snooze_count").notNull().default(0),
  // Lembrete nascido de uma tarefa do quadro (opcional).
  taskId: integer("task_id").references(() => tasksTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("gerente_reminders_tenant_due_idx").on(t.tenantId, t.dueAt)]);

// Gastos e receitas (lançamentos avulsos ditados pelo dono).
export const gerenteEntriesTable = pgTable("gerente_entries", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  kind: text("kind").notNull(), // gasto | receita
  amountCents: integer("amount_cents").notNull(),
  description: text("description").notNull(),
  category: text("category"),
  scope: text("scope").notNull().default("empresa"), // pessoal | empresa
  storeName: text("store_name"),
  paymentMethod: text("payment_method"),
  installments: integer("installments").notNull().default(1),
  reimbursementPending: boolean("reimbursement_pending").notNull().default(false),
  entryDate: date("entry_date").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("gerente_entries_tenant_date_idx").on(t.tenantId, t.entryDate)]);

// Contas a pagar e a receber — baixa só com confirmação explícita do dono.
export const gerenteBillsTable = pgTable("gerente_bills", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  kind: text("kind").notNull(), // pagar | receber
  description: text("description").notNull(),
  amountCents: integer("amount_cents").notNull(),
  dueDate: date("due_date").notNull(),
  counterparty: text("counterparty"),
  responsible: text("responsible"),
  scope: text("scope").notNull().default("empresa"), // pessoal | empresa
  storeName: text("store_name"),
  status: text("status").notNull().default("aberta"), // aberta | paga | cancelada
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("gerente_bills_tenant_due_idx").on(t.tenantId, t.dueDate)]);

// Ação aguardando confirmação ("sim"/"não") do dono — ex.: baixar uma conta.
// Uma por telefone; expira sozinha.
export const gerentePendingActionsTable = pgTable("gerente_pending_actions", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  phone: text("phone").notNull(),
  action: jsonb("action").$type<Record<string, unknown>>().notNull(),
  summary: text("summary").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("gerente_pending_actions_tenant_phone_uq").on(t.tenantId, t.phone)]);

export type GerenteSettings = typeof gerenteSettingsTable.$inferSelect;
export type GerenteMessage = typeof gerenteMessagesTable.$inferSelect;
export type GerenteEvent = typeof gerenteEventsTable.$inferSelect;
export type GerenteReminder = typeof gerenteRemindersTable.$inferSelect;
export type GerenteEntry = typeof gerenteEntriesTable.$inferSelect;
export type GerenteBill = typeof gerenteBillsTable.$inferSelect;

// Tarefa delegada pelo Gerente IA e enviada pelo WhatsApp ao vendedor
// (telefone do cadastro do RH). O vendedor responde "feito" + foto: a foto
// vira prova, a tarefa fecha no quadro e o dono é avisado.
export const gerenteTaskDispatchesTable = pgTable("gerente_task_dispatches", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  taskId: integer("task_id").notNull().references(() => tasksTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull(),
  assigneeName: text("assignee_name").notNull(),
  phone: text("phone"),
  sessionKey: text("session_key"),
  // enviada | aguardando_prova | concluida | sem_telefone | falhou
  status: text("status").notNull().default("enviada"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  awaitingProofAt: timestamp("awaiting_proof_at", { withTimezone: true }),
  doneAt: timestamp("done_at", { withTimezone: true }),
  proofUrl: text("proof_url"),
  proofNote: text("proof_note"),
  overdueNotifiedAt: timestamp("overdue_notified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("gerente_task_dispatches_tenant_phone_idx").on(t.tenantId, t.phone),
  index("gerente_task_dispatches_task_idx").on(t.taskId),
]);
export type GerenteTaskDispatch = typeof gerenteTaskDispatchesTable.$inferSelect;

// WhatsApp de cada pessoa da equipe para receber tarefas do Gerente IA
// (o cadastro do RH foi para o ERP — o número fica aqui).
export const gerenteTeamPhonesTable = pgTable("gerente_team_phones", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  userId: integer("user_id").notNull(),
  phone: text("phone").notNull(),
  lastTestAt: timestamp("last_test_at", { withTimezone: true }),
  lastTestOk: boolean("last_test_ok"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("gerente_team_phones_tenant_user_uq").on(t.tenantId, t.userId)]);

// Pedido mandado à fila de aprovação do ERP (agent actions). O ERP é a fonte
// da verdade; aqui só o espelho pra mostrar no painel e avisar no WhatsApp
// quando for aprovado/recusado.
export const gerenteErpActionsTable = pgTable("gerente_erp_actions", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  erpActionId: text("erp_action_id"),
  type: text("type").notNull(), // CREATE_PAYABLE | CREATE_RECEIVABLE | SETTLE_PAYABLE | SETTLE_RECEIVABLE
  summary: text("summary").notNull(),
  status: text("status").notNull().default("PENDENTE"), // PENDENTE | APROVADA | RECUSADA | ERRO | FALHA_ENVIO
  message: text("message"),
  payload: jsonb("payload"),
  sourceMessageId: integer("source_message_id"),
  notifiedStatus: text("notified_status"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("gerente_erp_actions_tenant_idx").on(t.tenantId, t.createdAt)]);
export type GerenteErpAction = typeof gerenteErpActionsTable.$inferSelect;

// Link seguro (sem login) pra abrir no celular: o dia, uma tarefa. Guarda só
// o hash do token; expira sozinho; só leitura.
export const gerenteLinksTable = pgTable("gerente_links", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  scope: text("scope").notNull(), // dia | task
  refId: integer("ref_id"),
  // Link do dono pode comentar/mudar situação/avisar a equipe; o que vai pro
  // vendedor é só leitura.
  canEdit: boolean("can_edit").notNull().default(false),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("gerente_links_token_uq").on(t.tokenHash)]);

// Rotina recorrente: "todo dia 10 pagar aluguel", "toda segunda tarefa pro Alan…".
export const gerenteRecurrencesTable = pgTable("gerente_recurrences", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  kind: text("kind").notNull(), // lembrete | tarefa | conta
  title: text("title").notNull(),
  // { freq: "daily"|"weekly"|"monthly", weekday?: 0-6, monthday?: 1-31, hh, mm }
  rule: jsonb("rule").$type<{ freq: "daily" | "weekly" | "monthly"; weekday?: number; monthday?: number; hh: number; mm: number }>().notNull(),
  assigneeName: text("assignee_name"),
  amountCents: integer("amount_cents"),
  billKind: text("bill_kind"),
  active: boolean("active").notNull().default(true),
  nextAt: timestamp("next_at", { withTimezone: true }).notNull(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("gerente_recurrences_next_idx").on(t.active, t.nextAt)]);
export type GerenteRecurrence = typeof gerenteRecurrencesTable.$inferSelect;
