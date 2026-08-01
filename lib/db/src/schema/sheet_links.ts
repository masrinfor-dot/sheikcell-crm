import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";

// Links de planilhas online e formulários (Google Sheets/Forms etc.)
// abertos dentro do sistema. Gerenciados pelo admin.
export const sheetLinksTable = pgTable("sheet_links", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  position: integer("position").notNull().default(0),
  // Acesso personalizado: NULL nas duas = toda a equipe vê.
  // Senão, vendedor vê se o setor dele OU o id dele estiver nas listas.
  allowedSectorIds: integer("allowed_sector_ids").array(),
  allowedUserIds: integer("allowed_user_ids").array(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
