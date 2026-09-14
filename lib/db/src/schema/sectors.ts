import { pgTable, serial, text, timestamp, boolean, integer, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import type { OptionalModule } from "./tenants";

export const sectorsTable = pgTable("sectors", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  icon: text("icon").notNull().default("smartphone"),
  color: text("color").notNull().default("#1a2e6e"),
  isActive: boolean("is_active").notNull().default(true),
  // Módulos opcionais que este setor pode ver — restrição a mais, por cima
  // da loja (enabledModules do tenant) e do usuário (moduleAccess). Pedido:
  // setores só de comunicação interna não precisam de Atendimento nem de
  // outras funções que não usam. null = SEM restrição (comportamento de
  // sempre, todo setor já existente continua assim); array (mesmo vazio,
  // de propósito) = lista explícita do que esse setor pode ver. Só afeta
  // "vendedor" — admin sempre vê tudo, supervisor não fica preso a um setor
  // só (ver lib/moduleAccess.ts no backend).
  enabledModules: jsonb("enabled_modules").$type<OptionalModule[] | null>(),
  // Pedido 14/09 (Atacado): todo vendedor DESTE setor pode ver/reabrir
  // QUALQUER atendimento Resolvido do setor (não só o que ele mesmo
  // finalizou) — pra reiniciar contato e prospectar cliente antigo. Default
  // false: nenhum setor muda de comportamento (vendedor comum continua sem
  // ver Resolvidos) até o admin ligar explicitamente neste setor.
  vendorsSeeResolved: boolean("vendors_see_resolved").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertSectorSchema = createInsertSchema(sectorsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSector = z.infer<typeof insertSectorSchema>;
export type Sector = typeof sectorsTable.$inferSelect;
