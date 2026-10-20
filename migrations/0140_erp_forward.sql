-- Encaminhamento ao ERP (Prumo) das listas de preço que os fornecedores
-- mandam no WhatsApp de compras (19/10/2026). Cada conexão do WhatsApp pode
-- ser marcada como "de compras" (forward_to_erp); toda mensagem recebida nela
-- entra numa fila (outbox) e é enviada ao ERP com nova tentativa em caso de
-- falha — o webhook do WhatsApp nunca espera o ERP.
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS forward_to_erp boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS erp_forward_queue (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL DEFAULT 1,
  session_key text NOT NULL,
  external_id text NOT NULL UNIQUE,
  conversation_id integer,
  -- { senderPhone, senderName, receivedAt, text, fileName, mimeType, mediaPath?, mediaBase64? }
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending', -- pending | processing | sent | failed
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  erp_list_id text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS erp_forward_queue_status_next_idx ON erp_forward_queue(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS erp_forward_queue_tenant_idx ON erp_forward_queue(tenant_id, created_at);
