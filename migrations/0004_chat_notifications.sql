-- Avisos persistentes do sino da Central de Atendimento (retorno vencido e
-- falha em envio agendado). Garante que o aviso não se perde se o vendedor
-- estiver offline na hora. Idempotente — seguro re-executar a cada boot.

CREATE TABLE IF NOT EXISTS chat_notifications (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  kind text NOT NULL,
  scheduled_id integer,
  conversation_id integer NOT NULL REFERENCES conversations(id),
  conv_name text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '',
  read boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now()
);

-- Busca do sino: não lidos de um usuário, mais recentes primeiro.
CREATE INDEX IF NOT EXISTS chat_notifications_user_unread_idx
  ON chat_notifications (tenant_id, user_id, created_at DESC)
  WHERE read = false;
