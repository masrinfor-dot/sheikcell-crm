import { pgTable, serial, text, boolean, timestamp, jsonb, integer } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Módulos opcionais que uma loja pode ou não ter contratado (teto por loja —
// além do controle de permissão já existente por usuário em
// users.adminAccess/permissions). Inclui tanto os módulos "de negócio"
// (avaliação, financeiras, RH etc.) quanto os que antes eram núcleo sempre
// ligado (chat, crm, equipe, financeiro, diretorio, tarefas, resultados,
// history) — hoje o superadmin monta o plano de cada loja escolhendo
// qualquer combinação. Só o que é infraestrutura de autoadministração da
// própria loja (usuários, setores, conexão do WhatsApp, aparência etc.)
// continua fora daqui, sempre ligado (sem isso o lojista ficaria sem saída).
export const OPTIONAL_MODULES = [
  "chat", "crm", "equipe", "financeiro", "diretorio", "tarefas", "resultados", "history",
  "avaliacao", "financeiras", "rh", "treinamentos", "questionarios", "sorteios", "documentos", "robo",
  "relatorios", "tvbox",
] as const;
export type OptionalModule = typeof OPTIONAL_MODULES[number];

// Lojas (tenants) do SaaS — cada lojista que comprou o sistema tem uma "loja"
// (tenant). Todo dado operacional (usuários, setores, conversas, CRM, WhatsApp
// etc.) carrega tenant_id e NUNCA cruza a fronteira entre lojas.
// O tenant 1 é a loja original (Sheikcell), usada como default no backfill.
export const tenantsTable = pgTable("tenants", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  // suspensa = ninguém da loja consegue logar/usar (fail closed)
  isActive: boolean("is_active").notNull().default(true),
  // Situação comercial do lojista no SaaS: ativo | cancelado.
  // "Inadimplente" é derivado (mensalidade pendente vencida), não gravado.
  saasStatus: text("saas_status").notNull().default("ativo"),
  // Dados de contato do lojista (dono da loja que aluga o sistema)
  contactName: text("contact_name"),
  contactPhone: text("contact_phone"),
  contactEmail: text("contact_email"),
  // CPF (11 dígitos) ou CNPJ (14 dígitos) do responsável — só dígitos,
  // validado no backend antes de gravar (ver lib/cpfCnpj.ts).
  cpfCnpj: text("cpf_cnpj"),
  // Módulos opcionais contratados (ver OPTIONAL_MODULES acima). Novas lojas
  // nascem com a lista do pacote escolhido no cadastro; lojas de antes
  // dessa coluna existir foram migradas com todos os módulos habilitados.
  enabledModules: jsonb("enabled_modules").$type<OptionalModule[]>().notNull().default([...OPTIONAL_MODULES]),
  // Admin excluiu a sala "Equipe (Geral)" do chat interno de propósito — sem
  // isso, ensureGeneralRoom() recriaria uma nova (vazia) no próximo GET
  // /internal-chat/conversations de qualquer membro da equipe.
  internalChatGeneralDisabled: boolean("internal_chat_general_disabled").notNull().default(false),
  // sessionKey (whatsapp_sessions) marcada como a linha oficial de ponto da
  // loja — mensagem com foto recebida nela é tratada como tentativa de
  // check-in (ver lib/whatsappInbound.ts). Null = feature desligada (opt-in,
  // nenhuma mensagem é interceptada até o admin escolher a linha).
  pontoCheckInSessionKey: text("ponto_check_in_session_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Tenant = typeof tenantsTable.$inferSelect;

// Histórico de "entrar como": qual superadmin virou qual admin de loja e quando.
export const impersonationLogTable = pgTable("impersonation_log", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  superadminUserId: integer("superadmin_user_id").notNull().references(() => usersTable.id),
  targetUserId: integer("target_user_id").notNull().references(() => usersTable.id),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});
