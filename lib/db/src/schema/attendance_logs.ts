import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const attendanceLogsTable = pgTable("attendance_logs", {
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
  notes: text("notes"),
  waitTimeSeconds: integer("wait_time_seconds"),
  serviceTimeSeconds: integer("service_time_seconds"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAttendanceLogSchema = createInsertSchema(attendanceLogsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertAttendanceLog = z.infer<typeof insertAttendanceLogSchema>;
export type AttendanceLog = typeof attendanceLogsTable.$inferSelect;
