-- Anexo (foto/documento) em comentários de tarefa + aviso de comentário novo
-- para quem está envolvido (responsável e criador, exceto quem comentou).
ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS media_url text;
ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS media_type text;

CREATE TABLE IF NOT EXISTS task_notifications (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  task_id integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  comment_id integer NOT NULL REFERENCES task_comments(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_notifications_user_unread_idx ON task_notifications (user_id, is_read);
