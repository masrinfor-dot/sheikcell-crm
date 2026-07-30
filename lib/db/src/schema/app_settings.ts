import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Configurações globais do sistema (chave → valor), ex.: alerta de
// atendimentos sem resposta. Editável só por admin/supervisor.
export const appSettingsTable = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
