-- Gerente IA: chat interno primeiro; sem retorno em X min → WhatsApp pessoal + alerta.
ALTER TABLE gerente_settings ADD COLUMN IF NOT EXISTS team_channel text NOT NULL DEFAULT 'chat_first';
ALTER TABLE gerente_settings ADD COLUMN IF NOT EXISTS chat_fallback_minutes integer NOT NULL DEFAULT 30;
CREATE TABLE IF NOT EXISTS gerente_chat_followups (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL,
  user_id integer NOT NULL,
  conversation_id integer NOT NULL,
  kind text NOT NULL,
  task_id integer,
  whatsapp_text text NOT NULL,
  summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  escalated_at timestamptz
);
CREATE INDEX IF NOT EXISTS gerente_chat_followups_open_idx ON gerente_chat_followups(tenant_id, resolved_at, escalated_at);
