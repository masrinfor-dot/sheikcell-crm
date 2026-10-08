-- RH com o ERP Prumo (07/10/2026): o ERP é o dono de todo o cadastro; o CRM
-- só manda as batidas do WhatsApp, o fechamento do mês e os documentos da
-- contratação. Cursores do que já foi enviado.
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS hr_sync_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS hr_imported_at timestamptz;
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS hr_last_pull_at timestamptz;
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS hr_last_punch_id integer NOT NULL DEFAULT 0;
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS hr_last_closure_id integer NOT NULL DEFAULT 0;
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS hr_last_document_id integer NOT NULL DEFAULT 0;
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS hr_last_sync_at timestamptz;
ALTER TABLE tenant_erp_integrations ADD COLUMN IF NOT EXISTS hr_last_error text;
