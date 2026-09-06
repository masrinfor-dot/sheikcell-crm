-- Vitrine: avaliação de cliente (estrelas + comentário), botão só liberado
-- pro modo varejo na vitrine pública (ver lib/db/src/schema/catalog.ts).

CREATE TABLE IF NOT EXISTS catalog_product_reviews (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  product_id integer NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
  variant_id integer REFERENCES catalog_product_variants(id) ON DELETE CASCADE,
  rating integer NOT NULL,
  customer_name text NOT NULL,
  customer_phone text NOT NULL,
  customer_city text NOT NULL,
  comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);
