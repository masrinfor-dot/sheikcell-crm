-- Espelho de ponto com assinatura eletrônica simples (clique de
-- confirmação) — pedido 10/09, análise Tangerino. Só é possível assinar um
-- mês depois de fechado (time_bank_closures já existe pra esse período).

CREATE TABLE IF NOT EXISTS timesheet_signatures (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  employee_id integer NOT NULL,
  period_month text NOT NULL,
  closure_id integer NOT NULL REFERENCES time_bank_closures(id),
  worked_minutes integer NOT NULL,
  expected_minutes integer NOT NULL,
  adjustment_minutes integer NOT NULL,
  balance_minutes integer NOT NULL,
  signed_by_user_id integer NOT NULL,
  signed_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS timesheet_signatures_unique ON timesheet_signatures(employee_id, period_month);
