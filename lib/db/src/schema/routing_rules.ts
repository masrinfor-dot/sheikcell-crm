import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { sectorsTable } from "./sectors";

export const routingRulesTable = pgTable("routing_rules", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  sectorId: integer("sector_id").notNull().references(() => sectorsTable.id),
  name: text("name").notNull(),
  keywords: text("keywords").notNull(),
  priority: integer("priority").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type RoutingRule = typeof routingRulesTable.$inferSelect;
