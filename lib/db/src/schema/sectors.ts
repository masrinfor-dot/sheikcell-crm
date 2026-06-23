import { pgTable, serial, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const sectorsTable = pgTable("sectors", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  icon: text("icon").notNull().default("smartphone"),
  color: text("color").notNull().default("#1a2e6e"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertSectorSchema = createInsertSchema(sectorsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSector = z.infer<typeof insertSectorSchema>;
export type Sector = typeof sectorsTable.$inferSelect;
