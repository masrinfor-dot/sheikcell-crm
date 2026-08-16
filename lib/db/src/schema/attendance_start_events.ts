import { pgTable, serial, integer, timestamp } from "drizzle-orm/pg-core";

// "Iniciados por dia" confiável: um registro por transição REAL de "sem
// responsável" -> "com responsável" numa conversa (nunca em toda
// reatribuição/transferência entre atendentes já ativos). Append-only,
// nunca editado nem apagado depois — ao contrário de
// conversations.attendanceStartedAt (mutável, zerada em unassign/
// transferência/reabertura), este registro sobrevive a qualquer coisa que
// aconteça depois com a conversa.
//
// Sem FK — mesmo motivo de attendance_logs: precisa sobreviver à exclusão
// da conversa/usuário/loja de origem. Só existe a partir do deploy desta
// feature; não há como reconstruir "iniciados" de antes disso, o dado já
// era descartado pelo campo mutável.
export const attendanceStartEventsTable = pgTable("attendance_start_events", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1),
  conversationId: integer("conversation_id").notNull(),
  attendantId: integer("attendant_id").notNull(),
  sectorId: integer("sector_id"),
  storeId: integer("store_id"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AttendanceStartEvent = typeof attendanceStartEventsTable.$inferSelect;
