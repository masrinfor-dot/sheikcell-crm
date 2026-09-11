-- Teste na loja (checklist) + status "contratado" no Recrutamento
-- (pedido 11/09: "criar teste na loja com checklist... contratado, iniciar
-- processo de contratação... só junta com o que já criamos"). Idempotente.
ALTER TABLE rh_candidates ADD COLUMN IF NOT EXISTS store_test_checklist jsonb;
ALTER TABLE rh_candidates ADD COLUMN IF NOT EXISTS store_test_notes text;
