import { pgTable, serial, text, boolean, timestamp, integer } from "drizzle-orm/pg-core";

// Lojas da rede — cadastradas pelo admin e usadas como opção de seleção
// no cadastro de vendedores (users.storeName) e clientes (crm_contacts.serviceStore).
// O nome é copiado para esses campos de texto existentes, mantendo compatível
// todo o código que já usa storeName/serviceStore.
export const storesTable = pgTable("stores", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
