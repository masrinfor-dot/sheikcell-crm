import { pgTable, serial, text, timestamp, integer, boolean, jsonb, date, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { storesTable } from "./stores";

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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex("employees_user_id_unique").on(t.userId).where(sql`${t.userId} is not null`),
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
  source: text("source").notNull().default("self"), // "self" | "admin" (lançamento manual)
  createdByUserId: integer("created_by_user_id"),
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

export type Employee = typeof employeesTable.$inferSelect;
export type WorkShift = typeof workShiftsTable.$inferSelect;
export type TimeClockEntry = typeof timeClockEntriesTable.$inferSelect;
export type TimeBankAdjustment = typeof timeBankAdjustmentsTable.$inferSelect;
export type LeaveRecord = typeof leaveRecordsTable.$inferSelect;
export type TimeBankClosure = typeof timeBankClosuresTable.$inferSelect;
