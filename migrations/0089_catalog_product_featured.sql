-- Selo "Promoção" na Vitrine Aparelhos — flag manual (independente do
-- preço "de/por") pra destacar aparelhos escolhidos pelo lojista como
-- oferta. Idempotente.
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS featured boolean NOT NULL DEFAULT false;
