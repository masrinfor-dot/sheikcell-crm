import { pgTable, serial, text, integer, timestamp, boolean, numeric, jsonb } from "drizzle-orm/pg-core";
import { sectorsTable } from "./sectors";
import { usersTable } from "./users";

export const crmContactsTable = pgTable("crm_contacts", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  contact: text("contact"),       // phone / WhatsApp number
  email: text("email"),
  phone: text("phone"),           // normalized phone for auto-register matching
  sectorId: integer("sector_id").references(() => sectorsTable.id),
  attendantId: integer("attendant_id").references(() => usersTable.id),
  status: text("status").notNull().default("potential"), // potential | pending | active
  profile: text("profile").notNull().default("Novo"),    // Novo | Regular | VIP | Inativo
  notes: text("notes"),
  tags: text("tags"),
  totalPurchases: numeric("total_purchases").notNull().default("0"),
  // Customizable per-contact field values, keyed by crm_custom_fields.id (as string).
  customFields: jsonb("custom_fields").$type<Record<string, string>>().notNull().default({}),
  isArchived: boolean("is_archived").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Global definitions of custom fields the user can create to personalize the
// data captured for every CRM contact (e.g. "CPF", "Aniversário", "Modelo do aparelho").
export const crmCustomFieldsTable = pgTable("crm_custom_fields", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),                          // label shown in the UI
  type: text("type").notNull().default("text"),          // text | number | date | select | textarea
  options: text("options"),                              // comma-separated choices (for type = select)
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const crmPurchasesTable = pgTable("crm_purchases", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").notNull().references(() => crmContactsTable.id),
  description: text("description").notNull(),
  amount: numeric("amount").notNull().default("0"),
  purchaseDate: timestamp("purchase_date", { withTimezone: true }).notNull().defaultNow(),
  category: text("category"),     // Celular | Acessório | Serviço | Outro
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const crmInternalNotesTable = pgTable("crm_internal_notes", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").notNull().references(() => crmContactsTable.id),
  content: text("content").notNull(),
  authorId: integer("author_id").references(() => usersTable.id),
  authorName: text("author_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
