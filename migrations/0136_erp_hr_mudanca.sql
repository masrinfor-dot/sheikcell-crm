-- RH mudou para o ERP (07/10/2026 — parte 5): telas de RH só de consulta,
-- link do candidato redireciona e o histórico todo vai para o ERP.
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS hr_last_edit_id integer NOT NULL DEFAULT 0;
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS hr_moved_to_erp boolean NOT NULL DEFAULT false;
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS hr_moved_at timestamptz;
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS hr_history_cursors jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS hr_history_done_at timestamptz;
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS erp_web_url text;
