-- Pedidos de clientes sem estoque (16/10/2026): o CRM manda as conversas da
-- linha de atacado do WhatsApp para a IA do ERP listar o que os clientes
-- pediram; a lista fica em Compras › Pedidos de clientes, no ERP.
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS demand_session_key text;
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS demand_sync_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS demand_last_sync_at timestamptz;
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS demand_last_error text;
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS demand_sent_count integer NOT NULL DEFAULT 0;
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS demand_pending_count integer NOT NULL DEFAULT 0;

-- Até onde cada conversa já foi mandada (id da última mensagem do cliente).
CREATE TABLE IF NOT EXISTS erp_demand_cursors (
  conversation_id integer PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  tenant_id integer NOT NULL,
  last_message_id integer NOT NULL DEFAULT 0,
  synced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS erp_demand_cursors_tenant_idx ON erp_demand_cursors(tenant_id);
