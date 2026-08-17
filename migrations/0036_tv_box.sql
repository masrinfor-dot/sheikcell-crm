-- Painel de assinantes da TV Box (Uni TV): cadastro de cliente com
-- mensalidade + vencimento, e faturas mensais geradas automaticamente
-- (mesmo desenho de saas_contracts/saas_invoices, por loja).
CREATE TABLE IF NOT EXISTS tv_box_clients (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  name text NOT NULL,
  phone text NOT NULL,
  monthly_value_cents integer NOT NULL,
  due_day integer NOT NULL,
  sector_id integer REFERENCES sectors(id),
  status text NOT NULL DEFAULT 'ativo',
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tv_box_clients_tenant_idx ON tv_box_clients (tenant_id);

CREATE TABLE IF NOT EXISTS tv_box_invoices (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  client_id integer NOT NULL REFERENCES tv_box_clients(id) ON DELETE CASCADE,
  description text NOT NULL DEFAULT 'Mensalidade TV Box',
  amount_cents integer NOT NULL,
  due_date date NOT NULL,
  billing_month text,
  status text NOT NULL DEFAULT 'pendente',
  paid_at timestamp with time zone,
  reminder_sent_at timestamp with time zone,
  last_charge_sent_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tv_box_invoices_client_month_unique ON tv_box_invoices (client_id, billing_month);
CREATE INDEX IF NOT EXISTS tv_box_invoices_tenant_idx ON tv_box_invoices (tenant_id);
CREATE INDEX IF NOT EXISTS tv_box_invoices_client_idx ON tv_box_invoices (client_id);

-- Garante no banco (não só na aplicação) que cada loja tem no máximo UM
-- setor "TV Box" — ensureTvBoxSector() faz select-then-insert e conta com
-- essa trava pra convergir sob concorrência (mesmo padrão da sala geral do
-- chat interno, ver internal_conversations_general_by_tenant_unique).
CREATE UNIQUE INDEX IF NOT EXISTS sectors_tvbox_by_tenant_unique ON sectors (tenant_id) WHERE name = 'TV Box';
