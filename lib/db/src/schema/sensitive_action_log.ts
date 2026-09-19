import { pgTable, serial, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";

// Auditoria de ações sensíveis da Central de Atendimento (item 21 do roadmap
// "Central de Atendimento" — transferência, edição, exclusão e outras ações
// sensíveis). "Entrar como"/"modo espiar" JÁ tem seu próprio log dedicado
// (impersonationLogTable, ver admin.ts) — não duplicado aqui, só linkado na
// tela. Diferente de superadminAuditLogTable (Painel do Sistema, ações do
// superadmin entre lojas): esta tabela é por LOJA (tenant_id), ações do
// dia a dia de admin/supervisor/vendedor_chefe/vendedor dentro da própria
// loja — transferir atendimento/setor, editar/excluir mensagem, excluir
// atendimento.
export const sensitiveActionLogTable = pgTable("sensitive_action_log", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  // Sem FK/cascade: precisa sobreviver à exclusão do usuário que fez a ação
  // (fato histórico) — mesmo padrão de attendanceLogsTable.attendantId.
  userId: integer("user_id"),
  userName: text("user_name").notNull(), // snapshot do nome no momento da ação
  // "transferir_atendimento" | "transferir_setor" | "editar_mensagem" |
  // "excluir_mensagem" | "excluir_atendimento"
  action: text("action").notNull(),
  description: text("description").notNull(), // texto pronto pra tela, já em pt-BR
  conversationId: integer("conversation_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
