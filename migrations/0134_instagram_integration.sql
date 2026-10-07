-- Instagram Direct no Atendimento (07/10/2026): conta profissional da loja,
-- token e chave do app cifrados. Conversas usam channel='instagram'.
CREATE TABLE IF NOT EXISTS tenant_instagram_integrations (
  tenant_id integer PRIMARY KEY,
  ig_user_id text,
  username text,
  encrypted_token text NOT NULL,
  token_iv text NOT NULL,
  token_auth_tag text NOT NULL,
  token_key_version integer NOT NULL DEFAULT 1,
  token_last4 text NOT NULL,
  token_expires_at timestamptz,
  encrypted_app_secret text,
  app_secret_iv text,
  app_secret_auth_tag text,
  app_secret_key_version integer,
  verify_token text NOT NULL,
  sector_id integer REFERENCES sectors(id) ON DELETE SET NULL,
  enabled boolean NOT NULL DEFAULT false,
  last_webhook_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_instagram_integrations_ig_user_id_uniq
  ON tenant_instagram_integrations (ig_user_id) WHERE ig_user_id IS NOT NULL;
