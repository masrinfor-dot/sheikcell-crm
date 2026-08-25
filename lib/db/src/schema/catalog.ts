import { pgTable, serial, text, integer, timestamp, numeric, jsonb, boolean } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Vitrine de Aparelhos — catálogo de produtos (módulo opcional "vitrine").
// Cada aparelho tem custo, margem e preço de venda: o preço de venda é
// calculado a partir do custo + margem de lucro bruto + taxa de cartão da
// forma de pagamento de referência + custo de nota fiscal (ver
// lib/catalogPricing.ts), mas fica sempre gravado aqui e pode ser sobrescrito
// manualmente depois — o cálculo é só o ponto de partida.
export const CATALOG_CONDITIONS = ["lacrado", "seminovo", "cpo", "usado"] as const;
export type CatalogCondition = (typeof CATALOG_CONDITIONS)[number];

export const catalogProductsTable = pgTable("catalog_products", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  model: text("model").notNull(), // ex.: "iPhone 15 Pro Max"
  storage: text("storage"), // ex.: "256GB" (texto livre — varia por fornecedor)
  condition: text("condition").notNull().default("seminovo"), // ver CATALOG_CONDITIONS
  colors: jsonb("colors").$type<string[]>().notNull().default([]),
  description: text("description"),
  // Formação de preço (ver lib/catalogPricing.ts). costPrice normalmente vem
  // da lista do fornecedor (importação por IA) ou é digitado na mão.
  costPrice: numeric("cost_price"),
  costIncludesInvoice: boolean("cost_includes_invoice").notNull().default(false),
  marginPercentOverride: numeric("margin_percent_override"), // null = usa a margem padrão da loja
  salePrice: numeric("sale_price"),
  stockQty: integer("stock_qty").notNull().default(1),
  status: text("status").notNull().default("active"), // active | inactive | sold
  sortOrder: integer("sort_order").notNull().default(0),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type CatalogProduct = typeof catalogProductsTable.$inferSelect;

// Fotos do aparelho — o arquivo em si fica no disco (CATALOG_MEDIA_DIR),
// aqui só os metadados (mesmo padrão de documentsTable em schema/documents.ts).
export const catalogProductPhotosTable = pgTable("catalog_product_photos", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => catalogProductsTable.id, { onDelete: "cascade" }),
  storedName: text("stored_name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type CatalogProductPhoto = typeof catalogProductPhotosTable.$inferSelect;
