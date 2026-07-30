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
  // Loja da rede a que o vendedor pertence (texto livre; ex.: "Loja Centro")
  storeName: text("store_name"),
  // Obriga trocar a senha no próximo login (primeiro acesso ou senha resetada pelo admin)
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  // Funções de admin liberadas para não-admins (ex.: ["financeiro","sorteios"])
  adminAccess: jsonb("admin_access").$type<string[] | null>(),
  // Horário de acesso (só vendedor): fora dele o login/uso é bloqueado.
  // null = sem restrição. days: 0=domingo ... 6=sábado
  accessHours: jsonb("access_hours").$type<{ start: string; end: string; days: number[] } | null>(),
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
