-- Trocas com o ERP (19/10/2026): histórico de cada chamada do CRM ao ERP Prumo
-- (sem conteúdo sensível). Guardado 90 dias (limpeza automática).
CREATE TABLE IF NOT EXISTS erp_exchange_logs (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL,
  flow text NOT NULL,
  direction text NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  http_status integer,
  ok boolean NOT NULL,
  duration_ms integer NOT NULL DEFAULT 0,
  item_count integer,
  summary text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS erp_exchange_logs_tenant_created_idx ON erp_exchange_logs (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS erp_exchange_logs_created_idx ON erp_exchange_logs (created_at);
