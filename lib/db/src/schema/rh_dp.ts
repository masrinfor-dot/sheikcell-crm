import { pgTable, serial, text, timestamp, integer, boolean, jsonb, date, uniqueIndex, doublePrecision } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { storesTable } from "./stores";
import { rhCandidatesTable } from "./rh";

// Departamento Pessoal (DP) operacional: colaboradores, escalas, ponto,
// banco de horas e afastamentos. Vizinho de rh.ts (recrutamento), mas
// tabelas separadas — conceitos diferentes que só compartilham a mesma
// aba "RH" na UI e o mesmo módulo/permissão (moduleAccess.rh).

// Colaborador é uma entidade própria, separada de `users`: nem todo
// colaborador de RH precisa logar no sistema (ex.: sócio que não atende),
// e nem todo `user` é necessariamente um colaborador formal de RH (ex.:
// conta de teste). userId é opcional — bater ponto e ver o próprio banco
// de horas só é possível para quem tem um userId vinculado.
export const employeesTable = pgTable("employees", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id),
  name: text("name").notNull(),
  birthDate: date("birth_date"),
  phone: text("phone"),
  email: text("email"),
  cpf: text("cpf"),
  rg: text("rg"),
  role: text("role"), // cargo (ex.: "Vendedor")
  jobFunction: text("job_function"), // função (texto livre, pode repetir o cargo)
  admissionDate: date("admission_date"),
  contractType: text("contract_type"), // "clt" | "pj" | "estagio"
  salaryCents: integer("salary_cents"),
  storeId: integer("store_id").references(() => storesTable.id),
  shiftId: integer("shift_id").references(() => workShiftsTable.id),
  isActive: boolean("is_active").notNull().default(true),
  // Contratação (pedido do lojista, 09/09): candidateId guarda de qual
  // candidatura do recrutamento (rh_candidates) essa contratação saiu — null
  // pra cadastro direto, sem processo seletivo (como já era possível antes).
  // hiringStatus fica 'em_contratacao' enquanto documentos/contrato ainda
  // estão sendo reunidos no fluxo de "Iniciar contratação"; vira 'ativo' ao
  // finalizar. Default 'ativo' pra não mudar nada em colaborador já
  // existente (cadastro direto de sempre continua exatamente igual).
  candidateId: integer("candidate_id").references(() => rhCandidatesTable.id),
  hiringStatus: text("hiring_status").notNull().default("ativo"),
  // Link público de upload de documentos (pedido 10/09): token secreto
  // (32 hex, mesmo padrão do link de candidatura em rh.ts) que o RH gera e
  // manda pro candidato/colaborador — ele mesmo sobe RG/CPF/CTPS etc. sem
  // precisar de login. Null = nenhum link gerado (ou já revogado). Ver
  // GET/POST /rh-dp/public/:token em employeeHiring.ts.
  documentsUploadToken: text("documents_upload_token"),
  // Ficha cadastral (pedido 10/09, modelo de admissão da contabilidade) —
  // endereço completo, estado civil, escolaridade e duração do contrato de
  // experiência. Todos opcionais/texto livre, sem validação de formato
  // (mesmo espírito de cpf/rg acima).
  address: text("address"), // rua/logradouro
  addressNumber: text("address_number"),
  neighborhood: text("neighborhood"), // bairro
  city: text("city"),
  state: text("state"), // UF
  zipCode: text("zip_code"), // CEP
  maritalStatus: text("marital_status"), // estado civil
  educationLevel: text("education_level"), // grau de escolaridade
  experienceDays: integer("experience_days"), // dias do contrato de experiência
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex("employees_user_id_unique").on(t.userId).where(sql`${t.userId} is not null`),
  uniqueIndex("employees_documents_upload_token_unique").on(t.documentsUploadToken).where(sql`${t.documentsUploadToken} is not null`),
]);

