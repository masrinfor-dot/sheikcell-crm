import { pgTable, serial, text, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Filtro salvo da lista de Conversas (pedido 10/09: "criar opção de separar
// mensagem de forma pré configurada, ex quantidade de atendimentos,
// pessoas") — o painel de filtro avançado (ícone funil em Conversas) já
// tinha vendedor/setor/nível CRM/linha de WhatsApp/etiqueta/"não
// respondidas"; isso salva uma combinação com um nome, pra aplicar com 1
// clique depois em vez de escolher tudo de novo toda vez. Pessoal por
// usuário (cada um guarda os próprios atalhos) — não compartilhado com o
// resto da equipe.
export const chatSavedFiltersTable = pgTable("chat_saved_filters", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // { onlyUnanswered?: boolean; vendedor?: number; setor?: number; nivel?: string; sessionKey?: string; label?: string }
  filters: jsonb("filters").notNull().$type<Record<string, unknown>>(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ChatSavedFilter = typeof chatSavedFiltersTable.$inferSelect;
