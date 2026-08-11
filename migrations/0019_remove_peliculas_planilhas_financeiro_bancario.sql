-- Remove as tabelas dos módulos descontinuados: Películas, Planilhas e
-- Financeiro Bancário (conexão de conta/conciliação — nunca teve conta real
-- conectada em produção, confirmado antes de remover). IF EXISTS + CASCADE:
-- idempotente e não depende de ordem manual de FK entre elas.
DROP TABLE IF EXISTS film_compat CASCADE;
DROP TABLE IF EXISTS sheet_links CASCADE;

DROP TABLE IF EXISTS bank_integration_credentials CASCADE;
DROP TABLE IF EXISTS reconciliation_matches CASCADE;
DROP TABLE IF EXISTS acquirer_sales CASCADE;
DROP TABLE IF EXISTS acquirer_repasses CASCADE;
DROP TABLE IF EXISTS bank_transactions CASCADE;
DROP TABLE IF EXISTS reconciliation_rules CASCADE;
DROP TABLE IF EXISTS bank_accounts CASCADE;
DROP TABLE IF EXISTS uploads_vendas CASCADE;
DROP TABLE IF EXISTS vendas_importadas CASCADE;
DROP TABLE IF EXISTS relatorios_salvos CASCADE;
DROP TABLE IF EXISTS finance_audit_log CASCADE;
