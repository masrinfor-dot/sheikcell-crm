import { pgTable, serial, text, integer, timestamp, jsonb, boolean, uniqueIndex } from "drizzle-orm/pg-core";

// Sorteios entre clientes do atendimento, configuráveis pelo admin.
export const rafflesTable = pgTable("raffles", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  prize: text("prize").notNull(),
  // Filtros de participação (null = todos)
  sectorIds: jsonb("sector_ids"),       // number[] | null
  vendedorIds: jsonb("vendedor_ids"),   // number[] | null (assigneeId da conversa)
  sessionKeys: jsonb("session_keys"),   // string[] | null (número de WhatsApp conectado)
  periodDays: integer("period_days"),   // só clientes com movimento nos últimos N dias
  // Tipo de cliente: "comprou" | "prospeccao" | motivo de finalização exato. null = todos
  clientTypes: jsonb("client_types"),   // string[] | null
  onlyResolved: boolean("only_resolved").notNull().default(false),
  // Só participa quem respondeu a pesquisa de satisfação (nota registrada)
  surveyRespondedOnly: boolean("survey_responded_only").notNull().default(false),
  excludePreviousWinners: boolean("exclude_previous_winners").notNull().default(true),
  winnersCount: integer("winners_count").notNull().default(1),
  // Mensagem automática: {nome}, {premio}, {loja}
  messageTemplate: text("message_template").notNull(),
  storeName: text("store_name"),
  recurrence: text("recurrence").notNull().default("once"), // once | weekly | monthly
  dayOfWeek: integer("day_of_week"),   // 0=domingo ... 6=sábado (weekly)
  dayOfMonth: integer("day_of_month"), // 1..28 (monthly)
  active: boolean("active").notNull().default(true),
  lastRunKey: text("last_run_key"),    // evita sortear duas vezes no mesmo período
  // Quem criou: vendedor comum só vê/gerencia os próprios sorteios
  createdById: integer("created_by_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const raffleDrawsTable = pgTable("raffle_draws", {
  id: serial("id").primaryKey(),
  raffleId: integer("raffle_id").notNull().references(() => rafflesTable.id, { onDelete: "cascade" }),
  periodKey: text("period_key").notNull(), // 'manual-<ts>' | 'YYYY-Wnn' | 'YYYY-MM' | 'once'
  eligibleCount: integer("eligible_count").notNull().default(0),
  // [{ phone, name, conversationId, sent: boolean, error?: string }]
  winners: jsonb("winners").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  // Garante no banco que um período recorrente não é sorteado duas vezes
  // (chaves manuais têm timestamp, então nunca colidem).
  uniqueIndex("raffle_draws_raffle_period_uq").on(t.raffleId, t.periodKey),
]);
