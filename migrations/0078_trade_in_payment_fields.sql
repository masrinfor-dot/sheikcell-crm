-- Nota de compra completa (Avaliação de Usados): forma de pagamento, dados
-- do Pix (chave + titular, que pode ser diferente do vendedor), bairro
-- separado do endereço livre, e foto do comprovante de pagamento (mesmo
-- padrão de document_photos/device_photos). Ver
-- artifacts/api-server/src/routes/tradeIn.ts.
ALTER TABLE trade_in_evaluations ADD COLUMN IF NOT EXISTS seller_neighborhood text;
ALTER TABLE trade_in_evaluations ADD COLUMN IF NOT EXISTS payment_method text;
ALTER TABLE trade_in_evaluations ADD COLUMN IF NOT EXISTS pix_key text;
ALTER TABLE trade_in_evaluations ADD COLUMN IF NOT EXISTS pix_key_holder text;
ALTER TABLE trade_in_evaluations ADD COLUMN IF NOT EXISTS payment_proof_photos jsonb NOT NULL DEFAULT '[]'::jsonb;
