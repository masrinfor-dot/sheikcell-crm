-- Item: processo seletivo personalizado por cargo (Vendedor, Administrativo,
-- Gerente, Estoque, etc.) + CPF obrigatório e sem repetir o processo.

CREATE TABLE IF NOT EXISTS rh_positions (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  stages jsonb NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

ALTER TABLE rh_candidates ADD COLUMN IF NOT EXISTS cpf text;
ALTER TABLE rh_candidates ADD COLUMN IF NOT EXISTS position_id integer;
ALTER TABLE rh_candidates ADD COLUMN IF NOT EXISTS position_name text;

-- Um CPF só pode concluir o processo seletivo 1 vez por loja — ignora linhas
-- antigas (cpf ainda nulo, de antes desta feature), então nunca conflita com
-- candidaturas já existentes.
CREATE UNIQUE INDEX IF NOT EXISTS rh_candidates_tenant_cpf_uniq
  ON rh_candidates (tenant_id, cpf) WHERE cpf IS NOT NULL;
