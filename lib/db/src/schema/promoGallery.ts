import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Banco de Promoções — galeria de fotos/materiais prontos (fotos de aparelho,
// arte de promoção, etc.) pra reenvio rápido no Atendimento (WhatsApp), sem
// precisar pedir a foto de novo toda hora. Só admin/supervisor cadastra/apaga
// (ver requireAdminOrSupervisor em routes/promoGallery.ts, decisão explícita
// do lojista); qualquer vendedor com o módulo "promocoes" liberado pode ver
// a galeria e enviar um item (ou todos) pra conversa aberta.
export const promoItemsTable = pgTable("promo_items", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  // Arquivo em disco (PROMO_MEDIA_DIR), aqui só o metadado — mesmo padrão de
  // catalogProductPhotosTable em schema/catalog.ts.
  storedName: text("stored_name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type PromoItem = typeof promoItemsTable.$inferSelect;
