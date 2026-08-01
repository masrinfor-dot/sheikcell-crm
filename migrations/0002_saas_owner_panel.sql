-- Painel do dono do sistema (SaaS): contratos, mensalidades, chamados e
-- dados comerciais do lojista. Idempotente — seguro re-executar a cada boot.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS saas_status text NOT NULL DEFAULT 'ativo';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS contact_name text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS contact_phone text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS contact_email text;

CREATE TABLE IF NOT EXISTS saas_contracts (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id),
  plan text NOT NULL DEFAULT 'Mensal',
  monthly_value_cents integer NOT NULL DEFAULT 0,
  start_date date,
  renewal_date date,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS saas_contracts_tenant_unique ON saas_contracts(tenant_id);

CREATE TABLE IF NOT EXISTS saas_invoices (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id),
  description text NOT NULL DEFAULT 'Mensalidade',
  amount_cents integer NOT NULL,
  due_date date NOT NULL,
  billing_month text,
  status text NOT NULL DEFAULT 'pendente',
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE saas_invoices ADD COLUMN IF NOT EXISTS billing_month text;
-- Garante no banco que a geração automática nunca duplica a mensalidade de
-- uma loja no mesmo mês (mesmo com requisições simultâneas).
CREATE UNIQUE INDEX IF NOT EXISTS saas_invoices_tenant_month_unique
  ON saas_invoices(tenant_id, billing_month);

CREATE TABLE IF NOT EXISTS saas_tickets (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id),
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'aberto',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE IF NOT EXISTS saas_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
