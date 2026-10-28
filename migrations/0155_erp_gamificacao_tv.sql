-- Pontuação do atendimento → gamificação do ERP Prumo e "Clientes esperando
-- resposta" na TV das lojas do ERP (27/10/2026). Só acrescenta (idempotente).

-- 1) Interruptores e cursores na ligação com o ERP. Os dois nascem LIGADOS
--    (valem quando a ligação com o ERP existe); a pontuação só conta o que
--    acontecer depois de ligada (gamification_since é preenchido na 1ª rodada).
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS gamification_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS gamification_since timestamptz;
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS gamification_msg_cursor integer NOT NULL DEFAULT 0;
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS gamification_sales_cursor text;
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS gamification_last_sync_at timestamptz;
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS gamification_last_error text;
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS tv_waiting_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS tv_waiting_last_push_at timestamptz;
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS tv_waiting_last_error text;

-- 2) Fila (outbox) dos eventos de pontuação — só ids e números (LGPD).
CREATE TABLE IF NOT EXISTS erp_gamification_events (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL,
  event_id text NOT NULL,
  type text NOT NULL,
  conversation_id integer,
  agent_user_id integer,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending', -- pending | processing | sent | failed
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  erp_status text,
  erp_points integer,
  erp_message text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS erp_gamification_events_tenant_event_uniq ON erp_gamification_events (tenant_id, event_id);
CREATE INDEX IF NOT EXISTS erp_gamification_events_status_next_idx ON erp_gamification_events (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS erp_gamification_events_tenant_created_idx ON erp_gamification_events (tenant_id, created_at);

-- 3) Loja do CRM / linha de WhatsApp → loja do ERP.
CREATE TABLE IF NOT EXISTS erp_store_links (
  tenant_id integer NOT NULL,
  kind text NOT NULL, -- store | line
  crm_ref text NOT NULL,
  erp_store_id text NOT NULL,
  erp_store_name text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind, crm_ref)
);
