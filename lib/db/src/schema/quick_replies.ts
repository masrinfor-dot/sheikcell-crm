import { pgTable, serial, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { sectorsTable } from "./sectors";

// Mensagens rápidas (respostas prontas) usadas no composer do chat.
// sectorId/storeIds/userIds null (ou array vazio) = sem restrição naquela
// dimensão. Quando mais de uma dimensão está preenchida, todas precisam bater
// (E lógico) — ex.: setor "Vendas" + loja "Matriz" só aparece pra quem é dos
// dois; pra restringir só a pessoas específicas, deixe setor/loja em branco.
export const quickRepliesTable = pgTable("quick_replies", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  title: text("title").notNull(),          // atalho/nome exibido na lista
  content: text("content").notNull(),      // texto inserido no campo de mensagem
  sectorId: integer("sector_id").references(() => sectorsTable.id),
  // stores.id (loja física dentro do tenant) — array pra permitir mais de uma.
  storeIds: jsonb("store_ids").$type<number[] | null>(),
  // users.id — restringe a mensagem a pessoas específicas, além de admin/supervisor.
  userIds: jsonb("user_ids").$type<number[] | null>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
