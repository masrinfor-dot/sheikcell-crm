-- Módulo de RH — Departamento Pessoal: colaboradores, escalas, ponto,
-- banco de horas e afastamentos. Vizinho de rh_settings/rh_candidates
-- (recrutamento), tabelas separadas.

CREATE TABLE IF NOT EXISTS work_shifts (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  name text NOT NULL,
  start_time text NOT NULL,
  end_time text NOT NULL,
  break_start text,
  break_end text,
  weekdays jsonb NOT NULL DEFAULT '[1,2,3,4,5]',
  expected_minutes_per_day integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS employees (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  user_id integer REFERENCES users(id),
  name text NOT NULL,
  birth_date date,
  phone text,
  email text,
  cpf text,
  rg text,
  role text,
  job_function text,
  admission_date date,
  contract_type text,
  salary_cents integer,
  store_id integer REFERENCES stores(id),
  shift_id integer REFERENCES work_shifts(id),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS employees_user_id_unique ON employees (user_id) WHERE user_id IS NOT NULL;

-- Fato histórico: employee_id sem FK, sobrevive à exclusão do colaborador
-- (mesmo padrão de attendance_logs.sector_id/attendant_id).
CREATE TABLE IF NOT EXISTS time_clock_entries (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  employee_id integer NOT NULL,
  kind text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'self',
  created_by_user_id integer
);

CREATE INDEX IF NOT EXISTS time_clock_entries_employee_at_idx ON time_clock_entries (employee_id, at);

CREATE TABLE IF NOT EXISTS time_bank_adjustments (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  employee_id integer NOT NULL,
  minutes integer NOT NULL,
  reason text NOT NULL,
  created_by_user_id integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS time_bank_adjustments_employee_idx ON time_bank_adjustments (employee_id);

CREATE TABLE IF NOT EXISTS leave_records (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  employee_id integer NOT NULL,
  kind text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  notes text,
  created_by_user_id integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leave_records_employee_idx ON leave_records (employee_id);
