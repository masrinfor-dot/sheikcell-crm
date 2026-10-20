-- Gerente IA: WhatsApp de cada vendedor para receber tarefas (RH foi pro ERP).
CREATE TABLE IF NOT EXISTS gerente_team_phones (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL,
  user_id integer NOT NULL,
  phone text NOT NULL,
  last_test_at timestamptz,
  last_test_ok boolean,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gerente_team_phones_tenant_user_uq ON gerente_team_phones(tenant_id, user_id);
