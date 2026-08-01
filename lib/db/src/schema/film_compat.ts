import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";

// Compatibilidade de películas: cada linha diz qual película serve em quais
// aparelhos. Consulta liberada para toda a equipe; edição só pelo admin.
export const filmCompatTable = pgTable("film_compat", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  film: text("film").notNull(),          // ex.: "Película 3D Samsung A54"
  models: text("models").notNull(),      // aparelhos compatíveis (texto livre, separados por vírgula)
  notes: text("notes"),                  // observações (ex.: "não serve com capinha grossa")
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
