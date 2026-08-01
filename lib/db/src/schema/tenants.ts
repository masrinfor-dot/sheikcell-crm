import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";

// Lojas (tenants) do SaaS — cada lojista que comprou o sistema tem uma "loja"
// (tenant). Todo dado operacional (usuários, setores, conversas, CRM, WhatsApp
// etc.) carrega tenant_id e NUNCA cruza a fronteira entre lojas.
// O tenant 1 é a loja original (Sheikcell), usada como default no backfill.
export const tenantsTable = pgTable("tenants", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  // suspensa = ninguém da loja consegue logar/usar (fail closed)
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Tenant = typeof tenantsTable.$inferSelect;
