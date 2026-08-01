import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";

// Links de planilhas online e formulários (Google Sheets/Forms etc.)
// abertos dentro do sistema. Gerenciados pelo admin.
export const sheetLinksTable = pgTable("sheet_links", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
