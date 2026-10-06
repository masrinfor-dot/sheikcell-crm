-- Ligação da loja com o ERP Prumo (06/10/2026): endereço e chave (cifrada).
-- Primeiro uso: mensagens das OS pelo WhatsApp.
CREATE TABLE IF NOT EXISTS tenant_erp_integrations (
  tenant_id integer PRIMARY KEY,
  base_url text NOT NULL,
  encrypted_api_key text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  last4 text NOT NULL,
  os_messages_enabled boolean NOT NULL DEFAULT false,
  last_poll_at timestamptz,
  last_error text,
  sent_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
