-- Painel do Sistema (Fase 3): modelos de plano com limite configurável por
-- recurso, e a possibilidade de personalizar os limites de uma loja
-- específica sem alterar o plano nem as demais lojas.
CREATE TABLE IF NOT EXISTS plans (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  max_admins integer,
  max_supervisors integer,
  max_attendants integer,
  max_users_total integer,
  max_whatsapps integer,
  max_branches integer,
  max_sectors integer,
  max_storage_gb integer,
  max_conversations_monthly integer,
  max_ai_bots integer,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE saas_contracts ADD COLUMN IF NOT EXISTS plan_id integer REFERENCES plans(id);
ALTER TABLE saas_contracts ADD COLUMN IF NOT EXISTS uses_custom_limits boolean NOT NULL DEFAULT false;
ALTER TABLE saas_contracts ADD COLUMN IF NOT EXISTS custom_limits jsonb;

-- Três planos de exemplo pra começar (o superadmin edita os números e cria
-- outros à vontade pela tela) — só entra se a tabela ainda estiver vazia,
-- então rodar essa migration de novo nunca duplica nem sobrescreve edições
-- suas.
INSERT INTO plans (
  name, max_admins, max_supervisors, max_attendants, max_users_total,
  max_whatsapps, max_branches, max_sectors, max_storage_gb,
  max_conversations_monthly, max_ai_bots
) VALUES
  ('Start', 1, 1, 5, 7, 1, 1, 3, 5, NULL, 1),
  ('Pro', 2, 3, 15, 20, 4, 3, 10, 20, NULL, 3),
  ('Premium', 5, 10, 50, 65, 10, 10, 30, 100, NULL, 10)
ON CONFLICT (name) DO NOTHING;
