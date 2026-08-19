-- Fixar mensagem no Chat Interno (estilo WhatsApp/Telegram) — uma mensagem
-- fixada por vez por conversa.
ALTER TABLE internal_conversations ADD COLUMN IF NOT EXISTS pinned_message_id integer;
ALTER TABLE internal_conversations ADD COLUMN IF NOT EXISTS pinned_at timestamp with time zone;
ALTER TABLE internal_conversations ADD COLUMN IF NOT EXISTS pinned_by integer;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'internal_conversations_pinned_message_id_fk'
  ) THEN
    ALTER TABLE internal_conversations
      ADD CONSTRAINT internal_conversations_pinned_message_id_fk
      FOREIGN KEY (pinned_message_id) REFERENCES internal_messages(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'internal_conversations_pinned_by_fk'
  ) THEN
    ALTER TABLE internal_conversations
      ADD CONSTRAINT internal_conversations_pinned_by_fk
      FOREIGN KEY (pinned_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;
