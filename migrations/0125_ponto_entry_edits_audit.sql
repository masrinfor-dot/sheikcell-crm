CREATE TABLE IF NOT EXISTS time_clock_entry_edits (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  employee_id integer NOT NULL,
  entry_id integer,
  kind text NOT NULL,
  action text NOT NULL,
  previous_at timestamptz NOT NULL,
  new_at timestamptz,
  reason text NOT NULL,
  edited_by_user_id integer NOT NULL,
  edited_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS time_clock_entry_edits_tenant_employee_idx
  ON time_clock_entry_edits (tenant_id, employee_id);
