import { pgTable, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";

// Chave da OpenAI própria de cada loja — permite trocar a chave global da
// plataforma pela conta OpenAI da própria loja, pra todos os recursos de IA
// (robô, sugestão de resposta, correção de texto, transcrição, avaliação de
// usados). Uma linha por tenant (o tenantId já é a chave primária: nunca há
// mais de uma credencial por loja).
//
// A chave em si nunca é gravada em texto puro — ver
// artifacts/api-server/src/lib/aiCredentialsCrypto.ts (AES-256-GCM, mesmo
// padrão usado antes pelo módulo Financeiro Bancário, removido). O valor
// decifrado nunca é devolvido pro frontend depois de salvo — só last4 (pra
// exibir "sk-...abcd") e um booleano indicando se existe.
export const tenantAiCredentialsTable = pgTable("tenant_ai_credentials", {
  tenantId: integer("tenant_id").primaryKey(),
  encryptedApiKey: text("encrypted_api_key").notNull(),
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  // Últimos 4 caracteres da chave, em texto puro — só pra loja reconhecer
  // qual chave está salva ("sk-...abcd"), nunca o suficiente pra reconstruir
  // a chave real.
  last4: text("last4").notNull(),
  // Permite a loja voltar pra chave global temporariamente sem apagar a
  // própria (ex.: testar se um problema é da chave dela ou da plataforma).
  useOwnKey: boolean("use_own_key").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type TenantAiCredentials = typeof tenantAiCredentialsTable.$inferSelect;
