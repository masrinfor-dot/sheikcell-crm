import { pgTable, serial, text, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { sectorsTable } from "./sectors";

export const whatsappSessionsTable = pgTable("whatsapp_sessions", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  sessionKey: text("session_key").notNull().unique(),
  displayName: text("display_name"),
  status: text("status").notNull().default("unknown"),
  phoneNumber: text("phone_number"),
  phoneId: text("phone_id"),
  errorMessage: text("error_message"),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  // Identidade visual da conexão na Central de Atendimento — cada número
  // (sessionKey) ganha uma cor própria pra etiqueta "via <número>", pra
  // reduzir erro de responder pelo número errado quando há mais de um.
  color: text("color").notNull().default("#10b981"),
  icon: text("icon"), // emoji opcional (ex.: "🏬"), mostrado junto da etiqueta
  // Fila do Central de Atendimento com auto-atribuição (pedido 14/09): opt-in
  // POR LINHA de WhatsApp — quando true, conversas novas/liberadas que
  // chegam por ESTE número podem ser atribuídas automaticamente (sem
  // clicar) ao vendedor ocioso da fila (chatQueueSingleTask, ver
  // schema/users.ts). Default false: nenhuma linha existente muda de
  // comportamento até o admin ligar explicitamente em Administração →
  // WhatsApp.
  queueAutoAssignEnabled: boolean("queue_auto_assign_enabled").notNull().default(false),
  // Pesquisa de satisfação desligada POR LINHA (pedido 14/09: público do
  // Atacado não gosta de receber a pesquisa ao finalizar) — quando true,
  // finalizar um atendimento NESTA linha nunca dispara a pesquisa
  // (survey_settings continua tenant-wide, isto só é uma exceção por cima).
  // Default false: nenhuma linha muda de comportamento até o admin ligar.
  surveyDisabled: boolean("survey_disabled").notNull().default(false),
  // Vincula este número/linha a um setor fixo (pedido 16/09: "vincular os
  // setores aos números de atendimento pra direcionar"). Quando setado, TODA
  // conversa NOVA que chega por esta linha vai direto pro setor escolhido,
  // sem passar pelas regras de palavra-chave (routing_rules/autoRouter) —
  // pensado pra loja que já dedica um número por departamento (ex.: número
  // do Suporte sempre cai em Suporte, não importa o texto da mensagem).
  // null (padrão) = comportamento de sempre, continua usando as regras de
  // palavra-chave e, na falta delas, o primeiro setor ativo da loja.
  defaultSectorId: integer("default_sector_id").references(() => sectorsTable.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WhatsappSession = typeof whatsappSessionsTable.$inferSelect;
