-- Vitrine de Aparelhos — 3 melhorias:
-- 1) Variantes de armazenamento: um cadastro (modelo+condição+cores) agora
--    pode ter várias variantes de memória, cada uma com preço/estoque
--    próprios, em vez de um cadastro duplicado por armazenamento.
-- 2) Selo de qualidade padrão SheikCell: troca a condição livre
--    (lacrado/seminovo/cpo/usado) pelo grau fixo com critério documentado
--    (excelente/muito_bom/bom/outlet — ver CATALOG_CONDITION_CRITERIA).
-- 3) WhatsApp de vendas configurável pelo admin da loja pro botão da
--    vitrine pública (em vez do telefone de contato administrativo).

-- ─── Variantes ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS catalog_product_variants (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  product_id integer NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
  storage text,
  cost_price numeric,
  cost_includes_invoice boolean NOT NULL DEFAULT false,
  margin_percent_override numeric,
  sale_price numeric,
  stock_qty integer NOT NULL DEFAULT 1,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS catalog_product_variants_product_idx ON catalog_product_variants(product_id);
CREATE INDEX IF NOT EXISTS catalog_product_variants_tenant_idx ON catalog_product_variants(tenant_id);

-- Migra cada catalog_products existente (armazenamento+preço no próprio
-- produto, formato antigo) pra uma variante única, preservando os dados.
-- Precisa ser SQL dinâmico (EXECUTE dentro de DO $$): como as colunas
-- antigas (storage, cost_price etc.) são removidas logo abaixo, um INSERT
-- estático referenciando essas colunas quebraria na SEGUNDA execução dessa
-- migration (o Postgres valida as colunas do SELECT no parse da query,
-- mesmo que o WHERE nunca chegasse a rodar) — as migrations rodam de novo a
-- cada boot, então isso teria quebrado o próximo deploy.
DO $$
BEGIN
  IF to_regclass('catalog_products') IS NOT NULL AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'catalog_products' AND column_name = 'cost_price'
  ) THEN
    EXECUTE '
      INSERT INTO catalog_product_variants (
        tenant_id, product_id, storage, cost_price, cost_includes_invoice,
        margin_percent_override, sale_price, stock_qty, sort_order
      )
      SELECT tenant_id, id, storage, cost_price, cost_includes_invoice,
             margin_percent_override, sale_price, stock_qty, 0
      FROM catalog_products
      WHERE NOT EXISTS (SELECT 1 FROM catalog_product_variants WHERE product_id = catalog_products.id)
    ';
  END IF;
END $$;

ALTER TABLE catalog_products DROP COLUMN IF EXISTS storage;
ALTER TABLE catalog_products DROP COLUMN IF EXISTS cost_price;
ALTER TABLE catalog_products DROP COLUMN IF EXISTS cost_includes_invoice;
ALTER TABLE catalog_products DROP COLUMN IF EXISTS margin_percent_override;
ALTER TABLE catalog_products DROP COLUMN IF EXISTS sale_price;
ALTER TABLE catalog_products DROP COLUMN IF EXISTS stock_qty;

-- ─── Selo de qualidade (novo grau fixo) ───────────────────────────────────
ALTER TABLE catalog_products ALTER COLUMN condition SET DEFAULT 'bom';
UPDATE catalog_products SET condition = CASE condition
  WHEN 'lacrado'  THEN 'excelente'
  WHEN 'cpo'      THEN 'muito_bom'
  WHEN 'seminovo' THEN 'bom'
  WHEN 'usado'    THEN 'outlet'
  ELSE condition
END
WHERE condition IN ('lacrado', 'cpo', 'seminovo', 'usado');

-- ─── Origem da foto (upload manual vs. busca de imagem) ──────────────────
ALTER TABLE catalog_product_photos ADD COLUMN IF NOT EXISTS source_url text;

-- ─── WhatsApp de vendas da vitrine (configurável pelo admin da loja) ──────
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS catalog_whatsapp text;
