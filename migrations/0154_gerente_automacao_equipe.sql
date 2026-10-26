ALTER TABLE gerente_settings ADD COLUMN IF NOT EXISTS team_digest_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE gerente_settings ADD COLUMN IF NOT EXISTS team_morning_time text NOT NULL DEFAULT '08:00';
ALTER TABLE gerente_settings ADD COLUMN IF NOT EXISTS team_evening_time text NOT NULL DEFAULT '18:00';
ALTER TABLE gerente_task_dispatches ADD COLUMN IF NOT EXISTS question_at timestamptz;
ALTER TABLE gerente_task_dispatches ADD COLUMN IF NOT EXISTS postpone_count integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS gerente_team_digests (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL,
  user_id integer NOT NULL,
  kind text NOT NULL,
  day date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gerente_team_digests_uniq ON gerente_team_digests(tenant_id, user_id, kind, day);
