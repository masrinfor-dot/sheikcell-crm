-- Data/hora do teste de campo e responsável da loja que avaliou (pedido
-- 11/09: "na parte de teste de campo colocar data e hora e checklist de
-- avaliação do responsável pela loja"). Idempotente.
ALTER TABLE rh_candidates ADD COLUMN IF NOT EXISTS store_test_at timestamptz;
ALTER TABLE rh_candidates ADD COLUMN IF NOT EXISTS store_test_evaluator_name text;
