-- Vitrine de Aparelhos — Fase 3:
-- 1) Categorias/abas personalizáveis (ex.: Celulares > Samsung/Apple, Peças
--    de celular) — a loja cria/edita/apaga livremente.
-- 2) Preço de atacado por variante, visível na vitrine pública só pra quem
--    desbloqueia com um código de acesso configurado pelo admin da loja
--    (técnicos/lojistas). O carrinho/pedido-por-WhatsApp da vitrine pública
--    é só front-end (usa o WhatsApp já configurado em catalog_whatsapp),
--    não precisa de tabela nova.

-- ─── Categorias ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS catalog_categories (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  name text NOT NULL,
  parent_id integer,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS catalog_categories_tenant_idx ON catalog_categories(tenant_id);
CREATE INDEX IF NOT EXISTS catalog_categories_parent_idx ON catalog_categories(parent_id);

-- parent_id referencia a própria tabela — adicionado depois do CREATE TABLE
-- pra não precisar de sintaxe de auto-referência inline. Apagar uma
-- categoria-pai apaga as subcategorias junto (CASCADE); os produtos que
-- apontavam pra elas ficam sem categoria (ver FK abaixo em catalog_products).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'catalog_categories_parent_id_fkey'
  ) THEN
    ALTER TABLE catalog_categories
      ADD CONSTRAINT catalog_categories_parent_id_fkey
      FOREIGN KEY (parent_id) REFERENCES catalog_categories(id) ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS category_id integer;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'catalog_products_category_id_fkey'
  ) THEN
    ALTER TABLE catalog_products
      ADD CONSTRAINT catalog_products_category_id_fkey
      FOREIGN KEY (category_id) REFERENCES catalog_categories(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS catalog_products_category_idx ON catalog_products(category_id);

-- ─── Preço de atacado ──────────────────────────────────────────────────────
ALTER TABLE catalog_product_variants ADD COLUMN IF NOT EXISTS wholesale_price numeric;

-- ─── Código de acesso ao preço de atacado ─────────────────────────────────
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS catalog_wholesale_code text;
