-- Quadro de Tarefas vira Agenda unificada: tarefa passa a poder ser um
-- compromisso com horário marcado, vinculado a um cliente do CRM, com
-- duração e alerta prévio automático. Tarefa sem horário continua
-- funcionando normalmente (backlog).

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS contact_id integer REFERENCES crm_contacts(id);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS duration_minutes integer;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS alert_minutes_before integer;

CREATE TABLE IF NOT EXISTS task_reminders (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  task_id integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  recipient_user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  due_date timestamptz NOT NULL,
  dedupe_key text NOT NULL,
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS task_reminders_dedupe_unique ON task_reminders (dedupe_key);
CREATE INDEX IF NOT EXISTS task_reminders_recipient_idx ON task_reminders (recipient_user_id);
