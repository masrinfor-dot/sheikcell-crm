-- Sub-fluxo de compra na Avaliação de Usado: nota de compra completa ao
-- fechar o negócio (etapa 4) — RG, endereço e telefone do cliente vendedor
-- (além do nome/CPF que já existiam), e fotos de documento/aparelho pra
-- comprovar a compra. document_photos/device_photos são listas de URL
-- (jsonb array de string), preenchidas aos poucos via POST
-- /trade-in/:id/photos — cada avaliação já é uma "compra" independente, então
-- várias compras do mesmo cliente (mesmo CPF) já funcionam sem mudança
-- nenhuma aqui, basta fechar mais de uma avaliação pra ele.
ALTER TABLE trade_in_evaluations ADD COLUMN IF NOT EXISTS seller_rg text;
ALTER TABLE trade_in_evaluations ADD COLUMN IF NOT EXISTS seller_address text;
ALTER TABLE trade_in_evaluations ADD COLUMN IF NOT EXISTS seller_phone text;
ALTER TABLE trade_in_evaluations ADD COLUMN IF NOT EXISTS document_photos jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE trade_in_evaluations ADD COLUMN IF NOT EXISTS device_photos jsonb NOT NULL DEFAULT '[]'::jsonb;
