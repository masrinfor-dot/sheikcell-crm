import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";

// Reuniões online da equipe: sala de vídeo (Jitsi) + gravação de áudio +
// transcrição por IA que vira documentos (ata/resumo/tarefas) no arquivo.
export const meetingsTable = pgTable("meetings", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1),
  title: text("title").notNull(),
  roomCode: text("room_code").notNull(),
  status: text("status").notNull().default("aberta"), // aberta | gravada | transcrita
  recordingName: text("recording_name"),
  recordingBytes: integer("recording_bytes"),
  transcript: text("transcript"),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});
