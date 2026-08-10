-- Responder mensagem, mídia (foto/áudio/documento) e encaminhar no chat
-- interno (commit "Chat interno com resposta a mensagem...") só existiam no
-- schema do Drizzle (lib/db/src/schema/internal_chat.ts), sem migration SQL
-- explícita — dependiam inteiramente do `drizzle-kit push` rodar com sucesso
-- no deploy. Isso causava 500 em QUALQUER envio de mensagem no chat interno
-- sempre que essa etapa não aplicava a coluna: o INSERT da rota sempre inclui
-- reply_to_id (mesmo null, numa mensagem comum), então "coluna reply_to_id
-- não existe" derruba o envio pra qualquer conversa, não só uma específica.
-- Idempotente e roda no boot (migrate.ts), então corrige o ambiente que
-- estiver desalinhado independente do que aconteceu no deploy anterior.
ALTER TABLE internal_messages ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'text';
ALTER TABLE internal_messages ADD COLUMN IF NOT EXISTS media_url text;
ALTER TABLE internal_messages ADD COLUMN IF NOT EXISTS transcript text;
ALTER TABLE internal_messages ADD COLUMN IF NOT EXISTS forwarded boolean NOT NULL DEFAULT false;
ALTER TABLE internal_messages ADD COLUMN IF NOT EXISTS reply_to_id integer;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'internal_messages_reply_to_id_fk'
  ) THEN
    ALTER TABLE internal_messages
      ADD CONSTRAINT internal_messages_reply_to_id_fk
      FOREIGN KEY (reply_to_id) REFERENCES internal_messages(id) ON DELETE SET NULL;
  END IF;
END $$;
