-- Vitrine: preço "de/por" com desconto, características geradas por IA e
-- "avise-me quando chegar" (ver lib/db/src/schema/catalog.ts).

-- Preço "de" (comparação) por variante — quando maior que o preço à vista
-- atual, a vitrine pública mostra ele riscado + selo de desconto.
ALTER TABLE catalog_product_variants ADD COLUMN IF NOT EXISTS compare_at_price numeric;

-- Lista de características (specs) geradas por IA, por produto.
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS ai_characteristics jsonb;

-- Pedidos de "avise-me quando chegar" feitos por clientes na vitrine pública
-- pra produtos/variantes esgotados (sem login — captura nome + contato).
CREATE TABLE IF NOT EXISTS catalog_stock_notifications (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  product_id integer NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
  variant_id integer REFERENCES catalog_product_variants(id) ON DELETE CASCADE,
  customer_name text NOT NULL,
  customer_contact text NOT NULL,
  notified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