export const workShiftsTable = pgTable("work_shifts", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  name: text("name").notNull(), // "Comercial 08-18"
  // "fixed" (horário definido, entra no cálculo de esperado/banco de horas e
  // exige bater ponto pra liberar o login) | "flexible" (escala livre — sem
  // horário fixo, banco de horas só soma o trabalhado, nunca exige ponto).
  type: text("type").notNull().default("fixed"),
  startTime: text("start_time"), // "08:00" — obrigatório só quando type="fixed"
  endTime: text("end_time"), // "18:00"
  breakStart: text("break_start"), // "12:00" — nulo = sem intervalo na escala
  breakEnd: text("break_end"), // "14:00"
  weekdays: jsonb("weekdays").$type<number[]>().notNull().default([1, 2, 3, 4, 5]), // 0=domingo
  // Minutos esperados de trabalho por dia — calculado ao salvar (duração
  // menos intervalo) e cacheado aqui pra não recalcular a cada consulta.
  // Nulo quando type="flexible" (não há expediente esperado a cobrar).
  expectedMinutesPerDay: integer("expected_minutes_per_day"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Fato histórico: sem FK em employeeId — sobrevive à exclusão do
// colaborador, mesmo padrão de attendance_logs.sectorId/attendantId.
export const timeClockEntriesTable = pgTable("time_clock_entries", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull(),
  kind: text("kind").notNull(), // "in" | "break_start" | "break_end" | "out"
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(), // sempre now() do servidor
  source: text("source").notNull().default("self"), // "self" | "admin" | "whatsapp" (check-in por foto)
  createdByUserId: integer("created_by_user_id"),
  // Comprovante (foto) do check-in — pelo WhatsApp (tryConsumePontoCheckIn em
  // lib/whatsappInbound.ts) ou pela selfie tirada no navegador na batida de
  // entrada obrigatória (PontoGate.tsx / POST /rh-dp/me/punch).
  proofUrl: text("proof_url"),
  // Geolocalização capturada no navegador na hora da batida (obrigatória só
  // pra batida de entrada via self-service — ver requirePhotoAndGeo em
  // rhDp.ts). Nula pras batidas antigas (antes desse recurso), pelo WhatsApp
  // (não captura geo) e pelas feitas manualmente pelo admin.
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  accuracyMeters: doublePrecision("accuracy_meters"),
  // Duas fotos em pouco tempo do mesmo colaborador: registra as duas, mas
  // marca ambas pra revisão manual em vez de decidir sozinho qual vale
  // (ver tryConsumePontoCheckIn em lib/whatsappInbound.ts).
  flagged: boolean("flagged").notNull().default(false),
  flagReason: text("flag_reason"),
});

export const timeBankAdjustmentsTable = pgTable("time_bank_adjustments", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull(),
  minutes: integer("minutes").notNull(), // + credita, - debita
  reason: text("reason").notNull(),
  createdByUserId: integer("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const leaveRecordsTable = pgTable("leave_records", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull(),
  kind: text("kind").notNull(), // "ferias" | "atestado" | "falta_justificada" | "falta_injustificada" | "outro"
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  notes: text("notes"),
  createdByUserId: integer("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Pedido de férias (pedido 10/09, análise Tangerino): o colaborador solicita
// pelo próprio self-service (MeuPonto), o RH/admin aprova ou rejeita. Ao
// aprovar, gera automaticamente um leave_records (kind="ferias") — igual ao
// que já era lançado manualmente — pra não duplicar a lógica de "afastamento
// vigente" em nenhum outro lugar do sistema (relatórios, fechamento etc. já
// leem leave_records normalmente). leaveRecordId fica null enquanto
// pendente/rejeitado, e aponta pro leave_records criado quando aprovado.
export const vacationRequestsTable = pgTable("vacation_requests", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => employeesTable.id, { onDelete: "cascade" }),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  daysCount: integer("days_count").notNull(),
  status: text("status").notNull().default("pendente"), // "pendente" | "aprovado" | "rejeitado"
  requestedByUserId: integer("requested_by_user_id").notNull(),
  reviewedByUserId: integer("reviewed_by_user_id"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewNote: text("review_note"),
  leaveRecordId: integer("leave_record_id").references(() => leaveRecordsTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Controle de idempotência do lembrete de ponto por WhatsApp (pedido 10/09,
// análise Tangerino): um lembrete por colaborador, por dia, por tipo
// ("entrada" atrasada | "saida" esquecida) — índice único garante que o job
// periódico (lib/pontoReminders.ts) nunca manda dois lembretes iguais no
// mesmo dia, mesmo que o tick rode de novo antes do próximo.
export const pontoRemindersTable = pgTable("ponto_reminders", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull(),
  dateKey: text("date_key").notNull(), // "YYYY-MM-DD", fuso America/Sao_Paulo
  kind: text("kind").notNull(), // "entrada" | "saida"
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("ponto_reminders_unique").on(t.employeeId, t.dateKey, t.kind),
]);

// Fechamento mensal do banco de horas — fato CONGELADO no momento do
// fechamento (não recalcula depois, mesmo que ajustes/batidas antigos sejam
// editados). employeeId sem FK e employeeName snapshotado: mesmo padrão de
// attendance_logs, sobrevive à exclusão/renomeação do colaborador. Correção
// de um fechamento errado é manual: apagar a linha e rodar o fechamento de
// novo (POST /rh-dp/closures/run), não há "reprocessar" automático.
export const timeBankClosuresTable = pgTable("time_bank_closures", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull(),
  employeeName: text("employee_name").notNull(),
  periodMonth: text("period_month").notNull(), // "YYYY-MM"
  workedMinutes: integer("worked_minutes").notNull(),
  expectedMinutes: integer("expected_minutes").notNull(),
  adjustmentMinutes: integer("adjustment_minutes").notNull(),
  balanceMinutes: integer("balance_minutes").notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("time_bank_closures_unique").on(t.tenantId, t.employeeId, t.periodMonth),
]);

// Banco de arquivos do colaborador (contratação): 1 linha por documento —
// RG, CPF, foto 3x4, carteira de trabalho, comprovante de residência,
// título de eleitor, PIS/NIT, certidão, exame admissional, contrato de
// trabalho gerado, ou qualquer outro arquivo. O arquivo em si fica no disco
// (mesma pasta DOCS_DIR já usada por documents.ts, numa subpasta — usa o
// MESMO volume persistente já montado em produção, sem exigir nenhuma
// configuração nova no EasyPanel); aqui só os metadados (storedName é o
// nome no disco). textContent guarda o texto do contrato quando a linha é
// o contrato gerado/editado (sem arquivo em disco nesse caso — mimeType e
// storedName ficam null).
// Assinatura eletrônica do espelho de ponto (pedido 10/09, análise
// Tangerino) — "assinatura simples" (clique de confirmação), conforme
// decidido: o colaborador só pode assinar um mês DEPOIS que ele foi
// fechado (time_bank_closures já existe pra esse período — números
// oficiais/congelados), e os totais são copiados pra esta linha no momento
// da assinatura (mesmo espírito "congelado" do fechamento: se o fechamento
// for excluído/refeito depois, a assinatura antiga não muda de baixo pra
// cima). Um só por colaborador/mês (não dá pra assinar de novo).
export const timesheetSignaturesTable = pgTable("timesheet_signatures", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull(),
  periodMonth: text("period_month").notNull(), // "YYYY-MM"
  closureId: integer("closure_id").notNull().references(() => timeBankClosuresTable.id),
  workedMinutes: integer("worked_minutes").notNull(),
  expectedMinutes: integer("expected_minutes").notNull(),
  adjustmentMinutes: integer("adjustment_minutes").notNull(),
  balanceMinutes: integer("balance_minutes").notNull(),
  signedByUserId: integer("signed_by_user_id").notNull(),
  signedAt: timestamp("signed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("timesheet_signatures_unique").on(t.employeeId, t.periodMonth),
]);

export const employeeDocumentsTable = pgTable("employee_documents", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => employeesTable.id, { onDelete: "cascade" }),
  // Chave do tipo de documento (ex.: "foto_3x4", "rg", "ctps", "contrato_trabalho",
  // "outro") — lista sugerida vive no frontend, aqui é texto livre pra não
  // travar em nenhuma lista fixa.
  docType: text("doc_type").notNull(),
  label: text("label"), // rótulo livre, principalmente pra docType "outro"
  fileName: text("file_name"),
  mimeType: text("mime_type"),
  storedName: text("stored_name"), // nome do arquivo no disco (null quando é só texto, ex.: contrato)
  sizeBytes: integer("size_bytes"),
  textContent: text("text_content"), // texto do contrato gerado/editado (docType "contrato_trabalho")
  uploadedByUserId: integer("uploaded_by_user_id"),
  // Vencimento (GED, pedido 10/09, análise Tangerino): opcional — só faz
  // sentido pra documentos com validade (ASO/exame periódico, certificações,
  // vistos/carteiras de trabalho de estrangeiro etc.). Nulo = sem vencimento
  // (a maioria dos documentos de admissão, RG/CPF/CTPS, não expira).
  // GET /rh-dp/documents-expiring lista, sem cron, todo documento com
  // vencimento próximo ou já vencido.
  expiresAt: date("expires_at"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Modelos de contrato de trabalho, personalizáveis pelo admin — texto com
// placeholders ({{nome}}, {{cpf}}, {{rg}}, {{cargo}}, {{funcao}}, {{salario}},
// {{admissao}}, {{escala}}, {{loja}}, {{tipo_contrato}}) substituídos na
// hora de gerar o contrato de um colaborador específico (ver placeholders
// em routes/employeeHiring.ts). Vários modelos por tenant — ex.: um pra
// CLT, outro pra PJ/estágio.
export const employeeContractTemplatesTable = pgTable("employee_contract_templates", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  contractType: text("contract_type"), // "clt" | "pj" | "estagio" | null = qualquer
  bodyText: text("body_text").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  // "contrato" (padrão) | "regimento" — pedido 10/09: o Regimento interno
  // usa o mesmo mecanismo de modelo+placeholder+geração do Contrato de
  // trabalho, só separado na listagem/cadastro do admin por este campo.
  kind: text("kind").notNull().default("contrato"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type Employee = typeof employeesTable.$inferSelect;
export type WorkShift = typeof workShiftsTable.$inferSelect;
export type TimeClockEntry = typeof timeClockEntriesTable.$inferSelect;
export type TimeBankAdjustment = typeof timeBankAdjustmentsTable.$inferSelect;
export type LeaveRecord = typeof leaveRecordsTable.$inferSelect;
export type VacationRequest = typeof vacationRequestsTable.$inferSelect;
export type PontoReminder = typeof pontoRemindersTable.$inferSelect;
export type TimeBankClosure = typeof timeBankClosuresTable.$inferSelect;
export type TimesheetSignature = typeof timesheetSignaturesTable.$inferSelect;
export type EmployeeDocument = typeof employeeDocumentsTable.$inferSelect;
export type EmployeeContractTemplate = typeof employeeContractTemplatesTable.$inferSelect;
