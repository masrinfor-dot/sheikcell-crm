-- Chave de IA (OpenAI) própria por loja — cada tenant pode trazer a própria
-- conta em vez de usar a chave global da plataforma. Uma linha por tenant.
CREATE TABLE IF NOT EXISTS tenant_ai_credentials (
  tenant_id integer PRIMARY KEY,
  encrypted_api_key text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  last4 text NOT NULL,
  use_own_key boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
