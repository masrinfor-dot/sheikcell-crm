-- Módulo "Pagamentos entre Filiais" (aba Financeiro) — substitui a planilha
-- (PALHINA_BASE_PARA_PAGAMENTOS.xlsx) onde a Matriz registrava pagamentos
-- feitos em nome da rede e ratear entre filiais.
--
-- NÃO é o módulo "Financeiro Bancário" removido em
-- 0019_remove_peliculas_planilhas_financeiro_bancario.sql (aquele tentava
-- conectar conta bancária real via API + conciliação automática, nunca teve
-- conta conectada em produção). Aqui é 100% cadastro manual, sem integração
-- bancária nenhuma — "conta bancária" é só um rótulo (nome do banco/maquininha
-- por filial), do mesmo jeito que a planilha fazia.

CREATE TABLE IF NOT EXISTS finance_bank_accounts (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  store_id integer NOT NULL REFERENCES stores(id),
  bank_name text NOT NULL,
  label text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finance_bank_accounts_tenant_idx ON finance_bank_accounts(tenant_id);
CREATE INDEX IF NOT EXISTS finance_bank_accounts_store_idx ON finance_bank_accounts(store_id);

CREATE TABLE IF NOT EXISTS finance_payments (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  payment_date timestamptz NOT NULL,
  description text NOT NULL,
  supplier text,
  paying_bank_account_id integer NOT NULL REFERENCES finance_bank_accounts(id),
  paying_store_id integer NOT NULL REFERENCES stores(id),
  split_type text NOT NULL DEFAULT 'rateada',
  split_mode text NOT NULL DEFAULT 'percent',
  total_amount numeric NOT NULL,
  status text NOT NULL DEFAULT 'aberto',
  paid_at timestamptz,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finance_payments_tenant_idx ON finance_payments(tenant_id);
CREATE INDEX IF NOT EXISTS finance_payments_date_idx ON finance_payments(tenant_id, payment_date);
CREATE INDEX IF NOT EXISTS finance_payments_status_idx ON finance_payments(tenant_id, status);

CREATE TABLE IF NOT EXISTS finance_payment_allocations (
  id serial PRIMARY KEY,
  payment_id integer NOT NULL REFERENCES finance_payments(id) ON DELETE CASCADE,
  store_id integer NOT NULL REFERENCES stores(id),
  percent numeric,
  amount numeric NOT NULL
);
CREATE INDEX IF NOT EXISTS finance_payment_allocations_payment_idx ON finance_payment_allocations(payment_id);
CREATE INDEX IF NOT EXISTS finance_payment_allocations_store_idx ON finance_payment_allocations(store_id);

-- Módulo novo: libera por padrão pras lojas já existentes (mesma filosofia
-- das migrations 0016/0051 — ninguém perde nem precisa pedir liberação pra
-- experimentar; o superadmin desliga por loja se não quiser oferecer).
UPDATE tenants
SET enabled_modules = (
  SELECT COALESCE(jsonb_agg(DISTINCT elem), '[]'::jsonb)
  FROM jsonb_array_elements_text(enabled_modules || '["pagamentos"]'::jsonb) AS elem
)
WHERE NOT (enabled_modules ?& array['pagamentos']);
