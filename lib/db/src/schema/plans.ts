import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

// Modelos de plano (Fase 3 do Painel do Sistema — Planos & Limites). O
// superadmin cadastra planos (Start/Pro/Premium/etc.) com um teto por
// recurso; cada loja (tenant) usa os limites do plano contratado OU um
// conjunto personalizado (ver saasContractsTable.usesCustomLimits/customLimits
// em saas.ts). Limite null = ilimitado nesse recurso.
export const LIMIT_FIELDS = [
  "maxAdmins",
  "maxSupervisors",
  "maxAttendants",
  "maxUsersTotal",
  "maxWhatsapps",
  "maxBranches",
  "maxSectors",
  "maxStorageGb",
  "maxConversationsMonthly",
  "maxAiBots",
] as const;
export type LimitField = typeof LIMIT_FIELDS[number];
export type PlanLimits = Record<LimitField, number | null>;

export const LIMIT_LABELS: Record<LimitField, string> = {
  maxAdmins: "Administradores",
  maxSupervisors: "Supervisores",
  maxAttendants: "Atendentes",
  maxUsersTotal: "Usuários totais",
  maxWhatsapps: "WhatsApps conectados",
  maxBranches: "Lojas/filiais",
  maxSectors: "Setores",
  maxStorageGb: "Armazenamento (GB)",
  maxConversationsMonthly: "Conversas mensais",
  maxAiBots: "Robôs/IA",
};

// Recursos com bloqueio ativo no backend nesta fase (contagem simples via
// contagem de linhas). Armazenamento, conversas mensais e robôs/IA entram
// no plano/tela mas ainda não têm contador de uso implementado — não são
// bloqueados ainda (ver planLimits.ts no api-server).
export const ENFORCED_LIMIT_FIELDS: LimitField[] = [
  "maxAdmins", "maxSupervisors", "maxAttendants", "maxUsersTotal",
  "maxWhatsapps", "maxBranches", "maxSectors",
];

export const plansTable = pgTable("plans", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  maxAdmins: integer("max_admins"),
  maxSupervisors: integer("max_supervisors"),
  maxAttendants: integer("max_attendants"),
  maxUsersTotal: integer("max_users_total"),
  maxWhatsapps: integer("max_whatsapps"),
  maxBranches: integer("max_branches"),
  maxSectors: integer("max_sectors"),
  maxStorageGb: integer("max_storage_gb"),
  maxConversationsMonthly: integer("max_conversations_monthly"),
  maxAiBots: integer("max_ai_bots"),
  // Plano arquivado não aparece mais como opção pra NOVAS lojas, mas quem já
  // usa continua com os limites normalmente (nunca apagamos o plano em si).
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Plan = typeof plansTable.$inferSelect;
