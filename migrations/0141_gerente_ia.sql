-- Gerente IA: secretária executiva / gerente geral por WhatsApp, dentro do
-- CRM (substitui o protótipo "Meu Acessor", que rodava à parte). Usa as
-- linhas de WhatsApp já conectadas; só mensagens de um número AUTORIZADO
-- (celular pessoal do dono) entram aqui — nunca viram atendimento.

CREATE TABLE IF NOT EXISTS gerente_settings (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  assistant_name text NOT NULL DEFAULT 'Gerente IA',
  authorized_phones jsonb NOT NULL DEFAULT '[]'::jsonb,
  quiet_start text NOT NULL DEFAULT '22:00',
  quiet_end text NOT NULL DEFAULT '07:00',
  daily_digest_time text DEFAULT '07:30',
  daily_digest_sent_on date,
  last_session_key text,
  last_phone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gerente_messages (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL,
  phone text NOT NULL,
  session_key text,
  direction text NOT NULL,
  source text NOT NULL DEFAULT 'whatsapp',
  content text NOT NULL,
  intent text,
  payload jsonb,
  external_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gerente_messages_tenant_created_idx ON gerente_messages(tenant_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS gerente_messages_external_id_uq ON gerente_messages(external_id);

CREATE TABLE IF NOT EXISTS gerente_events (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL,
  title text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  location text,
  participants text,
  scope text NOT NULL DEFAULT 'empresa',
  store_name text,
  notes text,
  status text NOT NULL DEFAULT 'agendado',
  remind_minutes_before integer NOT NULL DEFAULT 30,
  reminded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gerente_events_tenant_starts_idx ON gerente_events(tenant_id, starts_at);

CREATE TABLE IF NOT EXISTS gerente_reminders (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL,
  title text NOT NULL,
  due_at timestamptz NOT NULL,
  urgent boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pendente',
  sent_at timestamptz,
  snooze_count integer NOT NULL DEFAULT 0,
  task_id integer REFERENCES tasks(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gerente_reminders_tenant_due_idx ON gerente_reminders(tenant_id, due_at);

CREATE TABLE IF NOT EXISTS gerente_entries (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL,
  kind text NOT NULL,
  amount_cents integer NOT NULL,
  description text NOT NULL,
  category text,
  scope text NOT NULL DEFAULT 'empresa',
  store_name text,
  payment_method text,
  installments integer NOT NULL DEFAULT 1,
  reimbursement_pending boolean NOT NULL DEFAULT false,
  entry_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gerente_entries_tenant_date_idx ON gerente_entries(tenant_id, entry_date);

CREATE TABLE IF NOT EXISTS gerente_bills (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL,
  kind text NOT NULL,
  description text NOT NULL,
  amount_cents integer NOT NULL,
  due_date date NOT NULL,
  counterparty text,
  responsible text,
  scope text NOT NULL DEFAULT 'empresa',
  store_name text,
  status text NOT NULL DEFAULT 'aberta',
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gerente_bills_tenant_due_idx ON gerente_bills(tenant_id, due_date);

CREATE TABLE IF NOT EXISTS gerente_pending_actions (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL,
  phone text NOT NULL,
  action jsonb NOT NULL,
  summary text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gerente_pending_actions_tenant_phone_uq ON gerente_pending_actions(tenant_id, phone);

-- Módulo "gerente" liberado em toda loja já existente (mesmo padrão das
-- migrações 0059/0063). O superadmin pode desligar por loja depois.
UPDATE tenants
SET enabled_modules = (
  SELECT COALESCE(jsonb_agg(DISTINCT elem), '[]'::jsonb)
  FROM jsonb_array_elements_text(enabled_modules || '["gerente"]'::jsonb) AS elem
)
WHERE NOT (enabled_modules ?& array['gerente']);

-- Loja 1 (Sheikcell): o celular pessoal do dono já nasce autorizado, pra não
-- depender de configurar pelo painel antes do primeiro teste. Formato
-- canônico de lib/phone.ts (DDI 55 + DDD + 9 dígitos).
INSERT INTO gerente_settings (tenant_id, authorized_phones)
VALUES (1, '["5533991408604"]'::jsonb)
ON CONFLICT (tenant_id) DO NOTHING;
