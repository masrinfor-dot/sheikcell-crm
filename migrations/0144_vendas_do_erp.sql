-- Vendas que vieram do atendimento (19/10/2026): cursor do envio dos
-- atendimentos ao ERP Prumo (uma linha por loja). Idempotente.
CREATE TABLE IF NOT EXISTS erp_sales_sync (
  tenant_id integer PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  cursor_at timestamptz,
  cursor_id integer NOT NULL DEFAULT 0,
  attendants_synced_at timestamptz,
  last_sync_at timestamptz,
  last_error text,
  sent_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
