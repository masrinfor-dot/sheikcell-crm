-- Avaliação de usados pública (cliente avalia o próprio aparelho na vitrine,
-- sem login) + tabela de valores base fixa (fórmula/lista, pedido 06/09).
-- Idempotente.

-- Origem da avaliação: "staff" (padrão, feita por alguém da loja) ou
-- "public_lead" (veio do formulário público, ver tradeInPublicRouter).
ALTER TABLE trade_in_evaluations ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'staff';

CREATE TABLE IF NOT EXISTS trade_in_base_values (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  brand text NOT NULL,
  model text NOT NULL,
  storage text,
  base_value numeric NOT NULL,
  notes text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trade_in_base_values_tenant_idx ON trade_in_base_values (tenant_id);
