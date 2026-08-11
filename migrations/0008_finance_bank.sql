-- Módulo Financeiro Bancário foi removido — ver
-- 0019_remove_peliculas_planilhas_financeiro_bancario.sql. As tabelas que
-- este arquivo criava (bank_accounts, bank_integration_credentials,
-- bank_transactions, acquirer_sales, acquirer_repasses, reconciliation_rules,
-- reconciliation_matches, uploads_vendas, vendas_importadas,
-- relatorios_salvos) não são mais recriadas aqui — senão o replay idempotente
-- desta migration ficaria recriando-as a cada boot só pra 0019 apagar de novo
-- em seguida, sem propósito.
--
-- As colunas de identidade fiscal em "stores" abaixo NÃO fazem parte do
-- módulo removido (ficaram sem uso, mas foi decisão deliberada mantê-las —
-- ver contexto da remoção) — continuam aplicadas normalmente.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS cnpj text;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS fiscal_regime text; -- simples | presumido | real
ALTER TABLE stores ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS state text; -- UF, 2 letras
ALTER TABLE stores ADD COLUMN IF NOT EXISTS zip_code text;
