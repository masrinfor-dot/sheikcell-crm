import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const queueEntriesTable = pgTable("queue_entries", {
  id: serial("id").primaryKey(),
  clientName: text("client_name").notNull(),
  clientContact: text("client_contact"),
  sectorId: integer("sector_id").notNull(),
  channel: text("channel").notNull().default("manual"), // "whatsapp" | "instagram" | "manual"
  status: text("status").notNull().default("waiting"), // "waiting" | "in_progress" | "completed" | "transferred"
  attendantId: integer("attendant_id"),
  notes: text("notes"),
  position: integer("position").notNull().default(0),
  calledAt: timestamp("called_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertQueueEntrySchema = createInsertSchema(queueEntriesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  position: true,
  calledAt: true,
  startedAt: true,
  completedAt: true,
});
export type InsertQueueEntry = z.infer<typeof insertQueueEntrySchema>;
export type QueueEntry = typeof queueEntriesTable.$inferSelect;
