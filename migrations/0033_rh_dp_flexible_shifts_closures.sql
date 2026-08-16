-- Escala livre (sem horário fixo) e fechamento mensal congelado do banco de horas.

ALTER TABLE work_shifts ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'fixed';
ALTER TABLE work_shifts ALTER COLUMN start_time DROP NOT NULL;
ALTER TABLE work_shifts ALTER COLUMN end_time DROP NOT NULL;
ALTER TABLE work_shifts ALTER COLUMN expected_minutes_per_day DROP NOT NULL;

CREATE TABLE IF NOT EXISTS time_bank_closures (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  employee_id integer NOT NULL,
  employee_name text NOT NULL,
  period_month text NOT NULL,
  worked_minutes integer NOT NULL,
  expected_minutes integer NOT NULL,
  adjustment_minutes integer NOT NULL,
  balance_minutes integer NOT NULL,
  closed_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS time_bank_closures_unique ON time_bank_closures (tenant_id, employee_id, period_month);
