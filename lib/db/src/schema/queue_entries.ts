import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const queueEntriesTable = pgTable("queue_entries", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  clientName: text("client_name").notNull(),
  clientContact: text("client_contact"),
  sectorId: integer("sector_id").notNull(),
  channel: text("channel").notNull().default("manual"), // "whatsapp" | "instagram" | "manual"
  status: text("status").notNull().default("waiting"), // "waiting" | "in_progress" | "completed" | "transferred"
  attendantId: integer("attendant_id"),
  // Direcionamento manual (pedido 10/09): quando um vendedor_chefe/
  // supervisor/admin direciona esta entrada pra um vendedor específico,
  // fica registrado aqui — o vendedor alvo passa a poder chamá-la mesmo
  // fora do próprio setor, e (se tiver queueRestrictToAssigned) só vê
  // entradas com este campo apontando pra ele. routedBy guarda quem
  // direcionou, só para auditoria/exibição ("direcionado por X").
  targetUserId: integer("target_user_id"),
  routedBy: integer("routed_by"),
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
