-- Chamados de suporte: loja abre/conversa, superadmin triagem/responde.
-- Estende a saas_tickets já existente (antes só o superadmin criava
-- manualmente, sem prioridade/categoria/histórico de mensagens).
ALTER TABLE saas_tickets ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal';
ALTER TABLE saas_tickets ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'duvida';
ALTER TABLE saas_tickets ADD COLUMN IF NOT EXISTS opened_by_user_id integer REFERENCES users(id);
ALTER TABLE saas_tickets ADD COLUMN IF NOT EXISTS store_name text;
-- Preenchido na 1ª resposta do superadmin/técnico — alimenta o indicador
-- de SLA na lista sem precisar buscar as mensagens de todo mundo.
ALTER TABLE saas_tickets ADD COLUMN IF NOT EXISTS first_responded_at timestamptz;

CREATE TABLE IF NOT EXISTS saas_ticket_messages (
  id serial PRIMARY KEY,
  ticket_id integer NOT NULL REFERENCES saas_tickets(id) ON DELETE CASCADE,
  -- tenant | superadmin
  author_type text NOT NULL,
  author_user_id integer REFERENCES users(id),
  author_name text NOT NULL,
  content text,
  media_url text,
  media_type text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saas_ticket_messages_ticket_idx ON saas_ticket_messages(ticket_id);
