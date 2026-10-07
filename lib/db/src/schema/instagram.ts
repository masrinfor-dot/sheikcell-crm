import { pgTable, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";

// Instagram Direct no Atendimento (07/10/2026). Uma conta profissional do
// Instagram por loja, conectada pela "Instagram API com login do Instagram"
// (graph.instagram.com). Token de acesso (60 dias, renovado sozinho) e chave
// secreta do app (assina o webhook) ficam cifrados (AES-256-GCM, mesmo cofre
// da integração com o ERP — lib/erpCrypto.ts) e nunca voltam pro frontend.
// Conversas do Instagram usam channel="instagram", phone="ig:<IGSID>" e
// session_key="instagram".
export const tenantInstagramIntegrationsTable = pgTable("tenant_instagram_integrations", {
  tenantId: integer("tenant_id").primaryKey(),
  // Conta profissional (id e @) — preenchidos ao testar o token.
  igUserId: text("ig_user_id"),
  username: text("username"),
  encryptedToken: text("encrypted_token").notNull(),
  tokenIv: text("token_iv").notNull(),
  tokenAuthTag: text("token_auth_tag").notNull(),
  tokenKeyVersion: integer("token_key_version").notNull().default(1),
  tokenLast4: text("token_last4").notNull(),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  encryptedAppSecret: text("encrypted_app_secret"),
  appSecretIv: text("app_secret_iv"),
  appSecretAuthTag: text("app_secret_auth_tag"),
  appSecretKeyVersion: integer("app_secret_key_version"),
  // Texto que a Meta manda na verificação do webhook (gerado aqui).
  verifyToken: text("verify_token").notNull(),
  sectorId: integer("sector_id"),
  enabled: boolean("enabled").notNull().default(false),
  lastWebhookAt: timestamp("last_webhook_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type TenantInstagramIntegration = typeof tenantInstagramIntegrationsTable.$inferSelect;
