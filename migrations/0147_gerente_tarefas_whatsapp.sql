-- Gerente IA: tarefa delegada vai pelo WhatsApp ao vendedor; ele confirma
-- com "feito" + foto (prova), que fecha a tarefa no quadro.
CREATE TABLE IF NOT EXISTS gerente_task_dispatches (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL,
  task_id integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id integer NOT NULL,
  assignee_name text NOT NULL,
  phone text,
  session_key text,
  status text NOT NULL DEFAULT 'enviada',
  sent_at timestamptz,
  awaiting_proof_at timestamptz,
  done_at timestamptz,
  proof_url text,
  proof_note text,
  overdue_notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gerente_task_dispatches_tenant_phone_idx ON gerente_task_dispatches(tenant_id, phone);
CREATE INDEX IF NOT EXISTS gerente_task_dispatches_task_idx ON gerente_task_dispatches(task_id);
