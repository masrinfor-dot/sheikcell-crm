import { pgTable, serial, text, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { sectorsTable } from "./sectors";
import { usersTable } from "./users";

export const crmContactsTable = pgTable("crm_contacts", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  contact: text("contact"),
  sectorId: integer("sector_id").references(() => sectorsTable.id),
  attendantId: integer("attendant_id").references(() => usersTable.id),
  status: text("status").notNull().default("potential"), // potential | pending | active
  notes: text("notes"),
  tags: text("tags"),
  isArchived: boolean("is_archived").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
