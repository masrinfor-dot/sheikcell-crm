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
  // Pula a fila normal (pedido 18/09: "como recebemos muitos xerox impressão
  // criar palavra chave por transferir atendimento para loja adequada e
  // pular a fila") — quando true, uma conversa nova que bate nesta regra é
  // atribuída na hora a um vendedor ocioso do setor (sem precisar de clique
  // manual), em vez de só entrar no pool esperando alguém assumir. Default
  // false: regra nova continua só roteando por setor (comportamento de
  // sempre) até o admin ligar explicitamente esta opção. Ver
  // lib/skipQueueAssign.ts e stores.skipQueueEnabled (opt-in por loja).
  skipQueue: boolean("skip_queue").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type RoutingRule = typeof routingRulesTable.$inferSelect;
