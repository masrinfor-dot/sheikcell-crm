-- Aparelho desejado (deixado no carrinho da vitrine pública) na avaliação
-- de usado feita pelo cliente no fluxo "Trocar por este aparelho". Usado
-- pra montar a mensagem pronta ao iniciar atendimento com o lead. Idempotente.
ALTER TABLE trade_in_evaluations ADD COLUMN IF NOT EXISTS wanted_product text;
