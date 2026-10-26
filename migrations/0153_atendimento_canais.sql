-- Atendimento por canais (26/10/2026): separar a Central por linha de
-- WhatsApp/Instagram, abas "Responder agora" x "Aguardando cliente",
-- "Não precisa responder" e "Retomar depois". Idempotente (roda a cada boot).

-- Tipo da linha: varejo | atacado | interna. Interna (Compras, ADM,
-- fornecedores) fica fora do "Todos", do alarme de atraso e dos indicadores.
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS line_type text NOT NULL DEFAULT 'varejo';
-- Som e alarme de atraso desta linha (linha interna nasce desligada).
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS alerts_enabled boolean NOT NULL DEFAULT true;

-- Canal em que a Central abre para a pessoa (definido pelo admin) e o último
-- canal escolhido na barra (lembrado). Valores: 'todos' | 'instagram' | 'wa:<linha>'.
ALTER TABLE users ADD COLUMN IF NOT EXISTS default_channel text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_channel text;

-- "Não precisa responder": vale até a próxima mensagem do cliente
-- (comparado com last_message_at), com quem fez.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS reply_dismissed_at timestamptz;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS reply_dismissed_by integer REFERENCES users(id) ON DELETE SET NULL;
-- "Retomar depois": até snooze_until fica em "Aguardando cliente"; no horário
-- volta para "Responder agora" (se ninguém falou depois de snooze_set_at).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS snooze_until timestamptz;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS snooze_set_at timestamptz;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS snoozed_by integer REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS snooze_notified_at timestamptz;
CREATE INDEX IF NOT EXISTS conversations_snooze_due_idx ON conversations (snooze_until)
  WHERE snooze_until IS NOT NULL AND snooze_notified_at IS NULL;
CREATE INDEX IF NOT EXISTS conversations_tenant_session_idx ON conversations (tenant_id, session_key);
