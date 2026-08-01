import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const chatLabelsTable = pgTable("chat_labels", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  name: text("name").notNull(),                          // etiqueta name shown in the UI
  color: text("color").notNull().default("#1a2e6e"),     // hex color for the badge
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
