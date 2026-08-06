import { pgTable, serial, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Trilha de auditoria do módulo financeiro bancário — quem cadastrou/editou/
// excluiu conta, gravou credencial, ou confirmou/rejeitou uma conciliação.
// Nunca editável pelos usuários operacionais (só inserção, nenhuma rota de
// update/delete sobre esta tabela).
export const financeAuditLogTable = pgTable(
  "finance_audit_log",
  {
    tenantId: integer("tenant_id").notNull().default(1),
    id: serial("id").primaryKey(),
    userId: integer("user_id").references(() => usersTable.id),
    action: text("action").notNull(), // account.create | account.update | account.delete | credential.save | match.confirm | match.reject
    entityType: text("entity_type").notNull(), // bank_account | bank_integration_credential | reconciliation_match
    entityId: integer("entity_id").notNull(),
    metadata: jsonb("metadata"),
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("finance_audit_log_tenant_idx").on(t.tenantId, t.createdAt.desc())],
);

export type FinanceAuditLog = typeof financeAuditLogTable.$inferSelect;
