-- Gerente IA: links seguros (sem login), rotinas recorrentes, fechamento do dia e relatório semanal.
ALTER TABLE gerente_settings ADD COLUMN IF NOT EXISTS public_base_url text;
ALTER TABLE gerente_settings ADD COLUMN IF NOT EXISTS evening_summary_time text DEFAULT '19:00';
ALTER TABLE gerente_settings ADD COLUMN IF NOT EXISTS evening_sent_on date;
ALTER TABLE gerente_settings ADD COLUMN IF NOT EXISTS weekly_report_sent_on date;

CREATE TABLE IF NOT EXISTS gerente_links (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL,
  token_hash text NOT NULL,
  scope text NOT NULL,
  ref_id integer,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gerente_links_token_uq ON gerente_links(token_hash);

CREATE TABLE IF NOT EXISTS gerente_recurrences (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL,
  kind text NOT NULL,
  title text NOT NULL,
  rule jsonb NOT NULL,
  assignee_name text,
  amount_cents integer,
  bill_kind text,
  active boolean NOT NULL DEFAULT true,
  next_at timestamptz NOT NULL,
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gerente_recurrences_next_idx ON gerente_recurrences(active, next_at);
