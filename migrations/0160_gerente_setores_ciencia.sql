-- Gerente IA: setores com responsáveis e ciência/prazo entre gerentes.
CREATE TABLE IF NOT EXISTS gerente_sectors (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL,
  name text NOT NULL,
  responsible_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  position integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gerente_sectors_tenant_name_uq ON gerente_sectors(tenant_id, name);
CREATE TABLE IF NOT EXISTS gerente_task_acks (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL,
  task_id integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id integer NOT NULL,
  requested_by integer,
  requested_at timestamptz NOT NULL DEFAULT now(),
  acked_at timestamptz,
  reminded_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS gerente_task_acks_task_user_uq ON gerente_task_acks(task_id, user_id);
-- "Equipe/RH" passa a ser o setor "RH".
UPDATE gerente_task_meta SET category = 'RH' WHERE category = 'Equipe/RH';
