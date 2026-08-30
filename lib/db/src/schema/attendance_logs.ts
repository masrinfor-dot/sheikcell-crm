import { pgTable, serial, text, timestamp, integer, boolean, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const attendanceLogsTable = pgTable("attendance_logs", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  queueEntryId: integer("queue_entry_id").notNull(),
  clientName: text("client_name").notNull(),
  clientContact: text("client_contact"),
  sectorId: integer("sector_id").notNull(),
  sectorName: text("sector_name").notNull(),
  attendantId: integer("attendant_id"),
  attendantName: text("attendant_name"),
  channel: text("channel").notNull().default("manual"),
  outcome: text("outcome"), // "completed" | "transferred" | "abandoned"
  resolutionReason: text("resolution_reason"), // motivo escolhido ao finalizar o atendimento
  // Resultado comercial informado ao finalizar: teve venda? de quanto?
  hadSale: boolean("had_sale"),
  saleAmount: numeric("sale_amount"),
  // Pesquisa de satisfação: nota 1–5 dada pelo cliente após finalizar (WhatsApp)
  satisfactionRating: integer("satisfaction_rating"),
  // Escala em uso quando a nota acima foi respondida (5 ou 10 — configurável
  // por loja) e a mesma nota já convertida pra 0-100%, pra poder comparar/
  // agregar lojas com escalas diferentes sem viés. Registros antigos (antes
  // desta coluna existir) ficam com os dois nulos — a escala usada não dá
  // pra reconstruir depois (conversations.survey_scale_max é limpo ao
  // consumir a pesquisa).
  satisfactionScaleMax: integer("satisfaction_scale_max"),
  satisfactionPercent: integer("satisfaction_percent"),
  notes: text("notes"),
  waitTimeSeconds: integer("wait_time_seconds"),
  serviceTimeSeconds: integer("service_time_seconds"),
  // Tempo até a primeira mensagem outbound do atendente após o início do
  // atendimento — mede agilidade inicial, diferente de serviceTimeSeconds
  // (duração total do caso). Nulo se não houve nenhuma resposta registrada
  // (ex.: atendimento finalizado sem o atendente ter escrito nada).
  firstResponseSeconds: integer("first_response_seconds"),
  // Loja de quem atendeu — snapshot no momento da finalização (ver
  // conversations.storeId). Sem FK: esta tabela é um fato histórico
  // congelado que precisa sobreviver à exclusão da loja/usuário/setor de
  // origem, mesmo padrão já usado por sectorId/attendantId nesta tabela.
  storeId: integer("store_id"),
  // Liga ao atendimento (chat) que originou este log — sem FK (mesmo motivo
  // do storeId acima: fato histórico que sobrevive à exclusão da conversa).
  // Nulo pra atendimentos antigos (antes desta coluna existir) e pra
  // atendimentos via fila legada (queue_entries), que não têm conversa de
  // chat associada. Usado pra "Reabrir pelo Histórico" e pro filtro por
  // etiqueta (join em conversations.labels).
  conversationId: integer("conversation_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAttendanceLogSchema = createInsertSchema(attendanceLogsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertAttendanceLog = z.infer<typeof insertAttendanceLogSchema>;
export type AttendanceLog = typeof attendanceLogsTable.$inferSelect;
