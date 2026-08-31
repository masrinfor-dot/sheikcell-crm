ALTER TABLE trainings ADD COLUMN IF NOT EXISTS due_date timestamptz;
ALTER TABLE training_completions ADD COLUMN IF NOT EXISTS forced_by_admin_id integer REFERENCES users(id) ON DELETE SET NULL;
