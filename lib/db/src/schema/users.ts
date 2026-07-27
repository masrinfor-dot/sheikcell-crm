import { pgTable, serial, integer, text, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sectorsTable } from "./sectors";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("vendedor"), // "vendedor" | "supervisor" | "admin"
  sectorId: integer("sector_id").references(() => sectorsTable.id),
  isActive: boolean("is_active").notNull().default(true),
  // Permissões individuais do vendedor (null = todas liberadas). Chaves:
  // ver_potenciais, transferir, finalizar, criar_atendimento, usar_ia,
  // crm, tarefas, enviar_midia — todas boolean. Admin/supervisor ignoram isto.
  permissions: jsonb("permissions").$type<Record<string, boolean> | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
