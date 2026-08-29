import { pgTable, serial, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { tenantsTable } from "./tenants";

// Auditoria global do Painel do Sistema (Fase 2): todo lance relevante que o
// superadmin faz em qualquer loja — entrar como, suspender/reativar,
// cancelar/reativar contrato, mudar módulos, criar/resetar admin, criar
// loja. Separada do impersonation_log (que já existia só pra "Entrar como")
// porque cobre qualquer ação, não só essa; tenantId fica nulo em ações sem
// loja específica (hoje nenhuma, mas deixa aberto).
export const superadminAuditLogTable = pgTable("superadmin_audit_log", {
  id: serial("id").primaryKey(),
  superadminUserId: integer("superadmin_user_id").notNull().references(() => usersTable.id),
  tenantId: integer("tenant_id").references(() => tenantsTable.id),
  action: text("action").notNull(), // ex.: "entrar_como", "atualizar_loja", "criar_admin"
  description: text("description").notNull(), // texto pronto pra mostrar na tela, já em pt-BR
  // Só preenchido quando a ação exige motivo (hoje: só "entrar_como").
  reason: text("reason"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
