-- "Marcar mensagem" no Atendimento (estilo WhatsApp/Telegram): fixar uma
-- mensagem já enviada na conversa. Compartilhado — qualquer atendente fixa
-- ou desafixa e todo mundo que vê a conversa enxerga o destaque. Diferente
-- de conversation_pins (acima), que é por usuário e fixa a conversa
-- inteira na lista lateral, não uma mensagem específica.
CREATE TABLE IF NOT EXISTS message_pins (
  tenant_id integer NOT NULL DEFAULT 1,
  conversation_id integer NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id integer NOT NULL PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  pinned_by integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS message_pins_conversation_idx ON message_pins(conversation_id);
