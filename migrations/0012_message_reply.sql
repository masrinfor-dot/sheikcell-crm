-- Responder mensagem (estilo WhatsApp) na Central de Atendimento — mesma
-- funcionalidade já existente no chat interno, aplicada às conversas com cliente.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id integer;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_reply_to_id_fk'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_reply_to_id_fk
      FOREIGN KEY (reply_to_id) REFERENCES messages(id) ON DELETE SET NULL;
  END IF;
END $$;
