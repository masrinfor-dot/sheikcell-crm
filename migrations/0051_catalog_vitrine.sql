-- Vitrine de Aparelhos: catálogo de produtos com formação de preço (custo +
-- margem de lucro bruto + taxa de parcelamento no cartão + custo de nota
-- fiscal), importação de lista de fornecedor via IA e vitrine pública
-- compartilhável por link (/vitrine/:slug).
CREATE TABLE IF NOT EXISTS catalog_products (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  model text NOT NULL,
  storage text,
  condition text NOT NULL DEFAULT 'seminovo',
  colors jsonb NOT NULL DEFAULT '[]'::jsonb,
  description text,
  cost_price numeric,
  cost_includes_invoice boolean NOT NULL DEFAULT false,
  margin_percent_override numeric,
  sale_price numeric,
  stock_qty integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  sort_order integer NOT NULL DEFAULT 0,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS catalog_products_tenant_idx ON catalog_products(tenant_id);
CREATE INDEX IF NOT EXISTS catalog_products_status_idx ON catalog_products(tenant_id, status);

CREATE TABLE IF NOT EXISTS catalog_product_photos (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  product_id integer NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
  stored_name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS catalog_product_photos_product_idx ON catalog_product_photos(product_id);

-- Endereço público da vitrine (ex.: /vitrine/sheikcell). Null = desligado até
-- o admin escolher um slug em Vitrine Aparelhos > Configurações.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS catalog_slug text;
CREATE UNIQUE INDEX IF NOT EXISTS tenants_catalog_slug_idx ON tenants(catalog_slug) WHERE catalog_slug IS NOT NULL;

-- Módulo novo: libera por padrão pras lojas já existentes (mesma filosofia da
-- migration 0016 — ninguém perde nem precisa pedir liberação pra
-- experimentar a Vitrine; o superadmin desliga por loja se não quiser
-- oferecer o módulo).
UPDATE tenants
SET enabled_modules = (
  SELECT COALESCE(jsonb_agg(DISTINCT elem), '[]'::jsonb)
  FROM jsonb_array_elements_text(enabled_modules || '["vitrine"]'::jsonb) AS elem
)
WHERE NOT (enabled_modules ?& array['vitrine']);
