import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { sectorsTable } from "./sectors";

// Mensagens rápidas (respostas prontas) usadas no composer do chat.
// sectorId null = disponível para todos os setores.
export const quickRepliesTable = pgTable("quick_replies", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  title: text("title").notNull(),          // atalho/nome exibido na lista
  content: text("content").notNull(),      // texto inserido no campo de mensagem
  sectorId: integer("sector_id").references(() => sectorsTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
