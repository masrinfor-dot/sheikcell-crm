import { pgTable, text, timestamp, integer, primaryKey } from "drizzle-orm/pg-core";

// Configurações do sistema (chave → valor) POR LOJA (tenant), ex.: alerta de
// atendimentos sem resposta. Editável só por admin/supervisor da loja.
export const appSettingsTable = pgTable(
  "app_settings",
  {
    tenantId: integer("tenant_id").notNull().default(1),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key] })],
);
