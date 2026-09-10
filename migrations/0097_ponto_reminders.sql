-- Lembrete de ponto por WhatsApp (pedido 10/09, análise Tangerino): controle
-- de idempotência do job periódico (um lembrete por colaborador/dia/tipo).

CREATE TABLE IF NOT EXISTS ponto_reminders (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  employee_id integer NOT NULL,
  date_key text NOT NULL,
  kind text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ponto_reminders_unique ON ponto_reminders(employee_id, date_key, kind);
