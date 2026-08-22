-- Rotinas e Produtividade (Fase 7): alerta automático pro gestor — checklist
-- obrigatório sem resposta no prazo, ou resposta negativa em pergunta
-- alertLevel="critico". Gerado por job periódico (routineAlerts.ts).

CREATE TABLE IF NOT EXISTS routine_alerts (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  recipient_user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_name text NOT NULL,
  checklist_id integer REFERENCES routine_checklists(id) ON DELETE CASCADE,
  checklist_name text NOT NULL,
  kind text NOT NULL,
  message text NOT NULL,
  dedupe_key text NOT NULL,
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS routine_alerts_dedupe_unique ON routine_alerts (dedupe_key);
CREATE INDEX IF NOT EXISTS routine_alerts_recipient_idx ON routine_alerts (recipient_user_id);
