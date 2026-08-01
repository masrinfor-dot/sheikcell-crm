import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";

// Financeiras parceiras: links acessados dentro do sistema (aba "Financeiras").
// Gerenciados por admin/supervisor; visíveis a toda a equipe.
export const partnerLinksTable = pgTable("partner_links", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
