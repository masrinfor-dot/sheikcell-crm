-- Módulo Financeiro Bancário (Fase 1) — contas/gateways por loja, extrato,
-- vendas de credenciadora/maquininha, repasses e motor de conciliação.
-- Idempotente — seguro re-executar a cada boot.

-- Identidade fiscal da loja — cada loja da rede pode ser um CNPJ/regime
-- tributário diferente.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS cnpj text;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS fiscal_regime text; -- simples | presumido | real
ALTER TABLE stores ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS state text; -- UF, 2 letras
ALTER TABLE stores ADD COLUMN IF NOT EXISTS zip_code text;

-- Conta bancária, gateway ou maquininha cadastrada para uma loja específica.
-- "kind" distingue conta (extrato/saldo) de maquininha (vendas de cartão) —
-- o PagBank, por exemplo, é as duas coisas ao mesmo tempo (duas linhas aqui).
CREATE TABLE IF NOT EXISTS bank_accounts (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL DEFAULT 1,
  store_id integer NOT NULL REFERENCES stores(id),
  provider text NOT NULL, -- pagbank | inter | itau | asaas | mercado_pago | cappta | rede | bradesco | nubank | sicoob | sicredi
  kind text NOT NULL DEFAULT 'conta', -- conta | maquininha
  label text NOT NULL,
  external_account_id text,
  currency text NOT NULL DEFAULT 'BRL',
  status text NOT NULL DEFAULT 'nao_configurado', -- nao_configurado | conectado | erro | desconectado
  last_sync_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bank_accounts_tenant_idx ON bank_accounts (tenant_id, store_id);

-- Credenciais/tokens de integração — SEMPRE criptografados (ver lib/crypto.ts
-- no api-server); nunca texto puro.
CREATE TABLE IF NOT EXISTS bank_integration_credentials (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL DEFAULT 1,
  bank_account_id integer NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  provider text NOT NULL,
  auth_type text NOT NULL DEFAULT 'api_key', -- oauth | api_key
  encrypted_payload text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'ativo', -- ativo | erro | expirado
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Movimentações da conta bancária/gateway (extrato). Sem cascade a partir de
-- bank_accounts: um lançamento financeiro não some junto com o cadastro da
-- conta (auditabilidade — nenhum lançamento é apagado).
CREATE TABLE IF NOT EXISTS bank_transactions (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL DEFAULT 1,
  bank_account_id integer NOT NULL REFERENCES bank_accounts(id),
  external_id text NOT NULL,
  posted_at timestamptz NOT NULL,
  amount_cents integer NOT NULL, -- assinado: positivo = crédito, negativo = débito
  type text NOT NULL, -- credit | debit
  description text,
  counterparty_doc text, -- CPF/CNPJ, quando disponível
  raw_payload jsonb,
  reconciliation_status text NOT NULL DEFAULT 'pending', -- pending | matched | ignored
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_account_external_unique ON bank_transactions (bank_account_id, external_id);
CREATE INDEX IF NOT EXISTS bank_transactions_tenant_idx ON bank_transactions (tenant_id, posted_at DESC);

-- Venda registrada pela credenciadora/maquininha (camada 1 da conciliação:
-- venda no sistema → venda na credenciadora → repasse na conta bancária).
CREATE TABLE IF NOT EXISTS acquirer_sales (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL DEFAULT 1,
  bank_account_id integer NOT NULL REFERENCES bank_accounts(id), -- a maquininha
  store_id integer NOT NULL REFERENCES stores(id),
  external_sale_id text NOT NULL,
  sold_at timestamptz NOT NULL,
  gross_amount_cents integer NOT NULL,
  fee_amount_cents integer NOT NULL DEFAULT 0,
  net_amount_cents integer NOT NULL,
  installments integer NOT NULL DEFAULT 1,
  card_brand text,
  payment_method text NOT NULL DEFAULT 'credito', -- credito | debito | pix
  authorization_code text,
  nsu text,
  repasse_status text NOT NULL DEFAULT 'pending', -- pending | repassado
  raw_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS acquirer_sales_account_external_unique ON acquirer_sales (bank_account_id, external_sale_id);
CREATE INDEX IF NOT EXISTS acquirer_sales_tenant_idx ON acquirer_sales (tenant_id, sold_at DESC);

-- Repasse financeiro da credenciadora para a conta bancária de destino
-- (camada 2 — liga um conjunto de acquirer_sales a um crédito em bank_transactions).
CREATE TABLE IF NOT EXISTS acquirer_repasses (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL DEFAULT 1,
  bank_account_id integer NOT NULL REFERENCES bank_accounts(id), -- conta destino
  external_repasse_id text NOT NULL,
  settled_at timestamptz NOT NULL,
  amount_cents integer NOT NULL,
  reconciled_transaction_id integer REFERENCES bank_transactions(id),
  raw_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS acquirer_repasses_account_external_unique ON acquirer_repasses (bank_account_id, external_repasse_id);

-- Vínculo N:1 — várias vendas caem num único repasse consolidado (comum em
-- PagBank/Mercado Pago). Coluna adicionada depois de acquirer_repasses existir.
ALTER TABLE acquirer_sales ADD COLUMN IF NOT EXISTS repasse_id integer REFERENCES acquirer_repasses(id);

-- Regras do motor de conciliação — avaliadas em ordem de "priority" (menor primeiro).
CREATE TABLE IF NOT EXISTS reconciliation_rules (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL DEFAULT 1,
  name text NOT NULL,
  rule_type text NOT NULL, -- valor_data | external_id | documento
  tolerance_value_cents integer,
  tolerance_days integer,
  priority integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Resultado da conciliação: qual bank_transaction foi casada com qual
-- acquirer_sale/acquirer_repasse (ou marcada manualmente), e por qual regra.
CREATE TABLE IF NOT EXISTS reconciliation_matches (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL DEFAULT 1,
  bank_transaction_id integer NOT NULL REFERENCES bank_transactions(id),
  matched_type text NOT NULL, -- acquirer_sale | acquirer_repasse | manual
  matched_record_id integer,
  rule_id integer REFERENCES reconciliation_rules(id),
  matched_by text NOT NULL DEFAULT 'system', -- "system" ou id do usuário (texto)
  status text NOT NULL DEFAULT 'auto', -- auto | manual_confirmed | rejected
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reconciliation_matches_tenant_idx ON reconciliation_matches (tenant_id, status);

-- ─── Trabalho futuro (Fase 2+): tabelas criadas agora para não exigir outra
-- migration depois, mas sem rota/parser/UI nesta fase. ───────────────────────

-- Upload de relatório de vendas mensal (PDF/Excel) para conferência manual.
CREATE TABLE IF NOT EXISTS uploads_vendas (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL DEFAULT 1,
  store_id integer NOT NULL REFERENCES stores(id),
  file_name text NOT NULL,
  stored_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL DEFAULT 0,
  uploaded_by integer REFERENCES users(id),
  status text NOT NULL DEFAULT 'pendente', -- pendente | processado | erro
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Linhas extraídas de um upload de vendas (uma por venda do arquivo enviado).
CREATE TABLE IF NOT EXISTS vendas_importadas (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL DEFAULT 1,
  upload_id integer NOT NULL REFERENCES uploads_vendas(id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  sold_at timestamptz,
  amount_cents integer NOT NULL,
  description text,
  raw_row jsonb NOT NULL,
  matched boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Relatórios personalizados salvos (filtros + colunas + agrupamento).
CREATE TABLE IF NOT EXISTS relatorios_salvos (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL DEFAULT 1,
  name text NOT NULL,
  config jsonb NOT NULL, -- { filtros, colunas, agrupamento }
  created_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
