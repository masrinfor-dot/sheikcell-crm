-- Gerente IA: linha ADM → fila de aprovação do ERP (Financeiro › Aprovações do agente).
ALTER TABLE gerente_settings ADD COLUMN IF NOT EXISTS adm_session_key text;
ALTER TABLE gerente_settings ADD COLUMN IF NOT EXISTS erp_agent_key_ciphertext text;
ALTER TABLE gerente_settings ADD COLUMN IF NOT EXISTS erp_agent_key_iv text;
ALTER TABLE gerente_settings ADD COLUMN IF NOT EXISTS erp_agent_key_auth_tag text;
ALTER TABLE gerente_settings ADD COLUMN IF NOT EXISTS erp_agent_key_version integer;

CREATE TABLE IF NOT EXISTS gerente_erp_actions (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL,
  erp_action_id text,
  type text NOT NULL,
  summary text NOT NULL,
  status text NOT NULL DEFAULT 'PENDENTE',
  message text,
  payload jsonb,
  source_message_id integer,
  notified_status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gerente_erp_actions_tenant_idx ON gerente_erp_actions(tenant_id, created_at);
