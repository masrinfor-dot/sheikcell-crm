-- Distingue variantes de RAM e tecnologia de rede (pedido do lojista, 07/09):
-- alguns modelos (ex.: Realme Note 70) têm o MESMO armazenamento em versões
-- de RAM diferentes (4GB x 8GB) e/ou 4G x 5G, com custo/preço diferentes —
-- sem esses campos, duas variantes "256GB" ficavam indistinguíveis no
-- cadastro e a reimportação por IA podia sobrescrever uma com a outra.
-- Idempotente.
ALTER TABLE catalog_product_variants ADD COLUMN IF NOT EXISTS ram text;
ALTER TABLE catalog_product_variants ADD COLUMN IF NOT EXISTS network text;
