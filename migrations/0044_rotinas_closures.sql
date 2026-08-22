-- Rotinas e Produtividade (Fase 5): cruzamento com o Ponto (dado cru por
-- resposta, sem trava) + fechamento mensal congelado por funcionário, mesmo
-- padrão de time_bank_closures (rh_dp.ts).

ALTER TABLE routine_responses
  ADD COLUMN IF NOT EXISTS responded_relative_to_ponto text;

CREATE TABLE IF NOT EXISTS routine_closures (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  employee_id integer NOT NULL,
  employee_name text NOT NULL,
  period_month text NOT NULL,
  total_due integer NOT NULL,
  total_answered integer NOT NULL,
  total_on_time integer NOT NULL,
  total_with_pendency integer NOT NULL,
  total_urgent_bypass integer NOT NULL,
  ponto_before_entry integer NOT NULL,
  ponto_after_entry integer NOT NULL,
  ponto_no_record integer NOT NULL,
  closed_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS routine_closures_unique ON routine_closures (tenant_id, employee_id, period_month);
