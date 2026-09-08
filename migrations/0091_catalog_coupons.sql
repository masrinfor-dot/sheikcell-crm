-- Cupons de desconto da Vitrine — desconto real (aplicado pelo cliente no
-- carrinho público ou pelo vendedor manualmente no Atendimento) e
-- identificação de quem trouxe a venda (vendor_name é texto livre, cobre
-- vendedor interno OU externo/afiliado sem login no sistema). Idempotente.
CREATE TABLE IF NOT EXISTS catalog_coupons (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL DEFAULT 1,
  code text NOT NULL,
  discount_type text NOT NULL,
  discount_value numeric NOT NULL,
  vendor_name text,
  active boolean NOT NULL DEFAULT true,
  usage_limit integer,
  used_count integer NOT NULL DEFAULT 0,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS catalog_coupons_tenant_code_idx ON catalog_coupons (tenant_id, code);
CREATE INDEX IF NOT EXISTS catalog_coupons_tenant_idx ON catalog_coupons (tenant_id);
