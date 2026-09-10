-- Pedido de férias com fluxo de solicitação (colaborador) + aprovação
-- (RH/admin) — pedido 10/09, análise Tangerino.

CREATE TABLE IF NOT EXISTS vacation_requests (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  employee_id integer NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  start_date date NOT NULL,
  end_date date NOT NULL,
  days_count integer NOT NULL,
  status text NOT NULL DEFAULT 'pendente',
  requested_by_user_id integer NOT NULL,
  reviewed_by_user_id integer,
  reviewed_at timestamptz,
  review_note text,
  leave_record_id integer REFERENCES leave_records(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vacation_requests_employee_idx ON vacation_requests(employee_id);
CREATE INDEX IF NOT EXISTS vacation_requests_tenant_status_idx ON vacation_requests(tenant_id, status);
