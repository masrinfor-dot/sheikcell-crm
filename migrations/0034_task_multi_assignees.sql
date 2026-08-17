-- Tarefas podem ter mais de um responsável: substitui tasks.assignee_id
-- (único) por uma tabela de junção task_assignees (N responsáveis).
CREATE TABLE IF NOT EXISTS task_assignees (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  task_id integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS task_assignees_task_user_idx ON task_assignees (task_id, user_id);
CREATE INDEX IF NOT EXISTS task_assignees_user_idx ON task_assignees (user_id);

-- Backfill + drop da coluna antiga só roda enquanto assignee_id ainda existir
-- (guard necessário porque as migrações são reaplicadas a cada boot).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'assignee_id'
  ) THEN
    INSERT INTO task_assignees (tenant_id, task_id, user_id)
    SELECT tenant_id, id, assignee_id FROM tasks WHERE assignee_id IS NOT NULL
    ON CONFLICT (task_id, user_id) DO NOTHING;

    ALTER TABLE tasks DROP COLUMN assignee_id;
  END IF;
END $$;
